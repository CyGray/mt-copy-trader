package app

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/bytrader/bytrader/internal/store"
)

func TestStoppedHeartbeatCannotLookReady(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		Heartbeat(ctx, db, "executor", "offline-test", func() ServiceSnapshot { return ServiceSnapshot{Healthy: true} })
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("heartbeat did not stop")
	}
	status, err := db.Get(context.Background(), "service_status", "executor")
	if err != nil {
		t.Fatal(err)
	}
	if status["healthy"] != false {
		t.Fatal("stopped executor appears ready")
	}
}
