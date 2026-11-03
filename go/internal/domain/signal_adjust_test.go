package domain

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

const instantBuy = "Gold BUY Now INSTANT📈\n\n@ 4010.5 - 4008\n\nTake Profit 1 - 4015\nTake Profit 2 - 4020\n\nStoploss - 4000\n\nplease use risk management"
const instantSell = "Forwarded from Example\n\nGold SELL Now INSTANT📈\n\n@ 4012- 4014.5\n\nTake Profit 1 - 4007\nTake Profit 2 - 4002\n\nStoploss - 4022\n\nplease use risk management"

func TestParseInstantTemplate(t *testing.T) {
	got := ParseGoldSignal(instantBuy)
	if !got.OK || got.Signal.Direction != Buy || got.Signal.OrderType != MarketOrder || got.Signal.EntryLow != 4008 || got.Signal.EntryHigh != 4010.5 ||
		got.Signal.StopLoss != 4000 || len(got.Signal.TakeProfits) != 2 || got.Signal.TakeProfits[1] != 4020 || got.Signal.Symbol != "XAUUSD" {
		t.Fatalf("buy template: %+v %+v", got, got.Signal)
	}
	got = ParseGoldSignal(instantSell)
	if !got.OK || got.Signal.Direction != Sell || got.Signal.EntryLow != 4012 || got.Signal.EntryHigh != 4014.5 || got.Signal.StopLoss != 4022 || got.Signal.TakeProfits[0] != 4007 {
		t.Fatalf("sell template: %+v %+v", got, got.Signal)
	}
	bad := ParseGoldSignal("Gold BUY Now INSTANT📈\n\n@ 4010.5 - 4008\n\nTake Profit 1 - 4015\n\nStoploss - 4012")
	if bad.OK || bad.Error != "invalid_sl_side" {
		t.Fatalf("stop above entry accepted: %+v", bad)
	}
	typo := ParseGoldSignal("Gold BUY Now INSTANT📈\n@ 4115 - 4107\nTake Profit 1 - 4122\nTake Profit 2 - 4118\nStoploss - 4105")
	if !typo.OK || len(typo.Signal.TakeProfits) != 1 || typo.Signal.TakeProfits[0] != 4122 {
		t.Fatalf("out-of-order later target not truncated: %+v", typo)
	}
	for _, text := range []string{
		"BOOOOM INSTANT 120PIPS ROCKET TO THE MOON + TP 2",
		"Gold BUY Now INSTANT📈 setup coming soon",
		"FIRST FAILED SETUP THIS MONTH\nREADY INSTANT RECOVERY",
	} {
		if r := ParseGoldSignal(text); r.OK {
			t.Fatalf("non-signal parsed: %q -> %+v", text, r.Signal)
		}
	}
	std := ParseGoldSignal("BUY XAUUSD\nENTRY 2000-2001\nSL 1990\nTP1 2010\nTP2 2020")
	if !std.OK || std.Signal.EntryLow != 2000 || std.Signal.StopLoss != 1990 {
		t.Fatalf("standard template changed: %+v", std)
	}
	if r := ParseGoldSignal("hello"); r.OK || r.Error != "missing_direction" {
		t.Fatalf("standard error not preserved: %+v", r)
	}
}

func gabLadderProfile(t *testing.T) ExecutionProfile {
	t.Helper()
	data, err := os.ReadFile("testdata/gab_ladder_profile.json")
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	checked := ValidateProfile(raw)
	if !checked.OK || checked.Value == nil {
		t.Fatalf("ladder profile invalid: %+v", checked.Errors)
	}
	if issues := ValidateProfileAgainstSafety(*checked.Value, DefaultSafetyLimits); len(issues) > 0 {
		t.Fatalf("ladder profile exceeds default safety: %+v", issues)
	}
	return *checked.Value
}

func TestProfileWidenAndDistanceTargets(t *testing.T) {
	p := gabLadderProfile(t)
	if p.StopLoss.WidenPrice != 8 || p.TakeProfit.DistanceStepPrice != 10 {
		t.Fatalf("new fields not decoded: %+v %+v", p.StopLoss, p.TakeProfit)
	}
	buy := ParseGoldSignal(instantBuy).Signal
	adj := ApplyProfileToSignal(*buy, p, 4010.7)
	if adj.StopLoss != 3992 || len(adj.TakeProfits) != MaxDistanceTargets || math.Abs(adj.TakeProfits[0]-4020.7) > 1e-9 || math.Abs(adj.TakeProfits[9]-4110.7) > 1e-9 {
		t.Fatalf("buy adjust: %+v", adj)
	}
	if buy.StopLoss != 4000 || len(buy.TakeProfits) != 2 {
		t.Fatalf("input signal modified: %+v", buy)
	}
	sell := ParseGoldSignal(instantSell).Signal
	adj = ApplyProfileToSignal(*sell, p, 4012)
	if adj.StopLoss != 4030 || math.Abs(adj.TakeProfits[0]-4002) > 1e-9 || math.Abs(adj.TakeProfits[9]-3912) > 1e-9 {
		t.Fatalf("sell adjust: %+v", adj)
	}
	plain := p
	plain.StopLoss.WidenPrice, plain.TakeProfit.DistanceStepPrice = 0, 0
	if got := ApplyProfileToSignal(*buy, plain, 4010.7); got.StopLoss != 4000 || len(got.TakeProfits) != 2 || got.TakeProfits[0] != 4015 {
		t.Fatalf("zero values must leave the signal alone: %+v", got)
	}
	plan := PlanCheckpoints(.01, Buy, 4010.7, ApplyProfileToSignal(*buy, p, 4010.7).TakeProfits, p.TakeProfit, SizingSpec{VolumeMin: .01, VolumeStep: .01})
	if !plan.OK || len(plan.Checkpoints) != 1 || plan.Checkpoints[0].TPIndex != 10 || math.Abs(plan.Checkpoints[0].Price-4110.7) > 1e-9 || plan.BrokerTP != 0 {
		t.Fatalf("plan: %+v", plan)
	}
}

func TestProfileRejectsBadNewFields(t *testing.T) {
	data, err := os.ReadFile("testdata/gab_ladder_profile.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(map[string]any){
		func(m map[string]any) { m["stop_loss"].(map[string]any)["widen_price"] = -1 },
		func(m map[string]any) { m["take_profit"].(map[string]any)["distance_step_price"] = "10" },
	} {
		var raw map[string]any
		if err := json.Unmarshal(data, &raw); err != nil {
			t.Fatal(err)
		}
		mutate(raw)
		if ValidateProfile(raw).OK {
			t.Fatalf("invalid new field accepted: %+v", raw)
		}
	}
}

func TestLadderStopManagement(t *testing.T) {
	p := gabLadderProfile(t)
	entry := 4010.7
	in := func(close, best, current float64, active bool) *StopLossDecision {
		return DesiredStopLoss(StopLossInput{LifecycleView: LifecycleView{Direction: Buy, Entry: entry, ClosePrice: close}, Profile: p, CurrentSL: current, BestPrice: best,
			BEApplied: active, TrailingActive: active, Digits: 2})
	}
	if d := in(4019, 4019, 3992, false); d != nil {
		t.Fatalf("stop moved before +10: %+v", d)
	}
	d := in(4020.8, 4020.8, 3992, false)
	if d == nil || math.Abs(d.SL-4017.8) > 1e-9 {
		t.Fatalf("at +10.1 want trail 4017.80 above breakeven: %+v", d)
	}
	if d := in(4019, 4025, 4017.8, true); d == nil || math.Abs(d.SL-4022) > 1e-9 {
		t.Fatalf("trail must follow the best price: %+v", d)
	}
}
