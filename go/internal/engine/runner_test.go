package engine

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bytrader/bytrader/internal/broker"
	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
)

func TestRunKeepsProtectionActiveAfterStartupReconcileFailure(t *testing.T) {
	w := newIntentTestWorld(t)
	ctx := context.Background()
	profile := validMutationTestProfile(t)
	profile.BreakEven.Enabled = true
	profile.BreakEven.Trigger = "price_distance"
	profile.BreakEven.TriggerValue = .5
	profile.BreakEven.BufferPrice = .2
	profile.Limits.MaxConcurrentPositions = 10
	profile.Limits.MaxPositionsPerSymbol = 10

	openPosition := func(comment string) broker.Position {
		t.Helper()
		placed, err := w.sim.PlaceOrder(ctx, broker.PlaceOrderRequest{Symbol: "XAUUSD", OrderType: broker.MarketBuy, Volume: .03, SL: 1990, TP: 2020, Comment: comment})
		if err != nil {
			t.Fatal(err)
		}
		positions, err := w.sim.GetPositions(ctx, "XAUUSD")
		if err != nil {
			t.Fatal(err)
		}
		position := findPosition(positions, placed.PositionTicket, w.sim.Magic())
		if position == nil {
			t.Fatalf("market position %s not created: %+v", comment, positions)
		}
		return *position
	}
	protectedPosition := openPosition("BT-111111111111")
	unresolvedPosition := openPosition("BT-222222222222")
	if err := w.sim.SetQuote(ctx, "XAUUSD", 2002, 2002.2, w.now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := w.sim.Evaluate(ctx); err != nil {
		t.Fatal(err)
	}

	protected := w.trade(domain.TradeOpen, nil, &protectedPosition)
	protected.TradeSetID, protected.ChatID, protected.MessageID = "-100900_protected", "-100900", "protected"
	protected.CorrelationComment, protected.ProfileSnapshot = protectedPosition.Comment, &profile
	w.seedTrade(protected)

	unresolved := w.trade(domain.TradeOpen, nil, &unresolvedPosition)
	unresolved.TradeSetID, unresolved.ChatID, unresolved.MessageID = "-100900_unresolved", "-100900", "unresolved"
	unresolved.CorrelationComment, unresolved.ProfileSnapshot = unresolvedPosition.Comment, &profile
	unresolved.MutationIntent = &domain.MutationIntent{
		Action: "POSITION_MODIFY", Ticket: unresolvedPosition.Ticket, At: store.ISO(w.now), ExpiresAt: w.now.Unix() + 8,
		PriorSL: unresolvedPosition.SL, PriorTP: unresolvedPosition.TP,
		TargetSL: unresolvedPosition.SL + 1, TargetTP: unresolvedPosition.TP,
	}
	w.seedTrade(unresolved)

	settings := store.Document{
		"mt5":       map[string]any{"source_chat_ids": []any{"-100900"}},
		"migration": map[string]any{"replay_not_before": store.ISO(w.now.Add(-time.Hour))},
	}
	if err := w.db.Put(ctx, "settings", "default", settings); err != nil {
		t.Fatal(err)
	}
	event := domain.SignalEvent{
		EventID: "-100900_queued-entry_hash", ChatID: "-100900", MessageID: "queued-entry",
		MessageDate: store.ISO(w.now), MessageType: "new", Kind: "signal", TextHash: "hash",
		Signal: &domain.Signal{Symbol: "XAUUSD", Direction: domain.Buy, OrderType: domain.MarketOrder, EntryLow: 2002, EntryHigh: 2002.2, StopLoss: 1990, TakeProfits: []float64{2010, 2020, 2030}},
	}
	eventDoc, err := jsonDocument(event)
	if err != nil {
		t.Fatal(err)
	}
	eventDoc["created_at"] = store.ISO(w.now)
	eventDoc["autotrader"] = map[string]any{"status": "pending", "attempts": 0, "updated_at": store.ISO(w.now), "history": []any{}}
	if inserted, err := w.db.PublishSignalEvent(ctx, event.EventID, eventDoc); err != nil || !inserted {
		t.Fatalf("publish queued entry: inserted=%v err=%v", inserted, err)
	}

	safety := domain.DefaultSafetyLimits
	runner := NewRunner(w.db, Config{
		Now: func() time.Time { return w.now }, Owner: "startup-protection-test",
		EventPollInterval: 5 * time.Millisecond, LifecycleInterval: 5 * time.Millisecond,
		ReconcileInterval: 10 * time.Millisecond, AdminInterval: time.Hour,
		Controls: func(context.Context) (Control, error) {
			return Control{Mode: "paper", ActiveProfileDocID: "test-profile", ActiveProfile: &profile,
				Safety: &safety, ReplayNotBefore: store.ISO(w.now.Add(-time.Hour)), SourceChatIDs: []string{"-100900"}}, nil
		},
		BrokerForMode: func(context.Context, string) (broker.Broker, error) { return w.br, nil },
	})
	if err := runner.Reconcile(ctx); err == nil {
		t.Fatal("fixture did not produce an unresolved startup reconciliation")
	}

	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- runner.Run(runCtx) }()
	runExited := false
	defer func() {
		cancel()
		if runExited {
			return
		}
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("runner shutdown: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Error("runner did not stop after cancellation")
		}
	}()

	deadline := time.Now().Add(2 * time.Second)
	for {
		positions, err := w.sim.GetPositions(ctx, "XAUUSD")
		if err != nil {
			t.Fatal(err)
		}
		protectedAfter := findPosition(positions, protectedPosition.Ticket, w.sim.Magic())
		protectedDoc, readErr := w.db.Get(ctx, "trade_sets", protected.TradeSetID)
		if readErr != nil {
			t.Fatal(readErr)
		}
		lifecycle := object(protectedDoc["lifecycle"])
		if protectedAfter != nil && protectedAfter.SL >= protectedPosition.OpenPrice+.2-1e-9 && lifecycle["be_applied"] == true && protectedDoc["mutation_intent"] == nil {
			break
		}
		select {
		case err := <-done:
			runExited = true
			t.Fatalf("runner exited instead of keeping protection active: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("protective stop did not advance; readiness=%+v positions=%+v", runner.Readiness(), positions)
		}
		time.Sleep(5 * time.Millisecond)
	}

	if runner.Readiness().Ready {
		t.Fatalf("unresolved startup mutation incorrectly opened intake: %+v", runner.Readiness())
	}
	queueDoc, err := w.db.Get(ctx, "signal_events", event.EventID)
	if err != nil || object(queueDoc["autotrader"])["status"] != "pending" {
		t.Fatalf("queued entry changed before full reconciliation: status=%v err=%v", object(queueDoc["autotrader"])["status"], err)
	}
	if _, err := w.db.Get(ctx, "trade_sets", domain.TradeSetID(event.ChatID, event.MessageID)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("queue intake claimed or materialized an entry while not ready: err=%v", err)
	}
}
