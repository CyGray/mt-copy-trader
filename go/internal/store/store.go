package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	sqlite "modernc.org/sqlite"
)

const (
	busyTimeout        = 2500 * time.Millisecond
	transactionTimeout = 5 * time.Second
	defaultListLimit   = 200
	maxListLimit       = 5000
	minSQLiteVersion   = "3.51.3"
)

var (
	ErrNotFound          = errors.New("document not found")
	ErrInvalidCollection = errors.New("unknown collection")
	ErrInvalidDocument   = errors.New("invalid document")
)

type Document map[string]any

type Store interface {
	Get(ctx context.Context, collection, id string) (Document, error)
	Put(ctx context.Context, collection, id string, doc Document) error
	List(ctx context.Context, collection string, opts ListOptions) ([]Document, error)
	WithTx(ctx context.Context, fn func(*Tx) error) error
	Close() error
	Health(ctx context.Context) error
	Backup(ctx context.Context, destination string) error
}

type SQLiteStore struct {
	db   *sql.DB
	path string
}

type RuntimeInfo struct {
	SQLiteVersion       string `json:"sqlite_version"`
	SchemaVersion       int    `json:"schema_version"`
	JournalMode         string `json:"journal_mode"`
	Synchronous         int    `json:"synchronous"`
	ForeignKeys         bool   `json:"foreign_keys"`
	BusyTimeoutMS       int    `json:"busy_timeout_ms"`
	VerifiedConnections int    `json:"verified_connections"`
}

type Tx struct {
	ctx context.Context
	tx  *sql.Tx
}

type IndexField string

const (
	StatusField      IndexField = "status"
	StateField       IndexField = "state"
	QueueStatusField IndexField = "queue_status"
	RoleField        IndexField = "role"
	TypeField        IndexField = "type"
	SeverityField    IndexField = "severity"
	ChatIDField      IndexField = "chat_id"
	MessageIDField   IndexField = "message_id"
	TradeSetIDField  IndexField = "trade_set_id"
	UserIDField      IndexField = "user_id"
)

type Filter struct {
	Field  IndexField
	Values []string
}

type Cursor struct {
	Time       string
	ID         string
	TimeField  TimeField
	Descending bool
}

type TimeField string

const (
	CreatedAt  TimeField = "created_at"
	Timestamp  TimeField = "timestamp"
	At         TimeField = "at"
	UpdatedAt  TimeField = "updated_at"
	LastSeenAt TimeField = "last_seen_at"
)

type ListOptions struct {
	Filters    []Filter
	Schema     *int
	After      *Cursor
	Before     *Cursor
	TimeField  TimeField
	Descending bool
	Limit      int
}

var collections = map[string]struct{}{
	"settings": {}, "execution_profiles": {}, "execution_profile_audit": {}, "users": {},
	"admin_audit": {}, "admin_commands": {}, "alerts": {}, "trade_sets": {},
	"trade_events": {}, "signal_events": {}, "system_logs": {}, "telegram_messages": {},
	"telegram_updates_debug": {}, "signal_forwards": {}, "telegram_commands": {},
	"telegram_session": {}, "telegram_state": {}, "telegram_update_state": {},
	"telegram_channel_pts": {}, "telegram_channel_hashes": {}, "telegram_user_hashes": {},
	"service_status": {}, "paper_broker": {},
}

var filterColumns = map[IndexField]string{
	StatusField: "status", StateField: "state", QueueStatusField: "queue_status",
	RoleField: "role", TypeField: "type", SeverityField: "severity", ChatIDField: "chat_id",
	MessageIDField: "message_id", TradeSetIDField: "trade_set_id", UserIDField: "user_id",
}

var timeColumns = map[TimeField]string{
	CreatedAt: "created_at", Timestamp: "timestamp", At: "at", UpdatedAt: "updated_at",
	LastSeenAt: "last_seen_at",
}

var _ Store = (*SQLiteStore)(nil)

func Open(path string) (*SQLiteStore, error) {
	if strings.TrimSpace(path) == "" || path == ":memory:" || strings.HasPrefix(path, "file:") {
		return nil, fmt.Errorf("SQLite path must be a local filesystem path")
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve SQLite path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(absPath), 0o700); err != nil {
		return nil, fmt.Errorf("create SQLite directory: %w", err)
	}
	if err := prepareDatabaseFile(absPath); err != nil {
		return nil, fmt.Errorf("prepare SQLite file permissions: %w", err)
	}

	query := url.Values{
		"_busy_timeout": {strconv.Itoa(int(busyTimeout / time.Millisecond))},
		"_foreign_keys": {"true"},
		"_journal_mode": {"WAL"},
		"_synchronous":  {"FULL"},
		"_txlock":       {"immediate"},
	}
	dsn := (&url.URL{Scheme: "file", Path: absPath, RawQuery: query.Encode()}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open SQLite: %w", err)
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(0)

	store := &SQLiteStore{db: db, path: absPath}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := store.verifyRuntime(ctx); err != nil {
		db.Close()
		return nil, err
	}
	if err := store.migrate(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize SQLite schema: %w", err)
	}
	info, err := store.RuntimeInfo(ctx)
	if err != nil {
		db.Close()
		return nil, err
	}
	if info.SchemaVersion != 2 {
		db.Close()
		return nil, fmt.Errorf("SQLite schema version is %d, want 2", info.SchemaVersion)
	}
	return store, nil
}

func prepareDatabaseFile(path string) error {
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		info, statErr := file.Stat()
		if statErr != nil {
			_ = file.Close()
			return statErr
		}
		if err := requireSingleLink(info); err != nil {
			_ = file.Close()
			return err
		}
		if chmodErr := file.Chmod(0o600); chmodErr != nil {
			_ = file.Close()
			return chmodErr
		}
		if closeErr := file.Close(); closeErr != nil {
			return closeErr
		}
		return nil
	}
	if !errors.Is(err, os.ErrExist) {
		return err
	}

	before, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() {
		return fmt.Errorf("SQLite path must be a regular file, got %s", before.Mode().Type())
	}
	file, err = os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil {
		return err
	}
	if !os.SameFile(before, after) {
		return errors.New("SQLite path changed while opening")
	}
	if err := requireSingleLink(after); err != nil {
		return err
	}
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	return nil
}

func requireSingleLink(info os.FileInfo) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("could not verify SQLite file link count")
	}
	if stat.Nlink != 1 {
		return fmt.Errorf("SQLite database file has %d hard links; exactly one is required", stat.Nlink)
	}
	return nil
}

func (s *SQLiteStore) verifyRuntime(ctx context.Context) error {
	_, err := s.RuntimeInfo(ctx)
	return err
}

func (s *SQLiteStore) RuntimeInfo(ctx context.Context) (RuntimeInfo, error) {
	connections := make([]*sql.Conn, 0, 4)
	defer func() {
		for _, conn := range connections {
			_ = conn.Close()
		}
	}()
	for i := 0; i < cap(connections); i++ {
		conn, err := s.db.Conn(ctx)
		if err != nil {
			return RuntimeInfo{}, fmt.Errorf("open SQLite connection %d: %w", i+1, err)
		}
		connections = append(connections, conn)
	}
	var info RuntimeInfo
	for i, conn := range connections {
		var version, mode string
		var schemaVersion, syncMode, foreignKeys, busyMs int
		for _, check := range []struct {
			name, query string
			dest        any
		}{
			{"runtime version", "SELECT sqlite_version()", &version},
			{"schema version", "PRAGMA user_version", &schemaVersion},
			{"journal mode", "PRAGMA journal_mode", &mode},
			{"synchronous mode", "PRAGMA synchronous", &syncMode},
			{"foreign keys", "PRAGMA foreign_keys", &foreignKeys},
			{"busy timeout", "PRAGMA busy_timeout", &busyMs},
		} {
			if err := conn.QueryRowContext(ctx, check.query).Scan(check.dest); err != nil {
				return RuntimeInfo{}, fmt.Errorf("read SQLite %s on connection %d: %w", check.name, i+1, err)
			}
		}
		if compareVersion(version, minSQLiteVersion) < 0 {
			return RuntimeInfo{}, fmt.Errorf("SQLite %s is too old; need %s or later", version, minSQLiteVersion)
		}
		if !strings.EqualFold(mode, "wal") {
			return RuntimeInfo{}, fmt.Errorf("SQLite journal mode on connection %d is %q, want WAL", i+1, mode)
		}
		if syncMode != 2 && syncMode != 3 {
			return RuntimeInfo{}, fmt.Errorf("SQLite synchronous mode on connection %d is %d, want FULL or EXTRA", i+1, syncMode)
		}
		if foreignKeys != 1 {
			return RuntimeInfo{}, fmt.Errorf("SQLite foreign_keys on connection %d is %d, want ON", i+1, foreignKeys)
		}
		if busyMs <= 0 || time.Duration(busyMs)*time.Millisecond > busyTimeout {
			return RuntimeInfo{}, fmt.Errorf("SQLite busy timeout on connection %d is %d ms, want 1..%d ms", i+1, busyMs, busyTimeout/time.Millisecond)
		}
		connectionInfo := RuntimeInfo{SQLiteVersion: version, SchemaVersion: schemaVersion, JournalMode: strings.ToLower(mode), Synchronous: syncMode, ForeignKeys: true, BusyTimeoutMS: busyMs}
		if i == 0 {
			info = connectionInfo
		} else if connectionInfo != info {
			return RuntimeInfo{}, fmt.Errorf("SQLite connection %d settings differ from pool: %+v vs %+v", i+1, connectionInfo, info)
		}
	}
	info.VerifiedConnections = len(connections)
	return info, nil
}

// ISO returns the TypeScript-compatible UTC timestamp used for persisted state.
func ISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func compareVersion(got, want string) int {
	parse := func(v string) []int {
		parts := strings.Split(v, ".")
		out := make([]int, 3)
		for i := 0; i < len(out) && i < len(parts); i++ {
			out[i], _ = strconv.Atoi(parts[i])
		}
		return out
	}
	a, b := parse(got), parse(want)
	for i := range a {
		if a[i] < b[i] {
			return -1
		}
		if a[i] > b[i] {
			return 1
		}
	}
	return 0
}

func (s *SQLiteStore) migrate(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS documents (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (json_valid(body)),
  schema_num INTEGER,
  created_at TEXT,
  timestamp TEXT,
  at TEXT,
  updated_at TEXT,
  last_seen_at TEXT,
  status TEXT,
  state TEXT,
  queue_status TEXT,
  queue_next_attempt_at TEXT,
  queue_lease_expires_at TEXT,
  role TEXT,
  type TEXT,
  severity TEXT,
  chat_id TEXT,
  message_id TEXT,
  trade_set_id TEXT,
  user_id TEXT,
  ingress_sequence INTEGER,
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS documents_created_order ON documents(collection, created_at, id);
CREATE INDEX IF NOT EXISTS documents_timestamp_order ON documents(collection, timestamp, id);
CREATE INDEX IF NOT EXISTS documents_at_order ON documents(collection, at, id);
CREATE INDEX IF NOT EXISTS documents_updated_order ON documents(collection, updated_at, id);
CREATE INDEX IF NOT EXISTS documents_last_seen_order ON documents(collection, last_seen_at, id);
CREATE INDEX IF NOT EXISTS documents_status_order ON documents(collection, status, created_at, id);
CREATE INDEX IF NOT EXISTS documents_state_order ON documents(collection, state, created_at, id);
CREATE INDEX IF NOT EXISTS documents_queue_due ON documents(collection, queue_status, queue_next_attempt_at, created_at, id);
CREATE INDEX IF NOT EXISTS documents_queue_lease ON documents(collection, queue_status, queue_lease_expires_at, created_at, id);
CREATE INDEX IF NOT EXISTS documents_chat_message_order ON documents(collection, chat_id, message_id, created_at, id);
CREATE INDEX IF NOT EXISTS documents_user_order ON documents(collection, user_id, created_at, id);
CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO store_meta(key, value) VALUES('schema_version', '1')
  ON CONFLICT(key) DO NOTHING;
`
	return s.WithTx(ctx, func(tx *Tx) error {
		if _, err := tx.tx.ExecContext(tx.ctx, schema); err != nil {
			return err
		}
		var version string
		if err := tx.tx.QueryRowContext(tx.ctx, `SELECT value FROM store_meta WHERE key='schema_version'`).Scan(&version); err != nil {
			return err
		}
		if version != "1" && version != "2" {
			return fmt.Errorf("unsupported SQLite schema version %q", version)
		}
		hasSequence, err := tx.hasColumn("documents", "ingress_sequence")
		if err != nil {
			return err
		}
		if !hasSequence {
			if version != "1" {
				return errors.New("SQLite schema v2 is missing documents.ingress_sequence")
			}
			if _, err := tx.tx.ExecContext(tx.ctx, `ALTER TABLE documents ADD COLUMN ingress_sequence INTEGER`); err != nil {
				return err
			}
		}
		if version == "1" {
			// The old schema did not preserve insertion order. Backfill deterministically
			// by the previous queue order so upgrading never invents a partial order.
			if _, err := tx.tx.ExecContext(tx.ctx, `
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY COALESCE(created_at, ''), id) AS sequence
  FROM documents
  WHERE collection='signal_events'
)
UPDATE documents
SET ingress_sequence = (SELECT sequence FROM ordered WHERE ordered.id=documents.id)
WHERE collection='signal_events' AND ingress_sequence IS NULL`); err != nil {
				return err
			}
		}
		if _, err := tx.tx.ExecContext(tx.ctx, `
INSERT INTO store_meta(key, value)
SELECT 'signal_ingress_sequence', CAST(COALESCE(MAX(ingress_sequence), 0) AS TEXT)
FROM documents WHERE collection='signal_events'
ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(store_meta.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`); err != nil {
			return err
		}
		if _, err := tx.tx.ExecContext(tx.ctx, `
CREATE INDEX IF NOT EXISTS documents_signal_ingress_order
  ON documents(collection, chat_id, message_id, ingress_sequence, queue_status);
CREATE UNIQUE INDEX IF NOT EXISTS documents_signal_ingress_unique
  ON documents(ingress_sequence) WHERE collection='signal_events';
CREATE TRIGGER IF NOT EXISTS documents_signal_ingress_insert
AFTER INSERT ON documents
WHEN NEW.collection='signal_events' AND NEW.ingress_sequence IS NULL
BEGIN
  UPDATE store_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='signal_ingress_sequence';
  UPDATE documents
  SET ingress_sequence=CAST((SELECT value FROM store_meta WHERE key='signal_ingress_sequence') AS INTEGER)
  WHERE collection=NEW.collection AND id=NEW.id;
END;`); err != nil {
			return err
		}
		var unsequenced int
		if err := tx.tx.QueryRowContext(tx.ctx, `SELECT COUNT(*) FROM documents WHERE collection='signal_events' AND ingress_sequence IS NULL`).Scan(&unsequenced); err != nil {
			return err
		}
		if unsequenced != 0 {
			return fmt.Errorf("SQLite schema has %d unsequenced signal events", unsequenced)
		}
		if version == "1" {
			if _, err := tx.tx.ExecContext(tx.ctx, `UPDATE store_meta SET value='2' WHERE key='schema_version'`); err != nil {
				return err
			}
		}
		if _, err := tx.tx.ExecContext(tx.ctx, `PRAGMA user_version=2`); err != nil {
			return err
		}
		return nil
	})
}

func (tx *Tx) hasColumn(table, column string) (bool, error) {
	if table != "documents" {
		return false, errors.New("unsupported SQLite table introspection")
	}
	rows, err := tx.tx.QueryContext(tx.ctx, `PRAGMA table_info(documents)`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, dataType string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &dataType, &notNull, &defaultValue, &primaryKey); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

func (s *SQLiteStore) Close() error { return s.db.Close() }

func (s *SQLiteStore) Health(ctx context.Context) error {
	var result string
	if err := s.db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&result); err != nil {
		return fmt.Errorf("SQLite quick_check: %w", err)
	}
	if result != "ok" {
		return fmt.Errorf("SQLite quick_check: %s", result)
	}
	return s.verifyRuntime(ctx)
}

func (s *SQLiteStore) Get(ctx context.Context, collection, id string) (Document, error) {
	if err := validateCollection(collection); err != nil {
		return nil, err
	}
	var body string
	err := s.db.QueryRowContext(ctx, `SELECT body FROM documents WHERE collection=? AND id=?`, collection, id).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return decodeDocument(body)
}

func (s *SQLiteStore) Put(ctx context.Context, collection, id string, doc Document) error {
	return s.WithTx(ctx, func(tx *Tx) error { return tx.Put(collection, id, doc) })
}

func (s *SQLiteStore) List(ctx context.Context, collection string, opts ListOptions) ([]Document, error) {
	if err := validateCollection(collection); err != nil {
		return nil, err
	}
	return listDocuments(ctx, s.db, collection, opts)
}

func (s *SQLiteStore) WithTx(ctx context.Context, fn func(*Tx) error) error {
	if fn == nil {
		return errors.New("transaction callback is nil")
	}
	txCtx, cancel := context.WithTimeout(ctx, transactionTimeout)
	defer cancel()
	sqlTx, err := s.db.BeginTx(txCtx, nil) // DSN uses BEGIN IMMEDIATE and a bounded busy timeout.
	if err != nil {
		return fmt.Errorf("begin SQLite transaction: %w", err)
	}
	tx := &Tx{ctx: txCtx, tx: sqlTx}
	if err := fn(tx); err != nil {
		_ = sqlTx.Rollback()
		return err
	}
	if err := sqlTx.Commit(); err != nil {
		_ = sqlTx.Rollback()
		return fmt.Errorf("commit SQLite transaction: %w", err)
	}
	return nil
}

func (tx *Tx) Get(collection, id string) (Document, error) {
	if err := validateCollection(collection); err != nil {
		return nil, err
	}
	var body string
	err := tx.tx.QueryRowContext(tx.ctx, `SELECT body FROM documents WHERE collection=? AND id=?`, collection, id).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return decodeDocument(body)
}

func (tx *Tx) Put(collection, id string, doc Document) error {
	_, err := writeDocument(tx.ctx, tx.tx, collection, id, doc, false)
	return err
}

func (tx *Tx) Create(collection, id string, doc Document) (bool, error) {
	return writeDocument(tx.ctx, tx.tx, collection, id, doc, true)
}

func (tx *Tx) Delete(collection, id string) error {
	if err := validateCollection(collection); err != nil {
		return err
	}
	_, err := tx.tx.ExecContext(tx.ctx, `DELETE FROM documents WHERE collection=? AND id=?`, collection, id)
	return err
}

func (tx *Tx) List(collection string, opts ListOptions) ([]Document, error) {
	if err := validateCollection(collection); err != nil {
		return nil, err
	}
	return listDocuments(tx.ctx, tx.tx, collection, opts)
}

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func validateCollection(collection string) error {
	if _, ok := collections[collection]; !ok {
		return fmt.Errorf("%w: %s", ErrInvalidCollection, collection)
	}
	return nil
}

func writeDocument(ctx context.Context, q interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, collection, id string, doc Document, create bool) (bool, error) {
	if err := validateCollection(collection); err != nil {
		return false, err
	}
	if id == "" {
		return false, fmt.Errorf("%w: document ID is empty", ErrInvalidDocument)
	}
	if doc == nil {
		return false, fmt.Errorf("%w: snapshot is nil", ErrInvalidDocument)
	}
	if _, exists := doc["_id"]; exists {
		return false, fmt.Errorf("%w: _id is reserved list metadata", ErrInvalidDocument)
	}
	body, err := json.Marshal(doc)
	if err != nil {
		return false, fmt.Errorf("encode %s/%s: %w", collection, id, err)
	}
	columns := derivedColumns(collection, doc)
	verb := `INSERT INTO documents(collection,id,body,schema_num,created_at,timestamp,at,updated_at,last_seen_at,status,state,queue_status,queue_next_attempt_at,queue_lease_expires_at,role,type,severity,chat_id,message_id,trade_set_id,user_id,ingress_sequence)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`
	args := append([]any{collection, id, string(body)}, columns...)
	if create {
		result, err := q.ExecContext(ctx, verb+` ON CONFLICT(collection,id) DO NOTHING`, args...)
		if err != nil {
			return false, err
		}
		n, err := result.RowsAffected()
		return n == 1, err
	}
	_, err = q.ExecContext(ctx, verb+` ON CONFLICT(collection,id) DO UPDATE SET
	body=excluded.body,schema_num=excluded.schema_num,created_at=excluded.created_at,timestamp=excluded.timestamp,at=excluded.at,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,status=excluded.status,state=excluded.state,queue_status=excluded.queue_status,queue_next_attempt_at=excluded.queue_next_attempt_at,queue_lease_expires_at=excluded.queue_lease_expires_at,role=excluded.role,type=excluded.type,severity=excluded.severity,chat_id=excluded.chat_id,message_id=excluded.message_id,trade_set_id=excluded.trade_set_id,user_id=excluded.user_id`, args...)
	return err == nil, err
}

func derivedColumns(collection string, doc Document) []any {
	queue := object(doc["autotrader"])
	return []any{
		integerValue(doc["schema"]), stringValue(doc["created_at"]), stringValue(doc["timestamp"]),
		stringValue(doc["at"]), stringValue(doc["updated_at"]), stringValue(doc["last_seen_at"]),
		stringValue(doc["status"]), stringValue(doc["state"]), stringValue(queue["status"]),
		stringValue(queue["next_attempt_at"]), stringValue(queue["lease_expires_at"]),
		stringValue(doc["role"]), stringValue(doc["type"]), stringValue(doc["severity"]),
		stringValue(doc["chat_id"]), stringValue(doc["message_id"]), stringValue(doc["trade_set_id"]),
		stringValue(doc["user_id"]),
	}
}

func object(value any) map[string]any {
	switch out := value.(type) {
	case map[string]any:
		return out
	case Document:
		return map[string]any(out)
	}
	return nil
}

func stringValue(value any) any {
	switch v := value.(type) {
	case string:
		if v == "" {
			return nil
		}
		return v
	case json.Number:
		return v.String()
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case int, int32, int64, uint, uint32, uint64:
		return fmt.Sprint(v)
	default:
		return nil
	}
}

func integerValue(value any) any {
	switch v := value.(type) {
	case int:
		return v
	case int32:
		return v
	case int64:
		return v
	case float64:
		return int64(v)
	case json.Number:
		n, err := v.Int64()
		if err == nil {
			return n
		}
	}
	return nil
}

func decodeDocument(body string) (Document, error) {
	var doc Document
	if err := json.Unmarshal([]byte(body), &doc); err != nil {
		return nil, fmt.Errorf("decode SQLite document: %w", err)
	}
	if doc == nil {
		return nil, fmt.Errorf("%w: snapshot is not an object", ErrInvalidDocument)
	}
	return doc, nil
}

func listDocuments(ctx context.Context, q queryer, collection string, opts ListOptions) ([]Document, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = defaultListLimit
	}
	if limit > maxListLimit {
		limit = maxListLimit
	}
	timeField := opts.TimeField
	if timeField == "" {
		timeField = CreatedAt
	}
	timeColumn, ok := timeColumns[timeField]
	if !ok {
		return nil, fmt.Errorf("unknown list time field %q", timeField)
	}
	where := []string{"collection=?"}
	args := []any{collection}
	filters := append([]Filter(nil), opts.Filters...)
	sort.Slice(filters, func(i, j int) bool { return filters[i].Field < filters[j].Field })
	for _, filter := range filters {
		column, ok := filterColumns[filter.Field]
		if !ok {
			return nil, fmt.Errorf("unknown list filter %q", filter.Field)
		}
		if len(filter.Values) == 0 {
			return nil, fmt.Errorf("list filter %q has no values", filter.Field)
		}
		where = append(where, column+` IN (`+placeholders(len(filter.Values))+`)`)
		for _, value := range filter.Values {
			args = append(args, value)
		}
	}
	if opts.Schema != nil {
		where = append(where, "schema_num=?")
		args = append(args, *opts.Schema)
	}
	if opts.After != nil {
		if err := validateCursor(opts.After, opts.Descending, timeField); err != nil {
			return nil, err
		}
		op := ">"
		if opts.Descending {
			op = "<"
		}
		where = append(where, `(COALESCE(`+timeColumn+`, '') `+op+` ? OR (COALESCE(`+timeColumn+`, '') = ? AND id `+op+` ?))`)
		args = append(args, opts.After.Time, opts.After.Time, opts.After.ID)
	}
	if opts.Before != nil {
		if err := validateCursor(opts.Before, opts.Descending, timeField); err != nil {
			return nil, err
		}
		op := "<"
		if opts.Descending {
			op = ">"
		}
		where = append(where, `(COALESCE(`+timeColumn+`, '') `+op+` ? OR (COALESCE(`+timeColumn+`, '') = ? AND id `+op+` ?))`)
		args = append(args, opts.Before.Time, opts.Before.Time, opts.Before.ID)
	}
	direction := "ASC"
	if opts.Descending {
		direction = "DESC"
	}
	query := `SELECT id,body FROM documents WHERE ` + strings.Join(where, " AND ") + ` ORDER BY COALESCE(` + timeColumn + `, '') ` + direction + `, id ` + direction + ` LIMIT ?`
	args = append(args, limit)
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Document, 0, min(limit, 128))
	for rows.Next() {
		var id, body string
		if err := rows.Scan(&id, &body); err != nil {
			return nil, err
		}
		doc, err := decodeDocument(body)
		if err != nil {
			return nil, err
		}
		doc["_id"] = id
		out = append(out, doc)
	}
	return out, rows.Err()
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

func validateCursor(cursor *Cursor, descending bool, timeField TimeField) error {
	if cursor.ID == "" {
		return errors.New("cursor document ID is empty")
	}
	if cursor.Descending != descending {
		return errors.New("cursor direction does not match requested order")
	}
	if cursor.TimeField != "" && cursor.TimeField != timeField {
		return errors.New("cursor time field does not match requested order")
	}
	return nil
}

func (s *SQLiteStore) Backup(ctx context.Context, destination string) error {
	dest, err := filepath.Abs(destination)
	if err != nil {
		return fmt.Errorf("resolve backup path: %w", err)
	}
	if dest == s.path {
		return errors.New("backup destination matches live database")
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return err
	}
	tmp := dest + ".tmp-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	_ = os.Remove(tmp)
	file, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("create backup file: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	var backupErr error
	err = conn.Raw(func(driverConn any) error {
		backuper, ok := driverConn.(interface {
			NewBackup(string) (*sqlite.Backup, error)
		})
		if !ok {
			return errors.New("SQLite driver lacks online backup support")
		}
		backup, err := backuper.NewBackup(sqliteURI(tmp))
		if err != nil {
			return err
		}
		defer func() {
			if err := backup.Finish(); backupErr == nil && err != nil {
				backupErr = err
			}
		}()
		for {
			if err := ctx.Err(); err != nil {
				return err
			}
			more, err := backup.Step(128)
			if err != nil {
				return err
			}
			if !more {
				return nil
			}
		}
	})
	closeErr := conn.Close()
	if err == nil {
		err = backupErr
	}
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("online SQLite backup: %w", err)
	}
	backupFile, err := os.OpenFile(tmp, os.O_RDONLY, 0)
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := backupFile.Sync(); err != nil {
		backupFile.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := backupFile.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	// Link publishes the complete backup atomically without replacing an
	// existing path (os.Rename would silently clobber an earlier backup).
	if err := os.Link(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("publish backup without replacing destination: %w", err)
	}
	if err := os.Remove(tmp); err != nil {
		return fmt.Errorf("remove backup staging link: %w", err)
	}
	dir, err := os.Open(filepath.Dir(dest))
	if err == nil {
		err = dir.Sync()
		_ = dir.Close()
	}
	return err
}

func sqliteURI(path string) string { return (&url.URL{Scheme: "file", Path: path}).String() }
