package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func openTestStore(t *testing.T) (*SQLiteStore, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "bytrader.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, path
}

func TestSnapshotListCursorUsesFixedISOAndIDTieBreak(t *testing.T) {
	s, _ := openTestStore(t)
	base := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	for _, row := range []struct {
		id string
		at time.Time
	}{
		{"a", base}, {"b", base}, {"c", base.Add(time.Millisecond)},
	} {
		if err := s.Put(context.Background(), "system_logs", row.id, Document{"created_at": ISO(row.at), "message": row.id}); err != nil {
			t.Fatal(err)
		}
	}
	first, err := s.List(context.Background(), "system_logs", ListOptions{Limit: 2, Descending: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 2 || stringField(first[0], "_id") != "c" || stringField(first[1], "_id") != "b" {
		t.Fatalf("unexpected first page: %#v", first)
	}
	cursor := &Cursor{Time: stringField(first[1], "created_at"), ID: stringField(first[1], "_id"), TimeField: CreatedAt, Descending: true}
	second, err := s.List(context.Background(), "system_logs", ListOptions{Limit: 2, Descending: true, After: cursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 1 || stringField(second[0], "_id") != "a" {
		t.Fatalf("cursor skipped/duplicated equal-time row: %#v", second)
	}
	if ISO(base) != "2026-10-24T12:00:00.000Z" || ISO(base.Add(time.Millisecond)) != "2026-10-24T12:00:00.001Z" {
		t.Fatal("ISO must retain fixed millisecond precision")
	}
	if err := s.Put(context.Background(), "system_logs", "reserved", Document{"_id": "collision"}); !errors.Is(err, ErrInvalidDocument) {
		t.Fatalf("reserved list metadata accepted in stored snapshot: %v", err)
	}
}

func TestRuntimeInfoReportsVerifiedSQLitePoolConfiguration(t *testing.T) {
	s, _ := openTestStore(t)
	info, err := s.RuntimeInfo(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if compareVersion(info.SQLiteVersion, minSQLiteVersion) < 0 || info.SchemaVersion != 2 || info.JournalMode != "wal" || (info.Synchronous != 2 && info.Synchronous != 3) || !info.ForeignKeys || info.BusyTimeoutMS <= 0 || info.VerifiedConnections != 4 {
		t.Fatalf("unexpected verified SQLite runtime: %+v", info)
	}
}

func TestDatabaseFileIsPrivateOnCreateAndBeforeReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private.db")
	oldMask := syscall.Umask(0)
	t.Cleanup(func() { syscall.Umask(oldMask) })

	first, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	assertPrivateDatabaseFile(t, path)
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}

	second, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	assertPrivateDatabaseFile(t, path)
}

func TestOpenRejectsHardLinkedDatabase(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bytrader.db")
	first, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(dir, "alias.db")
	if err := os.Link(path, alias); err != nil {
		t.Fatal(err)
	}

	for _, candidate := range []string{path, alias} {
		opened, err := Open(candidate)
		if err == nil {
			_ = opened.Close()
			t.Fatalf("opened database through hard-linked path %q", candidate)
		}
		if !strings.Contains(err.Error(), "hard links") {
			t.Fatalf("hard-linked path %q failed for the wrong reason: %v", candidate, err)
		}
	}
}

func TestSchemaV1BackfillUsesPreviousTimestampAndIDOrder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	legacy, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	created := ISO(now)
	// Insert in reverse ID order. True v1 ingress order was not stored, so the
	// one-time migration must use the prior deterministic (created_at,id) order.
	oldID, laterID := "-1001_77_a", "-1001_77_z"
	old := testSignalEvent("-1001", "77", "a", created, "dead_letter")
	later := testSignalEvent("-1001", "77", "z", created, "done")
	if err := legacy.WithTx(context.Background(), func(tx *Tx) error {
		if _, err := tx.Create(queueCollection, laterID, later); err != nil {
			return err
		}
		_, err := tx.Create(queueCollection, oldID, old)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var oldBody, laterBody string
	if err := legacy.db.QueryRow(`SELECT body FROM documents WHERE collection=? AND id=?`, queueCollection, oldID).Scan(&oldBody); err != nil {
		t.Fatal(err)
	}
	if err := legacy.db.QueryRow(`SELECT body FROM documents WHERE collection=? AND id=?`, queueCollection, laterID).Scan(&laterBody); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.db.Exec(`
DROP TRIGGER documents_signal_ingress_insert;
DROP INDEX documents_signal_ingress_order;
DROP INDEX documents_signal_ingress_unique;
DELETE FROM store_meta WHERE key='signal_ingress_sequence';
ALTER TABLE documents DROP COLUMN ingress_sequence;
UPDATE store_meta SET value='1' WHERE key='schema_version';`); err != nil {
		t.Fatalf("prepare schema v1 fixture: %v", err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	migrated, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer migrated.Close()
	var version string
	if err := migrated.db.QueryRow(`SELECT value FROM store_meta WHERE key='schema_version'`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != "2" {
		t.Fatalf("schema version = %q, want 2", version)
	}
	aSequence := testIngressSequence(t, migrated, "-1001_77_a")
	zSequence := testIngressSequence(t, migrated, "-1001_77_z")
	if aSequence >= zSequence {
		t.Fatalf("v1 backfill did not use previous tuple order: a=%d z=%d", aSequence, zSequence)
	}
	var gotOldBody, gotLaterBody string
	if err := migrated.db.QueryRow(`SELECT body FROM documents WHERE collection=? AND id=?`, queueCollection, oldID).Scan(&gotOldBody); err != nil {
		t.Fatal(err)
	}
	if err := migrated.db.QueryRow(`SELECT body FROM documents WHERE collection=? AND id=?`, queueCollection, laterID).Scan(&gotLaterBody); err != nil {
		t.Fatal(err)
	}
	if gotOldBody != oldBody || gotLaterBody != laterBody {
		t.Fatal("schema migration changed a stored JSON snapshot")
	}
	if got, err := migrated.Get(context.Background(), queueCollection, oldID); err != nil {
		t.Fatal(err)
	} else if _, persisted := got["_id"]; persisted {
		t.Fatal("listed ID metadata was written into the JSON snapshot")
	}
	listed, err := migrated.List(context.Background(), queueCollection, ListOptions{Limit: 10})
	if err != nil || len(listed) != 2 || stringField(listed[0], "_id") != oldID || stringField(listed[1], "_id") != laterID {
		t.Fatalf("document IDs/order changed during migration: %#v err=%v", listed, err)
	}
	backup := filepath.Join(filepath.Dir(path), "upgraded-backup.db")
	if err := migrated.Backup(context.Background(), backup); err != nil {
		t.Fatal(err)
	}
	copy, err := Open(backup)
	if err != nil {
		t.Fatal(err)
	}
	defer copy.Close()
	if oldSequence, laterSequence := testIngressSequence(t, copy, oldID), testIngressSequence(t, copy, laterID); oldSequence >= laterSequence {
		t.Fatalf("upgraded backup lost migration order: old=%d later=%d", oldSequence, laterSequence)
	}
	result, err := copy.RequeueDeadLetter(context.Background(), oldID, "operator", now.Add(time.Second))
	if err != nil || result.Requeued || result.Reason != "superseded" {
		t.Fatalf("upgraded backup lost replay barrier: result=%+v err=%v", result, err)
	}
	newID := "-1001_77_new"
	newEvent := testSignalEvent("-1001", "77", "new", created, "pending")
	if inserted, err := copy.PublishSignalEvent(context.Background(), newID, newEvent); err != nil || !inserted {
		t.Fatalf("publish after backup restore: inserted=%v err=%v", inserted, err)
	}
	if got := testIngressSequence(t, copy, newID); got != 3 {
		t.Fatalf("restored ingress allocator did not continue: got %d want 3", got)
	}
	if err := migrated.Health(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func assertPrivateDatabaseFile(t *testing.T, path string) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("database mode = %04o, want 0600", got)
	}
}

func TestCreateRollbackAndCommitFailureAreReturned(t *testing.T) {
	s, _ := openTestStore(t)
	ctx := context.Background()
	var created bool
	if err := s.WithTx(ctx, func(tx *Tx) error {
		var err error
		created, err = tx.Create("settings", "default", Document{"execution": map[string]any{"mode": "disabled"}})
		return err
	}); err != nil || !created {
		t.Fatalf("create: created=%v err=%v", created, err)
	}
	if err := s.WithTx(ctx, func(tx *Tx) error {
		var err error
		created, err = tx.Create("settings", "default", Document{"execution": map[string]any{"mode": "live"}})
		return err
	}); err != nil || created {
		t.Fatalf("duplicate create: created=%v err=%v", created, err)
	}
	stored, err := s.Get(ctx, "settings", "default")
	if err != nil || object(stored["execution"])["mode"] != "disabled" {
		t.Fatalf("idempotent create overwrote: %#v %v", stored, err)
	}

	marker := errors.New("abort transaction")
	if err := s.WithTx(ctx, func(tx *Tx) error {
		if err := tx.Put("settings", "rolled-back", Document{"ok": true}); err != nil {
			return err
		}
		return marker
	}); !errors.Is(err, marker) {
		t.Fatalf("rollback error = %v", err)
	}
	if _, err := s.Get(ctx, "settings", "rolled-back"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rolled-back document found: %v", err)
	}

	if _, err := s.db.Exec(`CREATE TABLE commit_parent(id INTEGER PRIMARY KEY); CREATE TABLE commit_child(parent_id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`); err != nil {
		t.Fatal(err)
	}
	brokerMutation := false
	err = s.WithTx(ctx, func(tx *Tx) error {
		_, err := tx.tx.ExecContext(tx.ctx, `INSERT INTO commit_child(parent_id) VALUES(42)`)
		return err
	})
	if err == nil {
		brokerMutation = true
	}
	if err == nil || brokerMutation {
		t.Fatalf("deferred commit failure was not returned before downstream mutation: %v", err)
	}
	var childCount int
	if err := s.db.QueryRow(`SELECT count(*) FROM commit_child`).Scan(&childCount); err != nil || childCount != 0 {
		t.Fatalf("failed transaction persisted child: count=%d err=%v", childCount, err)
	}
}

func TestSQLiteFullReturnsErrorAndStoreRecovers(t *testing.T) {
	s, _ := openTestStore(t)
	s.db.SetMaxOpenConns(1)
	var pages int
	if err := s.db.QueryRow(`PRAGMA page_count`).Scan(&pages); err != nil {
		t.Fatal(err)
	}
	var maxPages int
	if err := s.db.QueryRow(fmt.Sprintf(`PRAGMA max_page_count = %d`, pages)).Scan(&maxPages); err != nil {
		t.Fatal(err)
	}
	if maxPages < pages {
		t.Fatalf("SQLite max_page_count %d below existing page count %d", maxPages, pages)
	}
	err := s.Put(context.Background(), "system_logs", "too-large", Document{"created_at": ISO(time.Now()), "payload": strings.Repeat("x", 128*1024)})
	if err == nil {
		t.Fatal("expected SQLite FULL when write exceeds max_page_count")
	}
	if _, err := s.Get(context.Background(), "system_logs", "too-large"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("partial disk-full write visible: %v", err)
	}
	if err := s.db.QueryRow(fmt.Sprintf(`PRAGMA max_page_count = %d`, pages+128)).Scan(&maxPages); err != nil {
		t.Fatal(err)
	}
	if err := s.Put(context.Background(), "system_logs", "recovered", Document{"created_at": ISO(time.Now()), "message": "store recovers after FULL"}); err != nil {
		t.Fatalf("write after raising SQLite page limit: %v", err)
	}
}

func TestTwoStoreHandlesSerializeWritersAndRecover(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shared.db")
	first, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	started, release := make(chan struct{}), make(chan struct{})
	firstErr := make(chan error, 1)
	go func() {
		firstErr <- first.WithTx(context.Background(), func(tx *Tx) error {
			if err := tx.Put("settings", "held", Document{"created_at": ISO(time.Now())}); err != nil {
				return err
			}
			close(started)
			<-release
			return nil
		})
	}()
	<-started
	secondErr := make(chan error, 1)
	go func() {
		secondErr <- second.Put(context.Background(), "settings", "waiter", Document{"created_at": ISO(time.Now())})
	}()
	time.Sleep(100 * time.Millisecond)
	select {
	case err := <-secondErr:
		t.Fatalf("second writer skipped the held SQLite writer lock: %v", err)
	default:
	}
	close(release)
	if err := <-firstErr; err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-secondErr:
		if err != nil {
			t.Fatalf("contending writer did not recover: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("contending writer exceeded bounded busy timeout")
	}
	if _, err := second.Get(context.Background(), "settings", "waiter"); err != nil {
		t.Fatal(err)
	}
}

func TestOnlineBackupRestoresStateAndReplayBarrier(t *testing.T) {
	s, _ := openTestStore(t)
	ctx := context.Background()
	created := ISO(time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC))
	oldID, laterID := "-1001_77_fff", "-1001_77_000"
	old := testSignalEvent("-1001", "77", "fff", created, "dead_letter")
	later := testSignalEvent("-1001", "77", "000", created, "done")
	if _, err := s.db.Exec(`PRAGMA foreign_keys=ON`); err != nil {
		t.Fatal(err)
	}
	if err := s.WithTx(ctx, func(tx *Tx) error {
		if _, err := tx.Create(queueCollection, oldID, old); err != nil {
			return err
		}
		_, err := tx.Create(queueCollection, laterID, later)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	backupPath := filepath.Join(t.TempDir(), "backup.db")
	if err := s.Backup(ctx, backupPath); err != nil {
		t.Fatal(err)
	}
	copy, err := Open(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	defer copy.Close()
	if err := copy.Health(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := copy.Get(ctx, queueCollection, oldID); err != nil {
		t.Fatal(err)
	}
	if oldSequence, laterSequence := testIngressSequence(t, copy, oldID), testIngressSequence(t, copy, laterID); oldSequence >= laterSequence {
		t.Fatalf("backup lost ingress order: old=%d later=%d", oldSequence, laterSequence)
	}
	result, err := copy.RequeueDeadLetter(ctx, oldID, "operator", time.Now())
	if err != nil || result.Requeued || result.Reason != "superseded" {
		t.Fatalf("restored replay barrier: result=%+v err=%v", result, err)
	}
}

func TestBackupRefusesToReplaceExistingDestination(t *testing.T) {
	s, _ := openTestStore(t)
	destination := filepath.Join(t.TempDir(), "backup.db")
	marker := []byte("preserve existing file")
	if err := os.WriteFile(destination, marker, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.Backup(context.Background(), destination); err == nil {
		t.Fatal("backup replaced an existing destination")
	}
	got, err := os.ReadFile(destination)
	if err != nil || string(got) != string(marker) {
		t.Fatalf("existing backup changed: %q err=%v", got, err)
	}
}

func TestCrashRecoveryAfterCommitBeforeNotification(t *testing.T) {
	if os.Getenv("BYTRADER_STORE_CRASH_CHILD") == "1" {
		path := os.Getenv("BYTRADER_STORE_CRASH_PATH")
		s, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		_, err = s.PublishSignalEvent(context.Background(), "-1001_88_hash", testSignalEvent("-1001", "88", "hash", ISO(time.Now()), "pending"))
		if err != nil {
			t.Fatal(err)
		}
		_ = s.WithTx(context.Background(), func(tx *Tx) error {
			if err := tx.Put("settings", "default", Document{"marker": "uncommitted"}); err != nil {
				t.Fatal(err)
			}
			if _, err := tx.Create("settings", "partial", Document{"marker": true}); err != nil {
				t.Fatal(err)
			}
			os.Exit(0)
			return nil
		})
		t.Fatal("child transaction unexpectedly returned")
	}

	path := filepath.Join(t.TempDir(), "crash.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Put(context.Background(), "settings", "default", Document{"marker": "committed"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestCrashRecoveryAfterCommitBeforeNotification$")
	cmd.Env = append(os.Environ(), "BYTRADER_STORE_CRASH_CHILD=1", "BYTRADER_STORE_CRASH_PATH="+path)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("crash child: %v\n%s", err, output)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if err := reopened.Health(context.Background()); err != nil {
		t.Fatal(err)
	}
	stable, err := reopened.Get(context.Background(), "settings", "default")
	if err != nil || stringField(stable, "marker") != "committed" {
		t.Fatalf("uncommitted state survived crash: %#v %v", stable, err)
	}
	if _, err := reopened.Get(context.Background(), "settings", "partial"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("partial document survived crash: %v", err)
	}
	claimed, err := reopened.ClaimSignalEvents(context.Background(), ClaimOptions{Owner: "restarted-forwarder", Now: time.Now(), Lease: time.Minute})
	if err != nil || len(claimed) != 1 || claimed[0].ID != "-1001_88_hash" {
		t.Fatalf("committed but unnotified event was not recovered: %#v %v", claimed, err)
	}
}

func testSignalEvent(chatID, messageID, hash, createdAt, status string) Document {
	return Document{
		"chat_id": chatID, "message_id": messageID, "text_hash": hash,
		"message_type": "new", "kind": "signal", "signal": map[string]any{"symbol": "XAUUSD"}, "created_at": createdAt,
		"autotrader": map[string]any{
			"status": status, "attempts": 1, "next_attempt_at": nil, "lease_id": nil,
			"lease_owner": nil, "lease_expires_at": nil, "updated_at": createdAt,
		},
	}
}
