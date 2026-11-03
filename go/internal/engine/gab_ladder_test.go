package engine

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"testing"
	"time"

	"github.com/bytrader/bytrader/internal/broker"
	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
)

func TestPrepareAppliesWidenedStopAndDistanceTargets(t *testing.T) {
	w := newIntentTestWorld(t)
	data, err := os.ReadFile("../domain/testdata/gab_ladder_profile.json")
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	checked := domain.ValidateProfile(raw)
	if !checked.OK || checked.Value == nil {
		t.Fatalf("profile invalid: %+v", checked.Errors)
	}
	profile := *checked.Value
	safety := domain.DefaultSafetyLimits
	control := Control{Mode: "paper", ActiveProfileDocID: "gab-ladder-w80-n1__v1", ActiveProfile: &profile, Safety: &safety}
	signal := domain.Signal{Symbol: "XAUUSD", Direction: domain.Buy, OrderType: domain.MarketOrder, EntryLow: 1999, EntryHigh: 2000.5, StopLoss: 1988, TakeProfits: []float64{2005, 2010}}
	event := domain.SignalEvent{EventID: "gab-1", ChatID: "-100900", MessageID: "5", MessageDate: store.ISO(w.now), Kind: "signal", Signal: &signal}
	runner := NewRunner(w.db, Config{Now: func() time.Time { return w.now }, MaxQuoteAge: time.Minute, BrokerForMode: func(context.Context, string) (broker.Broker, error) { return w.sim, nil }})
	p, refused, err := runner.prepare(context.Background(), event, control, "gab-test", "BT-123456789abc")
	if err != nil || refused != nil {
		t.Fatalf("refused=%+v err=%v", refused, err)
	}
	if p.request.SL != 1980 || p.sl != 1980 || p.request.TP != 0 || p.request.Volume != .01 || p.request.OrderType != broker.MarketBuy {
		t.Fatalf("request: %+v sl=%v", p.request, p.sl)
	}
	if len(p.checkpoints) != 1 || p.checkpoints[0].TPIndex != 10 || math.Abs(p.checkpoints[0].Price-(p.decision.EntryRefPrice+100)) > 1e-9 {
		t.Fatalf("checkpoints: %+v ref=%v", p.checkpoints, p.decision.EntryRefPrice)
	}
	if signal.StopLoss != 1988 || len(signal.TakeProfits) != 2 {
		t.Fatalf("event signal modified: %+v", signal)
	}
	far := signal
	far.StopLoss = 1960
	event.Signal, event.EventID = &far, "gab-2"
	if _, refused, err := runner.prepare(context.Background(), event, control, "gab-test-2", "BT-223456789abc"); err != nil || refused == nil || refused.reason != "sl_too_far" {
		t.Fatalf("widened stop beyond max distance was not refused: refused=%+v err=%v", refused, err)
	}
}
