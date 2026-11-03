package app

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/bytrader/bytrader/internal/store"
)

func TestControlsImportCutoverBackupAndRestore(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	if err := Initialize(ctx, db, now); err != nil {
		t.Fatal(err)
	}
	if err := Initialize(ctx, db, now); err == nil {
		t.Fatal("reinitialization should preserve existing controls")
	}
	bundle := ControlsBundle{Schema: 1, Settings: store.Document{"execution": map[string]any{"mode": "live", "active_profile_doc_id": "frozen__v1"}, "trading": map[string]any{"kill_switch": false}}, Users: map[string]store.Document{"operator": {"role": "admin", "email": "operator@example.test"}}, Profiles: map[string]store.Document{"frozen__v1": {"schema_version": 1, "profile_id": "frozen", "version": 1}}}
	if err := ImportControls(ctx, db, bundle, now); err != nil {
		t.Fatal(err)
	}
	settings, err := db.Get(ctx, "settings", "default")
	if err != nil {
		t.Fatal(err)
	}
	if object(settings["execution"])["mode"] != "disabled" || object(settings["trading"])["kill_switch"] != true {
		t.Fatal("import enabled execution")
	}
	if err := db.Put(ctx, "trade_sets", "unresolved", store.Document{"schema": 2, "state": "SUBMIT_UNKNOWN", "profile_snapshot": nil}); err != nil {
		t.Fatal(err)
	}
	if err := SealCutover(ctx, db, now); err == nil {
		t.Fatal("cutover accepted an unresolved broker intent")
	}
	if err := db.WithTx(ctx, func(tx *store.Tx) error { return tx.Delete("trade_sets", "unresolved") }); err != nil {
		t.Fatal(err)
	}
	if err := SealCutover(ctx, db, now); err != nil {
		t.Fatal(err)
	}
	if err := SealCutover(ctx, db, now.Add(time.Hour)); err == nil {
		t.Fatal("replay barrier moved")
	}
	backup := filepath.Join(dir, "backup.sqlite")
	if err := db.Backup(ctx, backup); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(backup)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if err := restored.Health(ctx); err != nil {
		t.Fatal(err)
	}
	settings, err = restored.Get(ctx, "settings", "default")
	if err != nil {
		t.Fatal(err)
	}
	if object(settings["migration"])["replay_not_before"] != store.ISO(now) {
		t.Fatal("restore lost replay barrier")
	}
	if object(settings["execution"])["active_profile_doc_id"] != "frozen__v1" {
		t.Fatal("restore lost profile selection")
	}
	if _, err := restored.Get(ctx, "users", "operator"); err != nil {
		t.Fatal(err)
	}
	if err := ImportControls(ctx, restored, bundle, now); err == nil {
		t.Fatal("restore permitted controls overwrite")
	}
	if err := restored.WithTx(ctx, func(tx *store.Tx) error {
		settings, err := tx.Get("settings", "default")
		if err != nil {
			return err
		}
		execution := object(settings["execution"])
		execution["mode"] = "paper"
		settings["execution"] = execution
		trading := object(settings["trading"])
		trading["kill_switch"] = false
		settings["trading"] = trading
		return tx.Put("settings", "default", settings)
	}); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(dir, "recovered.sqlite")
	if err := Restore(ctx, backup, output); err != nil {
		t.Fatal(err)
	}
	if err := Restore(ctx, backup, output); err == nil {
		t.Fatal("restore overwrote existing database")
	}
	recovered, err := store.Open(output)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Close()
	settings, err = recovered.Get(ctx, "settings", "default")
	if err != nil {
		t.Fatal(err)
	}
	if object(settings["execution"])["mode"] != "disabled" || object(settings["trading"])["kill_switch"] != true {
		t.Fatal("restore published enabled controls")
	}
	if object(settings["migration"])["replay_not_before"] != store.ISO(now) {
		t.Fatal("safe restore lost replay barrier")
	}
}

func TestControlsImportIsAtomicOnExistingRole(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Initialize(ctx, db, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := db.Put(ctx, "users", "existing", store.Document{"role": "viewer"}); err != nil {
		t.Fatal(err)
	}
	err = ImportControls(ctx, db, ControlsBundle{Schema: 1, Settings: store.Document{}, Users: map[string]store.Document{"existing": {"role": "admin"}}, Profiles: map[string]store.Document{"new__v1": {"version": 1}}}, time.Now())
	if err == nil {
		t.Fatal("import overwrote role")
	}
	if _, err := db.Get(ctx, "execution_profiles", "new__v1"); err == nil {
		t.Fatal("failed import partially wrote a profile")
	}
	user, err := db.Get(ctx, "users", "existing")
	if err != nil {
		t.Fatal(err)
	}
	if user["role"] != "viewer" {
		t.Fatal("role changed on failed import")
	}
}

func TestSettledCheckIncludesIntentsOnTerminalRecords(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, record := range []struct {
		collection string
		doc        store.Document
	}{
		{"trade_sets", store.Document{"schema": 2, "state": "CLOSED", "mutation_intent": map[string]any{"action": "POSITION_MODIFY", "ticket": 1}}},
		{"trade_sets", store.Document{"schema": 2, "state": "CANCELLED", "revision_intent": map[string]any{"event_id": "unresolved"}}},
		{"admin_commands", store.Document{"status": "failed", "mutation_intents": map[string]any{"target": map[string]any{"status": "ambiguous"}}}},
	} {
		if err := db.Put(ctx, record.collection, "terminal", record.doc); err != nil {
			t.Fatal(err)
		}
		if err := CheckSettled(ctx, db); err == nil {
			t.Fatalf("settled check ignored %s intent", record.collection)
		}
		if err := db.WithTx(ctx, func(tx *store.Tx) error { return tx.Delete(record.collection, "terminal") }); err != nil {
			t.Fatal(err)
		}
	}
	if err := CheckSettled(ctx, db); err != nil {
		t.Fatal(err)
	}
}
