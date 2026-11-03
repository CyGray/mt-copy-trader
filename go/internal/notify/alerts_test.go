package notify

import (
	"context"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bytrader/bytrader/internal/store"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestAlertDedupEscalationResolutionAndRedaction(t *testing.T) {
	t.Setenv("ALERT_NOTIFICATIONS", "enabled")
	t.Setenv("ALERT_WEBHOOK_URL", "https://notifications.invalid/hook")
	db, err := store.Open(filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	manager := New(db)
	now := time.Now()
	manager.Now = func() time.Time { return now }
	var bodies []string
	manager.Client = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		data, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(data))
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})}
	input := Alert{Type: "submit_unknown", Subject: "trade-1", Severity: "error", Source: "executor", Title: "Outcome unknown", Message: "Bearer synthetic-credential-should-be-hidden", Details: map[string]any{"api_key": "private-data", "nested": map[string]any{"password": "private-data", "safe": "ok"}}}
	ctx := context.Background()
	if !manager.Raise(ctx, input) || !manager.Raise(ctx, input) {
		t.Fatal("raise failed")
	}
	if len(bodies) != 1 || strings.Contains(bodies[0], "synthetic-credential") {
		t.Fatal("notification deduplication or redaction failed")
	}
	doc, err := db.Get(ctx, "alerts", ID(input.Type, input.Subject))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(doc["message"].(string), "synthetic-credential") {
		t.Fatal("alert leaked bearer")
	}
	data := doc["details"].(map[string]any)
	if data["api_key"] != nil {
		t.Fatal("details leaked secret key")
	}
	if err := db.WithTx(ctx, func(tx *store.Tx) error {
		doc["status"] = "acknowledged"
		return tx.Put("alerts", ID(input.Type, input.Subject), doc)
	}); err != nil {
		t.Fatal(err)
	}
	input.Severity = "critical"
	if !manager.Raise(ctx, input) || len(bodies) != 2 {
		t.Fatal("escalation was throttled")
	}
	doc, err = db.Get(ctx, "alerts", ID(input.Type, input.Subject))
	if err != nil {
		t.Fatal(err)
	}
	if doc["status"] != "open" || doc["severity"] != "critical" {
		t.Fatal("escalation did not reopen acknowledged alert")
	}
	if !manager.Resolve(ctx, input.Type, input.Subject, "broker_reconciled") {
		t.Fatal("resolve failed")
	}
	now = now.Add(16 * time.Minute)
	input.Severity = "error"
	if !manager.Raise(ctx, input) || len(bodies) != 3 {
		t.Fatal("resolved alert did not reopen")
	}
	doc, err = db.Get(ctx, "alerts", ID(input.Type, input.Subject))
	if err != nil {
		t.Fatal(err)
	}
	if doc["status"] != "open" || numeric(doc["reopened_count"]) != 1 || doc["action"] == "" {
		t.Fatal("reopen state incomplete")
	}
}

func TestStorageOutageStillNotifiesWithoutDetails(t *testing.T) {
	t.Setenv("ALERT_NOTIFICATIONS", "enabled")
	t.Setenv("ALERT_WEBHOOK_URL", "https://notifications.invalid/hook")
	manager := New(nil)
	called := false
	manager.Client = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		data, _ := io.ReadAll(r.Body)
		called = true
		if strings.Contains(string(data), "details") {
			t.Fatal("notification included details")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})}
	if manager.Raise(context.Background(), Alert{Type: "firestore_unavailable", Severity: "critical", Source: "web", Title: "Storage down", Details: map[string]any{"private_key": "never-send"}}) {
		t.Fatal("missing store reported success")
	}
	if !called {
		t.Fatal("storage outage suppressed external notification")
	}
}
