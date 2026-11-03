package app

import (
	"context"
	"errors"
	"time"

	"github.com/bytrader/bytrader/internal/notify"
	"github.com/bytrader/bytrader/internal/store"
)

// The web role can report failed execution even while the executor is stopped.
func Monitor(ctx context.Context, db store.Store, alerts *notify.Manager) {
	tick := func() {
		now := time.Now()
		for _, role := range []string{"forwarder", "executor"} {
			doc, err := db.Get(ctx, "service_status", role)
			if err != nil && !errors.Is(err, store.ErrNotFound) {
				alerts.Raise(ctx, notify.Alert{Type: "firestore_unavailable", Subject: "web", Severity: "critical", Source: "web", Title: "Operational storage is unavailable", Message: "State reads are failing. No broker operation can be confirmed."})
				return
			}
			at, _ := doc["updated_at"].(string)
			updated, parseErr := time.Parse(time.RFC3339Nano, at)
			fresh := parseErr == nil && now.Sub(updated) >= 0 && now.Sub(updated) < 30*time.Second
			if fresh && doc["healthy"] == true {
				alerts.Resolve(ctx, "service_unhealthy", role, "healthy_heartbeat")
				continue
			}
			severity := "error"
			if role == "executor" {
				severity = "critical"
			}
			message := role + " is not ready or its heartbeat is stale."
			if role == "executor" {
				message += " Saved commands cannot execute and protective management cannot run until it recovers; broker-side SL/TP remain in force."
			}
			alerts.Raise(ctx, notify.Alert{Type: "service_unhealthy", Subject: role, Severity: severity, Source: "web", Title: role + " is unavailable", Message: message, Details: map[string]any{"last_heartbeat": at}})
		}
		alerts.Resolve(ctx, "firestore_unavailable", "web", "sqlite_recovered")
	}
	tick()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			tick()
		}
	}
}
