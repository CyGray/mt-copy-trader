package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/bytrader/bytrader/internal/broker"
	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/engine"
	"github.com/bytrader/bytrader/internal/store"
)

const pipelineChat = "-10012345"
const crashMarker = "isolated-crash-after-handoff"

type pipelineWorld struct {
	t         *testing.T
	db        *store.SQLiteStore
	path      string
	now       time.Time
	sim       *broker.SimulatedBroker
	profileID string
}

func newPipeline(t *testing.T) *pipelineWorld {
	t.Helper()
	t.Setenv("ALERT_NOTIFICATIONS", "disabled")
	w := &pipelineWorld{t: t, path: filepath.Join(t.TempDir(), "state.sqlite"), now: time.Now().UTC().Truncate(time.Millisecond)}
	var err error
	w.db, err = store.Open(w.path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.db.Close() })
	data, err := os.ReadFile("../../docs/project_memory/examples/optimal_report_profile.example.json")
	if err != nil {
		t.Fatal(err)
	}
	var profile store.Document
	if err = json.Unmarshal(data, &profile); err != nil {
		t.Fatal(err)
	}
	profile["entry"].(map[string]any)["policy"] = "market_only"
	profile["sizing"] = map[string]any{"mode": "fixed_lots", "fixed_lots": .03, "below_min_volume": "skip"}
	profile["status"] = "active"
	w.profileID = fmt.Sprint(profile["profile_id"]) + "__v1"
	if err = w.db.Put(context.Background(), "execution_profiles", w.profileID, profile); err != nil {
		t.Fatal(err)
	}
	if err = w.db.Put(context.Background(), "settings", "default", store.Document{"execution": map[string]any{"mode": "paper", "active_profile_doc_id": w.profileID}, "trading": map[string]any{"kill_switch": false}, "mt5": map[string]any{"source_chat_ids": []string{pipelineChat}}, "safety": domain.DefaultSafetyLimits, "migration": map[string]any{"replay_not_before": store.ISO(w.now.Add(-time.Hour))}}); err != nil {
		t.Fatal(err)
	}
	w.makeSim()
	return w
}

func (w *pipelineWorld) makeSim() {
	spec, err := offlineGoldSpec(context.Background(), "XAUUSD")
	if err != nil {
		w.t.Fatal(err)
	}
	spec.TickTimeMsc = w.now.UnixMilli()
	w.sim, err = broker.NewSimulated(context.Background(), broker.SimulatedOptions{Magic: 98801, Symbols: map[string]broker.SymbolInfo{"XAUUSD": spec}, Persistence: paperPersistence{w.db}, Now: func() time.Time { return w.now }, MaxQuoteAge: time.Minute})
	if err != nil {
		w.t.Fatal(err)
	}
}

func (w *pipelineWorld) runner(adapter broker.Broker) *engine.Runner {
	return engine.NewRunner(w.db, engine.Config{Now: func() time.Time { return w.now }, Owner: "offline-pipeline", BrokerForMode: func(context.Context, string) (broker.Broker, error) { return adapter, nil }})
}
func (w *pipelineWorld) event(id string) domain.SignalEvent {
	return domain.SignalEvent{EventID: pipelineChat + "_" + id + "_hash", ChatID: pipelineChat, MessageID: id, MessageDate: store.ISO(w.now), MessageType: "new", Kind: "signal", Signal: &domain.Signal{Symbol: "XAUUSD", Direction: "buy", OrderType: "market", EntryLow: 2000, EntryHigh: 2001, StopLoss: 1990, TakeProfits: []float64{2010, 2020, 2030}}}
}
func (w *pipelineWorld) trade(id string) store.Document {
	w.t.Helper()
	doc, err := w.db.Get(context.Background(), "trade_sets", pipelineChat+"_"+id)
	if err != nil {
		w.t.Fatal(err)
	}
	return doc
}
func (w *pipelineWorld) restart() {
	w.t.Helper()
	if err := w.db.Close(); err != nil {
		w.t.Fatal(err)
	}
	var err error
	w.db, err = store.Open(w.path)
	if err != nil {
		w.t.Fatal(err)
	}
	w.makeSim()
}

type intentBroker struct {
	broker.Broker
	world                                              *pipelineWorld
	id                                                 string
	entryCalls, closeCalls                             int
	crashBeforeEntry, crashAfterEntry, crashAfterClose bool
}

func (b *intentBroker) PlaceOrder(ctx context.Context, request broker.PlaceOrderRequest) (broker.PlaceOrderResult, error) {
	b.entryCalls++
	if b.world.trade(b.id)["state"] != "SUBMITTING" {
		b.world.t.Fatal("broker send preceded durable submit intent")
	}
	if b.crashBeforeEntry {
		panic(crashMarker)
	}
	result, err := b.Broker.PlaceOrder(ctx, request)
	if err == nil && b.crashAfterEntry {
		panic(crashMarker)
	}
	return result, err
}
func (b *intentBroker) ClosePosition(ctx context.Context, ticket int64, volume *float64) (broker.CloseResult, error) {
	b.closeCalls++
	if volume == nil || *volume <= 0 || *volume >= .03 {
		b.world.t.Fatalf("checkpoint sent target remaining instead of computed relative close amount: %v", volume)
	}
	lifecycle := object(b.world.trade(b.id)["lifecycle"])
	found := false
	for _, raw := range lifecycle["checkpoints"].([]any) {
		if object(raw)["status"] == "closing" {
			found = true
		}
	}
	if !found {
		b.world.t.Fatal("checkpoint mutation preceded durable closing intent")
	}
	result, err := b.Broker.ClosePosition(ctx, ticket, volume)
	if err == nil && b.crashAfterClose {
		panic(crashMarker)
	}
	return result, err
}
func expectCrash(t *testing.T, run func()) {
	t.Helper()
	defer func() {
		if value := recover(); value != crashMarker {
			t.Fatalf("expected isolated crash marker, got %v", value)
		}
	}()
	run()
	t.Fatal("crash injection did not run")
}

func TestCutoverReplayBarrierExcludesEqualSourceTimestamp(t *testing.T) {
	for _, offset := range []time.Duration{0, time.Second} {
		t.Run(offset.String(), func(t *testing.T) {
			w := newPipeline(t)
			ctx := context.Background()
			settings, err := w.db.Get(ctx, "settings", "default")
			if err != nil {
				t.Fatal(err)
			}
			settings["migration"] = map[string]any{"replay_not_before": store.ISO(w.now)}
			if err := w.db.Put(ctx, "settings", "default", settings); err != nil {
				t.Fatal(err)
			}
			w.now = w.now.Add(offset)
			adapter := &intentBroker{Broker: w.sim, world: w, id: "boundary"}
			result := w.runner(adapter).HandleEvent(ctx, w.event("boundary"))
			if offset == 0 {
				if adapter.entryCalls != 0 || result.Reason != "before_replay_barrier" {
					t.Fatalf("equal timestamp passed replay barrier: calls=%d result=%+v", adapter.entryCalls, result)
				}
			} else if adapter.entryCalls != 1 {
				t.Fatalf("new source message was blocked: %+v", result)
			}
		})
	}
}

func TestCrashAfterIntentAndAfterSuccessfulEntry(t *testing.T) {
	for _, sent := range []bool{false, true} {
		t.Run(fmt.Sprint("externally_sent=", sent), func(t *testing.T) {
			w := newPipeline(t)
			adapter := &intentBroker{Broker: w.sim, world: w, id: "1", crashBeforeEntry: !sent, crashAfterEntry: sent}
			expectCrash(t, func() { w.runner(adapter).HandleEvent(context.Background(), w.event("1")) })
			if w.trade("1")["state"] != "SUBMITTING" {
				t.Fatal("crash lost durable intent")
			}
			w.now = w.now.Add(3 * time.Minute)
			w.restart()
			restarted := &intentBroker{Broker: w.sim, world: w, id: "1"}
			runner := w.runner(restarted)
			if err := runner.Reconcile(context.Background()); err != nil {
				t.Fatal(err)
			}
			result := runner.HandleEvent(context.Background(), w.event("1"))
			if restarted.entryCalls != 0 {
				t.Fatal("recovery blindly resubmitted entry")
			}
			positions, err := w.sim.GetPositions(context.Background(), "")
			if err != nil {
				t.Fatal(err)
			}
			if sent {
				if len(positions) != 1 || w.trade("1")["state"] != "OPEN" {
					t.Fatalf("exact correlation did not recover successful send: %v %v", w.trade("1")["state"], result)
				}
			} else if len(positions) != 0 || w.trade("1")["state"] == "OPEN" {
				t.Fatal("unsent intent became a position")
			}
		})
	}
}

func TestCheckpointCrashRecoveryAndFrozenProtectionWithKillSwitch(t *testing.T) {
	w := newPipeline(t)
	adapter := &intentBroker{Broker: w.sim, world: w, id: "1", crashAfterClose: true}
	runner := w.runner(adapter)
	if result := runner.HandleEvent(context.Background(), w.event("1")); result.State != "OPEN" {
		t.Fatalf("entry failed: %+v", result)
	}
	if err := w.db.Put(context.Background(), "settings", "default", store.Document{"execution": map[string]any{"mode": "disabled", "active_profile_doc_id": "missing-new-profile"}, "trading": map[string]any{"kill_switch": true}, "mt5": map[string]any{"source_chat_ids": []string{pipelineChat}}}); err != nil {
		t.Fatal(err)
	}
	if err := w.sim.SetQuote(context.Background(), "XAUUSD", 2010.2, 2010.4, w.now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	expectCrash(t, func() { _ = runner.Tick(context.Background()) })
	positions, err := w.sim.GetPositions(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(positions) != 1 || positions[0].Volume != .02 {
		t.Fatalf("checkpoint relative close result: %v", positions)
	}
	w.restart()
	restarted := &intentBroker{Broker: w.sim, world: w, id: "1"}
	runner = w.runner(restarted)
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := runner.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if restarted.closeCalls != 0 {
		t.Fatal("recovery closed the checkpoint twice")
	}
	positions, err = w.sim.GetPositions(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(positions) != 1 || positions[0].Volume != .02 {
		t.Fatalf("frozen checkpoint remaining volume changed: %v", positions)
	}
	if result := runner.HandleEvent(context.Background(), w.event("2")); result.Outcome != "skipped" {
		t.Fatalf("disabled/kill switch allowed a new entry: %+v", result)
	}
}
