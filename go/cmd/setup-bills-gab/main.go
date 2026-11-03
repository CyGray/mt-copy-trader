// setup-bills-gab records the conservative demo-only rollout, without activating
// the unresearched Bills Trading signal source. It makes no broker calls.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
)

const (
	gabChat        = "-1003740937489"
	billsChat      = "-1003192025181"
	gabProfileID   = "gab-ladder-w80-n1__v1"
	billsProfileID = "bills-observation-tp1__v1"
)

func obj(v any) map[string]any {
	if x, ok := v.(map[string]any); ok {
		return x
	}
	return map[string]any{}
}
func newID() string {
	b := make([]byte, 12)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func list(v any) []any { x, _ := v.([]any); return x }
func has(xs []any, needle string) bool {
	for _, v := range xs {
		if v == needle {
			return true
		}
	}
	return false
}

func main() {
	dbPath := flag.String("db", "", "path to active SQLite database")
	profilePath := flag.String("profile", "internal/domain/testdata/bills_observation_profile.json", "review-only Bills profile JSON")
	apply := flag.Bool("apply-demo-only", false, "apply audited demo-only settings and draft profile")
	flag.Parse()
	if *dbPath == "" {
		fmt.Fprintln(os.Stderr, "--db is required")
		os.Exit(2)
	}
	bytes, err := os.ReadFile(*profilePath)
	if err != nil {
		fatal(err)
	}
	var candidate map[string]any
	if err = json.Unmarshal(bytes, &candidate); err != nil {
		fatal(err)
	}
	validated := domain.ValidateProfile(candidate)
	if !validated.OK || validated.Value == nil || validated.Value.ProfileID != "bills-observation-tp1" || validated.Value.Version != 1 || validated.Value.Sizing.FixedLots == nil || *validated.Value.Sizing.FixedLots != 0.01 {
		fatal(fmt.Errorf("draft Bills candidate fails validation or exact 0.01 volume contract: %+v", validated.Errors))
	}
	db, err := store.Open(*dbPath)
	if err != nil {
		fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	// Every precondition and mutation is checked inside one SQLite transaction.
	err = db.WithTx(ctx, func(tx *store.Tx) error {
		settings, err := tx.Get("settings", "default")
		if err != nil {
			return err
		}
		execution := obj(settings["execution"])
		trading := obj(settings["trading"])
		mt5 := obj(settings["mt5"])
		tg := obj(settings["telegram"])
		if execution["mode"] != "demo" || execution["active_profile_doc_id"] != gabProfileID || trading["kill_switch"] != false {
			return errors.New("refusing: expected demo mode, active GAB profile, kill switch off")
		}
		sources := list(mt5["source_chat_ids"])
		if len(sources) != 1 || sources[0] != gabChat {
			return errors.New("refusing: GAB must remain the sole execution source")
		}
		gab, err := tx.Get("execution_profiles", gabProfileID)
		if err != nil || gab["status"] != "active" {
			return errors.New("refusing: approved active GAB profile absent")
		}
		current, exists := mt5["source_profile_doc_ids"]
		if exists {
			m := obj(current)
			if len(m) != 2 || m[gabChat] != gabProfileID || m[billsChat] != billsProfileID {
				return errors.New("refusing: existing source profile routing differs")
			}
		}
		blocked := list(tg["blocked_chat_ids"])
		bills, err := tx.Get("execution_profiles", billsProfileID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if err == nil && (bills["status"] != "draft" || bills["profile_id"] != "bills-observation-tp1") {
			return errors.New("refusing: existing Bills profile differs")
		}
		if !*apply {
			fmt.Printf("DRY RUN mode=demo GAB=%s Bills=draft-only blocked=%v source_count=1 existing_routing=%v\n", gabProfileID, has(blocked, billsChat), exists)
			return nil
		}
		at := time.Now().UTC().Format(time.RFC3339Nano)
		if errors.Is(err, store.ErrNotFound) {
			draft := store.Document{}
			for k, v := range candidate {
				draft[k] = v
			}
			draft["status"] = "draft"
			draft["created_at"] = at
			draft["updated_at"] = at
			draft["created_by"] = "bytrader operator-authorized maintenance"
			draft["updated_by"] = "bytrader operator-authorized maintenance"
			draft["validation"] = map[string]any{"ok": true, "errors": []any{}, "warnings": []any{}, "validated_at": at}
			created, e := tx.Create("execution_profiles", billsProfileID, draft)
			if e != nil {
				return e
			}
			if !created {
				return errors.New("Bills profile insert raced")
			}
		}
		remaining := make([]any, 0, len(blocked))
		for _, id := range blocked {
			if id != billsChat {
				remaining = append(remaining, id)
			}
		}
		tg["blocked_chat_ids"] = remaining
		mt5["source_profile_doc_ids"] = map[string]any{gabChat: gabProfileID, billsChat: billsProfileID}
		settings["telegram"] = tg
		settings["mt5"] = mt5
		if err := tx.Put("settings", "default", settings); err != nil {
			return err
		}
		details := map[string]any{"source": "bills_gab_20261103", "mode": "demo", "gabs_execution_source": gabChat, "bills_record_only": billsChat, "bills_profile_status": "draft"}
		if _, err := tx.Create("admin_audit", newID(), store.Document{"action": "bills_gab_demo_routing", "actor_uid": "service-maintenance", "actor_email": "", "at": at, "details": details}); err != nil {
			return err
		}
		if _, err := tx.Create("execution_profile_audit", newID(), store.Document{"action": "create_draft", "profile_doc_id": billsProfileID, "actor_uid": "service-maintenance", "actor_email": "", "at": at, "details": map[string]any{"reason": "Bills has no audited signals and must not execute"}}); err != nil {
			return err
		}
		fmt.Printf("APPLIED demo-only: GAB=%s active, Bills profile draft and unblocked for recording; no broker calls\n", gabProfileID)
		return nil
	})
	if err != nil {
		fatal(err)
	}
}
func fatal(err error) {
	fmt.Fprintln(os.Stderr, "setup-bills-gab:", strings.TrimSpace(err.Error()))
	os.Exit(1)
}
