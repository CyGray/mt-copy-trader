package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/bytrader/bytrader/internal/broker"
	"github.com/bytrader/bytrader/internal/engine"
	"github.com/bytrader/bytrader/internal/store"
)

type timingBroker struct {
	broker.Broker
	entered chan time.Time
	release chan struct{}
	elapsed chan time.Duration
}

func (b *timingBroker) PlaceOrder(ctx context.Context, request broker.PlaceOrderRequest) (broker.PlaceOrderResult, error) {
	b.entered <- time.Now()
	select {
	case <-b.release:
	case <-ctx.Done():
		return broker.PlaceOrderResult{}, ctx.Err()
	}
	start := time.Now()
	result, err := b.Broker.PlaceOrder(ctx, request)
	b.elapsed <- time.Since(start)
	return result, err
}

func TestDurableQueueDispatchLatencyBreakdown(t *testing.T) {
	w := newPipeline(t)
	event := w.event("latency")
	adapter := &timingBroker{Broker: w.sim, entered: make(chan time.Time, 1), release: make(chan struct{}), elapsed: make(chan time.Duration, 1)}
	start := time.Now()
	inserted, err := w.db.PublishSignalEvent(context.Background(), event.EventID, store.Document{"chat_id": event.ChatID, "message_id": event.MessageID, "message_type": "new", "kind": "signal", "text_hash": "hash", "signal": event.Signal, "message_date": event.MessageDate, "created_at": store.ISO(start), "autotrader": map[string]any{"status": "pending", "attempts": 0, "updated_at": store.ISO(start), "history": []any{}}})
	if err != nil || !inserted {
		t.Fatalf("publish: %v %v", inserted, err)
	}
	published := time.Now()
	runner := engine.NewRunner(w.db, engine.Config{Owner: "latency-offline", BrokerForMode: func(context.Context, string) (broker.Broker, error) { return adapter, nil }})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("executor failed to stop")
		}
	}()
	var handoff time.Time
	select {
	case handoff = <-adapter.entered:
	case <-time.After(15 * time.Second):
		t.Fatalf("durable event not dispatched, readiness=%+v", runner.Readiness())
	}
	doc, err := w.db.Get(context.Background(), "signal_events", event.EventID)
	if err != nil {
		t.Fatal(err)
	}
	state := object(doc["autotrader"])
	claimed, err := time.Parse(time.RFC3339Nano, state["updated_at"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if state["status"] != "processing" {
		t.Fatal("broker handoff occurred without durable queue claim")
	}
	close(adapter.release)
	operation := <-adapter.elapsed
	deadline := time.Now().Add(3 * time.Second)
	for {
		doc, err = w.db.Get(context.Background(), "signal_events", event.EventID)
		if err != nil {
			t.Fatal(err)
		}
		if object(doc["autotrader"])["status"] == "done" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("event completion was not persisted")
		}
		time.Sleep(10 * time.Millisecond)
	}
	metrics := map[string]any{"workload": "one synthetic PAPER event; default 3-second poll; no MT5/Telegram", "publish_durable_ms": float64(published.Sub(start).Microseconds()) / 1000, "queue_wait_ms": float64(claimed.Sub(published).Microseconds()) / 1000, "claim_to_handoff_ms": float64(handoff.Sub(claimed).Microseconds()) / 1000, "simulated_broker_ms": float64(operation.Microseconds()) / 1000, "actual_broker_execution": "unverified"}
	data, err := json.Marshal(metrics)
	if err != nil {
		t.Fatal(err)
	}
	t.Log(string(data))
}
