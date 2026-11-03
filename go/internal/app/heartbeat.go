package app

import (
	"context"
	"log/slog"
	"os"
	"time"

	"github.com/bytrader/bytrader/internal/store"
)

type ServiceSnapshot struct {
	Healthy bool
	Issues  []string
	Details store.Document
}

func Heartbeat(ctx context.Context, db store.Store, role, version string, snapshot func() ServiceSnapshot) {
	started := store.ISO(time.Now())
	write := func(stopping bool) {
		status := snapshot()
		if stopping {
			status.Healthy = false
			status.Issues = []string{"service_stopped"}
		}
		if status.Issues == nil {
			status.Issues = []string{}
		}
		if status.Details == nil {
			status.Details = store.Document{}
		}
		status.Details["version"] = version
		writeCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := db.Put(writeCtx, "service_status", role, store.Document{
			"service": role, "updated_at": store.ISO(time.Now()), "started_at": started,
			"healthy": status.Healthy, "issues": status.Issues, "details": status.Details,
			"pid": os.Getpid(), "interval_ms": 15000,
		}); err != nil {
			slog.Error("heartbeat_write_failed", "service", role, "error", err)
		}
	}
	write(false)
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			write(true)
			return
		case <-ticker.C:
			write(false)
		}
	}
}
