package app

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/bytrader/bytrader/internal/notify"
	"github.com/bytrader/bytrader/internal/store"
)

func TestWebMonitorReportsExecutorFailureAndRecovery(t *testing.T) {
	t.Setenv("ALERT_NOTIFICATIONS", "disabled")
	db, err := store.Open(filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	if err := db.Put(ctx, "service_status", "forwarder", store.Document{"healthy": true, "updated_at": store.ISO(time.Now())}); err != nil {
		t.Fatal(err)
	}
	if err := db.Put(ctx, "service_status", "executor", store.Document{"healthy": true, "updated_at": store.ISO(time.Now().Add(-time.Hour))}); err != nil {
		t.Fatal(err)
	}
	manager := notify.New(db)
	for _, expected := range []string{"open", "resolved"} {
		if expected == "resolved" {
			if err := db.Put(ctx, "service_status", "executor", store.Document{"healthy": true, "updated_at": store.ISO(time.Now())}); err != nil {
				t.Fatal(err)
			}
		}
		run, cancel := context.WithCancel(ctx)
		done := make(chan struct{})
		go func() { defer close(done); Monitor(run, db, manager) }()
		deadline := time.Now().Add(3 * time.Second)
		matched := false
		for time.Now().Before(deadline) {
			doc, err := db.Get(ctx, "alerts", notify.ID("service_unhealthy", "executor"))
			if err == nil && doc["status"] == expected {
				matched = true
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		cancel()
		<-done
		if !matched {
			t.Fatalf("executor alert did not become %s", expected)
		}
	}
}
