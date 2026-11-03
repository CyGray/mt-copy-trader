package engine

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/bytrader/bytrader/internal/notify"
	"github.com/bytrader/bytrader/internal/store"
)

func (r *Runner) audit(ctx context.Context, level, event string, details map[string]any) {
	switch level {
	case "error":
		slog.Error(event, "details", details)
	case "warn":
		slog.Warn(event, "details", details)
	default:
		slog.Info(event, "details", details)
	}
	at := store.ISO(r.cfg.Now())
	id := fmt.Sprintf("%d_%s", r.cfg.Now().UnixNano(), event)
	if len(id) > 200 {
		id = id[:200]
	}
	doc := store.Document{"timestamp": at, "level": level, "source": "autotrader", "message": event, "service": "execution", "event": event, "details": details}
	_ = r.db.WithTx(ctx, func(tx *store.Tx) error { _, err := tx.Create("system_logs", id, doc); return err })
}

func (r *Runner) tradeEvent(ctx context.Context, tradeID, mode, eventKey, eventType string, fields map[string]any) {
	doc := store.Document{"trade_set_id": tradeID, "event_key": eventKey, "type": eventType, "mode": mode, "timestamp": store.ISO(r.cfg.Now())}
	for key, value := range fields {
		if value != nil {
			doc[key] = value
		}
	}
	id := tradeID + "__" + eventKey
	_ = r.db.WithTx(ctx, func(tx *store.Tx) error { _, err := tx.Create("trade_events", id, doc); return err })
}

func (r *Runner) raiseAlert(ctx context.Context, alertType, subject, severity, title, message string, details map[string]any) {
	if r.cfg.Alerts == nil {
		return
	}
	r.cfg.Alerts.Raise(ctx, notify.Alert{Type: alertType, Subject: subject, Severity: severity, Source: "autotrader", Title: title, Message: message, Details: details})
}

func (r *Runner) resolveAlert(ctx context.Context, alertType, subject, resolution string) {
	if r.cfg.Alerts != nil {
		r.cfg.Alerts.Resolve(ctx, alertType, subject, resolution)
	}
}

func isoEventKey(prefix string, at time.Time) string {
	return fmt.Sprintf("%s_%d", prefix, at.UnixNano())
}
