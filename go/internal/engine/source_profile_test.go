package engine

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
)

func TestSourceProfileRoutingLegacyAndFailClosed(t *testing.T) {
	profile := validMutationTestProfile(t)
	original := Control{ActiveProfileDocID: "global", ActiveProfile: &profile}
	if got := original.ForChat("any"); got.ActiveProfileDocID != "global" || got.ActiveProfile == nil {
		t.Fatalf("legacy profile changed: %+v", got)
	}
	safety := domain.DefaultSafetyLimits
	route := Control{Mode: "demo", Safety: &safety, SourceProfilesConfigured: true, ActiveProfileDocID: "global", ActiveProfile: &profile,
		SourceProfiles: map[string]SourceProfile{
			"-1003740937489": {DocID: "gab__v1", Profile: &profile},
			"-1003192025181": {DocID: "bills__v1", Errors: []string{"source_profile_status_draft"}},
		}}
	gab := route.ForChat("-1003740937489")
	if gab.ActiveProfileDocID != "gab__v1" || gab.ActiveProfile == nil || len(gab.ProfileErrors) != 0 {
		t.Fatalf("GAB routing wrong: %+v", gab)
	}
	bills := route.ForChat("-1003192025181")
	if bills.ActiveProfileDocID != "bills__v1" || bills.ActiveProfile != nil || len(bills.ProfileErrors) != 1 {
		t.Fatalf("draft Bills profile must fail closed: %+v", bills)
	}
	if ok, reason := bills.CanOpenNewEntries(); ok || reason != "invalid_profile" {
		t.Fatalf("draft Bills profile opened entries: %v %s", ok, reason)
	}
	other := route.ForChat("-1003271337051")
	if other.ActiveProfileDocID != "" || other.ActiveProfile != nil {
		t.Fatalf("unmapped source inherited global profile: %+v", other)
	}
	if ok, reason := other.CanOpenNewEntries(); ok || reason != "no_active_profile" {
		t.Fatalf("unmapped source should fail closed: %v %s", ok, reason)
	}
}

func TestSourceProfileRoutingRecheckedBeforeOrder(t *testing.T) {
	profile := validMutationTestProfile(t)
	previous := &prepared{mode: "demo", profileDocID: "gab__v1"}
	control := Control{Mode: "demo", ActiveProfileDocID: "global", ActiveProfile: &profile,
		SourceProfilesConfigured: true, SourceProfiles: map[string]SourceProfile{
			"-1003740937489": {DocID: "gab__v1", Profile: &profile},
		}}
	// Other entry guards are present in the test fixture.
	safety := domain.DefaultSafetyLimits
	control.Safety = &safety
	if reason, _ := recheckControl(previous, control.ForChat("-1003740937489")); reason != "" {
		t.Fatalf("stable source config refused: %s", reason)
	}
	control.SourceProfiles["-1003740937489"] = SourceProfile{DocID: "gab__v2", Profile: &profile}
	if reason, _ := recheckControl(previous, control.ForChat("-1003740937489")); reason != "profile_changed" {
		t.Fatalf("changed source profile did not block pending send: %s", reason)
	}
}

func TestReadControlRejectsMalformedSourceProfileMap(t *testing.T) {
	w := newIntentTestWorld(t)
	ctx := context.Background()
	doc := store.Document{"mt5": map[string]any{"source_profile_doc_ids": []any{"invalid"}},
		"execution": map[string]any{"mode": "demo"},
		"trading":   map[string]any{"kill_switch": false},
		"migration": map[string]any{"replay_not_before": store.ISO(w.now)}}
	if err := w.db.Put(ctx, "settings", "default", doc); err != nil {
		t.Fatal(err)
	}
	control, err := ReadControl(ctx, w.db, false)
	if err != nil || control.FailClosedReason != "source_profile_mapping_malformed" {
		t.Fatalf("malformed routing should fail closed, got %+v err=%v", control, err)
	}
}

// ReadControl must not borrow GAB's globally active profile for a draft source.
func TestReadControlLoadsSourceProfilesAndRejectsDraft(t *testing.T) {
	w := newIntentTestWorld(t)
	ctx := context.Background()
	body, err := os.ReadFile("../domain/testdata/gab_ladder_profile.json")
	if err != nil {
		t.Fatal(err)
	}
	var gab store.Document
	if err := json.Unmarshal(body, &gab); err != nil {
		t.Fatal(err)
	}
	gab["status"] = "active"
	if err := w.db.Put(ctx, "execution_profiles", "gab-ladder-w80-n1__v1", gab); err != nil {
		t.Fatal(err)
	}
	bills := store.Document{}
	for k, v := range gab {
		bills[k] = v
	}
	bills["status"] = "draft"
	if err := w.db.Put(ctx, "execution_profiles", "bills-observation-tp1__v1", bills); err != nil {
		t.Fatal(err)
	}
	settings := store.Document{
		"execution": map[string]any{"mode": "demo", "active_profile_doc_id": "gab-ladder-w80-n1__v1"},
		"trading":   map[string]any{"kill_switch": false},
		"migration": map[string]any{"replay_not_before": store.ISO(w.now)},
		"mt5": map[string]any{
			"source_chat_ids": []any{"-1003740937489"},
			"source_profile_doc_ids": map[string]any{
				"-1003740937489": "gab-ladder-w80-n1__v1",
				"-1003192025181": "bills-observation-tp1__v1",
			},
		},
	}
	if err := w.db.Put(ctx, "settings", "default", settings); err != nil {
		t.Fatal(err)
	}
	control, err := ReadControl(ctx, w.db, false)
	if err != nil || control.FailClosedReason != "" {
		t.Fatalf("control read failed: reason %s, err %v", control.FailClosedReason, err)
	}
	if got := control.ForChat("-1003740937489"); got.ActiveProfile == nil || len(got.ProfileErrors) != 0 {
		t.Fatalf("active GAB profile not selected: %+v", got)
	}
	if got := control.ForChat("-1003192025181"); got.ActiveProfile != nil || len(got.ProfileErrors) == 0 {
		t.Fatalf("Bills draft must fail closed: %+v", got)
	}
}
