package app

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/bytrader/bytrader/internal/store"
)

type ControlsBundle struct {
	Schema   int                       `json:"schema"`
	Settings store.Document            `json:"settings"`
	Profiles map[string]store.Document `json:"execution_profiles"`
	Users    map[string]store.Document `json:"users"`
}

func Initialize(ctx context.Context, db store.Store, now time.Time) error {
	return db.WithTx(ctx, func(tx *store.Tx) error {
		created, err := tx.Create("settings", "default", store.Document{
			"execution": store.Document{"mode": "disabled"},
			"trading":   store.Document{"kill_switch": true},
			"telegram":  store.Document{"allowed_chat_ids": []string{}, "blocked_chat_ids": []string{}},
			"migration": store.Document{"initialized_at": store.ISO(now)},
		})
		if err != nil {
			return err
		}
		if !created {
			return errors.New("database already initialized; existing controls were preserved")
		}
		return nil
	})
}

// ImportControls deliberately excludes history, active trades, queues and sessions.
func ImportControls(ctx context.Context, db store.Store, bundle ControlsBundle, now time.Time) error {
	if bundle.Schema != 1 || bundle.Settings == nil {
		return errors.New("controls bundle requires schema 1 and settings")
	}
	for uid, user := range bundle.Users {
		if uid == "" || (user["role"] != "admin" && user["role"] != "viewer") {
			return fmt.Errorf("invalid role for user %q", uid)
		}
	}
	return db.WithTx(ctx, func(tx *store.Tx) error {
		current, err := tx.Get("settings", "default")
		if err != nil {
			return err
		}
		migration := object(current["migration"])
		if migration["controls_imported_at"] != nil || migration["cutover_at"] != nil {
			return errors.New("controls already imported or cutover sealed")
		}
		if err := settled(tx); err != nil {
			return err
		}
		for collection, docs := range map[string]map[string]store.Document{"execution_profiles": bundle.Profiles, "users": bundle.Users} {
			for id, doc := range docs {
				created, err := tx.Create(collection, id, doc)
				if err != nil {
					return err
				}
				if !created {
					return fmt.Errorf("%s/%s already exists; import aborted", collection, id)
				}
			}
		}
		settings := bundle.Settings
		previous := object(settings["migration"])
		if barrier, exists := previous["replay_not_before"]; exists {
			value, ok := barrier.(string)
			if !ok {
				return errors.New("imported replay barrier must be an ISO timestamp")
			}
			if _, err := time.Parse(time.RFC3339Nano, value); err != nil {
				return errors.New("imported replay barrier is invalid")
			}
			migration["replay_not_before"] = value
		}
		if previous["cutover_at"] != nil {
			migration["previous_cutover_at"] = previous["cutover_at"]
		}
		execution := object(settings["execution"])
		execution["mode"] = "disabled"
		settings["execution"] = execution
		trading := object(settings["trading"])
		trading["kill_switch"] = true
		settings["trading"] = trading
		migration["controls_imported_at"] = store.ISO(now)
		settings["migration"] = migration
		return tx.Put("settings", "default", settings)
	})
}

func CheckSettled(ctx context.Context, db store.Store) error {
	return db.WithTx(ctx, settled)
}

func settled(tx *store.Tx) error {
	for _, query := range []struct {
		collection string
		field      store.IndexField
		states     []string
	}{
		{"trade_sets", store.StateField, []string{"CLAIMED", "SUBMITTING", "SUBMIT_UNKNOWN", "PENDING_ORDER", "OPEN", "PARTIALLY_CLOSED"}},
		{"signal_events", store.QueueStatusField, []string{"pending", "processing", "retry_wait", "dead_letter"}},
		{"admin_commands", store.StatusField, []string{"pending", "queued", "running", "processing"}},
		{"telegram_commands", store.StatusField, []string{"pending", "queued", "running", "processing"}},
	} {
		rows, err := tx.List(query.collection, store.ListOptions{Filters: []store.Filter{{Field: query.field, Values: query.states}}, Limit: 1})
		if err != nil {
			return err
		}
		if len(rows) != 0 {
			return fmt.Errorf("unsettled %s record %v; settle or explicitly resolve it first", query.collection, rows[0]["_id"])
		}
	}
	for _, collection := range []string{"trade_sets", "admin_commands"} {
		var cursor *store.Cursor
		for {
			rows, err := tx.List(collection, store.ListOptions{After: cursor, Limit: 200})
			if err != nil {
				return err
			}
			for _, doc := range rows {
				if doc["mutation_intent"] != nil || doc["revision_intent"] != nil || object(doc["cancel_requested"])["mutation_status"] == "ambiguous" || doc["close_request_status"] == "ambiguous" {
					return fmt.Errorf("%s record %v has an unresolved broker intent", collection, doc["_id"])
				}
				for _, raw := range object(doc["mutation_intents"]) {
					status := object(raw)["status"]
					if status != "done" && status != "retryable" {
						return fmt.Errorf("%s record %v has an unresolved target mutation", collection, doc["_id"])
					}
				}
				id, _ := doc["_id"].(string)
				at, _ := doc["created_at"].(string)
				cursor = &store.Cursor{ID: id, Time: at}
			}
			if len(rows) < 200 {
				break
			}
		}
	}
	if paper, err := tx.Get("paper_broker", "state"); err == nil {
		for _, field := range []string{"positions", "orders"} {
			if rows, ok := paper[field].([]any); ok && len(rows) > 0 {
				return fmt.Errorf("paper broker has unsettled %s", field)
			}
		}
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	return nil
}

// SealCutover records an operator's separately obtained broker-flat attestation.
// Database checks cannot prove that MT5 has no late or unowned broker requests.
func SealCutover(ctx context.Context, db store.Store, now time.Time) error {
	return db.WithTx(ctx, func(tx *store.Tx) error {
		if err := settled(tx); err != nil {
			return err
		}
		settings, err := tx.Get("settings", "default")
		if err != nil {
			return err
		}
		migration := object(settings["migration"])
		if migration["cutover_at"] != nil {
			return errors.New("cutover already sealed; refusing to move the replay barrier")
		}
		at := store.ISO(now)
		if previous, ok := migration["replay_not_before"].(string); ok {
			barrier, err := time.Parse(time.RFC3339Nano, previous)
			if err != nil || barrier.After(now) {
				return errors.New("existing replay barrier is invalid or later than this cutover")
			}
		}
		migration["cutover_at"] = at
		migration["replay_not_before"] = at
		migration["old_queue_disposition"] = "discarded_at_settled_boundary"
		migration["broker_verification"] = "operator_attested"
		settings["migration"] = migration
		execution := object(settings["execution"])
		execution["mode"] = "disabled"
		settings["execution"] = execution
		trading := object(settings["trading"])
		trading["kill_switch"] = true
		settings["trading"] = trading
		if err := tx.Put("settings", "default", settings); err != nil {
			return err
		}
		_, err = tx.Create("admin_audit", "cutover-"+at, store.Document{"action": "flat_settled_cutover", "actor_uid": "local-operator", "at": at, "details": migration})
		return err
	})
}

func object(value any) store.Document {
	if v, ok := value.(map[string]any); ok {
		return v
	}
	if v, ok := value.(store.Document); ok {
		return v
	}
	return store.Document{}
}
