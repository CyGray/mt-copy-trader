package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bytrader/bytrader/internal/store"
)

func serveTelegramPreferAsync(handler http.Handler, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer admin")
	request.Header.Set("Prefer", "respond-async")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestTelegramLegacyRoutesReturnCompletedStatusAndErrors(t *testing.T) {
	t.Setenv("MASTER_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name           string
		path           string
		body           string
		commandType    string
		commandStatus  string
		result         store.Document
		wantHTTPStatus int
		wantBody       string
	}{
		{
			name: "start login returns completed status",
			path: "/api/telegram/start", body: `{"phone":"+15551234567"}`,
			commandType: "start_login", commandStatus: "done",
			result:         store.Document{"status": "awaiting_code", "phone_masked": "***567", "last_error": nil, "reauth_required": false},
			wantHTTPStatus: http.StatusOK, wantBody: `"status":"awaiting_code"`,
		},
		{
			name: "invalid otp preserves legacy error response",
			path: "/api/telegram/verify-otp", body: `{"code":"12345"}`,
			commandType: "verify_otp", commandStatus: "error",
			result:         store.Document{"status": "awaiting_code", "phone_masked": "***567", "last_error": "invalid_code", "reauth_required": false},
			wantHTTPStatus: http.StatusBadRequest, wantBody: `"error":"OTP not accepted"`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := openTestStore(t)
			handler := adminTestHandler(t, db)
			if err := db.Put(context.Background(), telegramOwnerCollection, telegramOwnerDocument, store.Document{
				"owner_id": "mock-forwarder", "lease_expires_at": store.ISO(now.Add(time.Minute)),
			}); err != nil {
				t.Fatal(err)
			}
			forwarderDone := mockTelegramForwarder(t, db, tt.commandType, tt.commandStatus, tt.result)

			response := serveJSON(handler, http.MethodPost, tt.path, "admin", tt.body)
			if response.Code != tt.wantHTTPStatus || !strings.Contains(response.Body.String(), tt.wantBody) {
				t.Fatalf("legacy POST %s status=%d body=%s", tt.path, response.Code, response.Body.String())
			}
			if strings.Contains(response.Body.String(), "command_id") || strings.Contains(response.Body.String(), "+15551234567") || strings.Contains(response.Body.String(), "12345") {
				t.Fatalf("legacy response exposed command metadata or credentials: %s", response.Body.String())
			}
			if err := <-forwarderDone; err != nil {
				t.Fatalf("mock forwarder: %v", err)
			}
		})
	}
}

func TestTelegramLegacyRouteRejectsUnavailableForwarderBeforeQueue(t *testing.T) {
	t.Setenv("MASTER_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	db := openTestStore(t)
	handler := adminTestHandler(t, db)
	response := serveJSON(handler, http.MethodPost, "/api/telegram/start", "admin", `{"phone":"+15551234567"}`)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"error":"Telegram forwarder unavailable"`) {
		t.Fatalf("legacy request without forwarder status=%d body=%s", response.Code, response.Body.String())
	}
	commands, err := db.List(context.Background(), "telegram_commands", store.ListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 0 {
		t.Fatalf("unavailable forwarder left queued commands: %+v", commands)
	}
	audits, err := db.List(context.Background(), "admin_audit", store.ListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(audits) != 0 {
		t.Fatalf("unavailable forwarder left audit rows: %+v", audits)
	}
}

func TestTelegramCommandAndAuditCommitAtomically(t *testing.T) {
	t.Setenv("MASTER_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	dbPath := filepath.Join(t.TempDir(), "state.sqlite")
	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	handler := adminTestHandler(t, db)
	rawDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rawDB.Close() })
	if _, err := rawDB.Exec(`CREATE TRIGGER reject_admin_audit BEFORE INSERT ON documents WHEN NEW.collection = 'admin_audit' BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`); err != nil {
		t.Fatal(err)
	}
	response := serveTelegramPreferAsync(handler, "/api/telegram/start", `{"phone":"+15551234567"}`)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"error":"Command could not be queued"`) {
		t.Fatalf("audit failure response status=%d body=%s", response.Code, response.Body.String())
	}
	commands, err := db.List(context.Background(), "telegram_commands", store.ListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	audits, err := db.List(context.Background(), "admin_audit", store.ListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 0 || len(audits) != 0 {
		t.Fatalf("audit failure partially committed Telegram command: commands=%+v audits=%+v", commands, audits)
	}
}

func TestTelegramLegacyWaitReturnsCommandIDWithoutCancellingProcessingCommand(t *testing.T) {
	t.Setenv("MASTER_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	db := openTestStore(t)
	handler := adminTestHandler(t, db)
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	if err := db.Put(context.Background(), telegramOwnerCollection, telegramOwnerDocument, store.Document{
		"owner_id": "mock-forwarder", "lease_expires_at": store.ISO(now.Add(time.Minute)),
	}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	forwarderDone := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			rows, err := db.List(context.Background(), "telegram_commands", store.ListOptions{Limit: 10})
			if err != nil {
				forwarderDone <- err
				return
			}
			if len(rows) > 0 {
				id := stringField(rows[0], "_id")
				err := db.WithTx(context.Background(), func(tx *store.Tx) error {
					doc, err := tx.Get("telegram_commands", id)
					if err != nil {
						return err
					}
					doc["status"] = "processing"
					return tx.Put("telegram_commands", id, doc)
				})
				if err == nil {
					cancel()
				}
				forwarderDone <- err
				return
			}
			select {
			case <-ctx.Done():
				forwarderDone <- ctx.Err()
				return
			case <-ticker.C:
			}
		}
	}()

	request := httptest.NewRequest(http.MethodPost, "/api/telegram/start", strings.NewReader(`{"phone":"+15551234567"}`)).WithContext(ctx)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer admin")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"command_id"`) {
		t.Fatalf("in-flight legacy command status=%d body=%s", response.Code, response.Body.String())
	}
	if err := <-forwarderDone; err != nil {
		t.Fatalf("mock forwarder: %v", err)
	}
	commands, err := db.List(context.Background(), "telegram_commands", store.ListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 1 || stringField(commands[0], "status") != "processing" || stringField(commands[0], "payload_enc") == "" {
		t.Fatalf("wait cancelled or altered in-flight command: %+v", commands)
	}
}

func mockTelegramForwarder(t *testing.T, db store.Store, commandType, commandStatus string, result store.Document) <-chan error {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			rows, err := db.List(ctx, "telegram_commands", store.ListOptions{Limit: 100})
			if err != nil {
				done <- err
				return
			}
			for _, row := range rows {
				if stringField(row, "type") != commandType || stringField(row, "status") != "pending" {
					continue
				}
				id := stringField(row, "_id")
				err := db.WithTx(ctx, func(tx *store.Tx) error {
					doc, err := tx.Get("telegram_commands", id)
					if err != nil {
						return err
					}
					if stringField(doc, "status") != "pending" {
						return errors.New("mock forwarder found command in unexpected state")
					}
					doc["status"], doc["result"] = commandStatus, result
					delete(doc, "payload_enc")
					return tx.Put("telegram_commands", id, doc)
				})
				done <- err
				return
			}
			select {
			case <-ctx.Done():
				done <- ctx.Err()
				return
			case <-ticker.C:
			}
		}
	}()
	return done
}
