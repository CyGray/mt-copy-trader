package domain

import (
	"math"
	"sort"

	"github.com/bytrader/bytrader/internal/broker"
)

type CheckpointAction string

const (
	CheckpointMarkDone  CheckpointAction = "mark_done"
	CheckpointSendClose CheckpointAction = "send_close"
	CheckpointWait      CheckpointAction = "wait"
	CheckpointNone      CheckpointAction = "none"
)

type StopReason string

const (
	StopAfterCheckpoint StopReason = "after_checkpoint"
	StopBreakEven       StopReason = "break_even"
	StopTrailing        StopReason = "trailing"
)

type CloseReason string

const (
	CloseSL     CloseReason = "sl"
	CloseTP     CloseReason = "tp"
	CloseManual CloseReason = "manual"
)

func RoundPrice(price float64, digits int) float64 { return roundFixed(price, digits) }

func IsCheckpointReached(direction Direction, closePrice, checkpointPrice float64) bool {
	if direction == Buy {
		return closePrice >= checkpointPrice
	}
	return closePrice <= checkpointPrice
}

func CheckpointDecision(cp CheckpointState, positionVolume, closePrice float64, direction Direction, nowSec int64, step float64) CheckpointAction {
	if cp.Status == "done" {
		return CheckpointNone
	}
	if positionVolume <= cp.TargetRemainingVolume+step/2 {
		return CheckpointMarkDone
	}
	if cp.Status == "failed" {
		return CheckpointNone
	}
	if cp.Status == "closing" && cp.PartialConfirmed {
		return CheckpointSendClose
	}
	if cp.Status == "closing" {
		return CheckpointWait
	}
	if !IsCheckpointReached(direction, closePrice, cp.Price) {
		return CheckpointNone
	}
	if cp.Status == "pending" || cp.Status == "closing" {
		return CheckpointSendClose
	}
	return CheckpointNone
}

func CloseVolumeFor(positionVolume, targetRemaining, step float64) (float64, bool) {
	if targetRemaining <= 0 {
		return positionVolume, true
	}
	return RoundVolumeDown(positionVolume-targetRemaining, step), false
}

type LifecycleView struct {
	Direction   Direction
	Entry       float64
	ClosePrice  float64
	Checkpoints []CheckpointState
}

func tpDone(cps []CheckpointState, index int) bool {
	for _, cp := range cps {
		if cp.TPIndex == index && cp.Status == "done" {
			return true
		}
	}
	return false
}

func distanceReached(view LifecycleView, distance float64) bool {
	if view.Direction == Buy {
		return view.ClosePrice-view.Entry >= distance
	}
	return view.Entry-view.ClosePrice >= distance
}

func BreakEvenTriggered(view LifecycleView, profile ExecutionProfile) bool {
	be := profile.BreakEven
	if !be.Enabled {
		return false
	}
	if be.Trigger == "price_distance" {
		return distanceReached(view, be.TriggerValue)
	}
	return tpDone(view.Checkpoints, int(be.TriggerValue))
}

func TrailingActivated(view LifecycleView, profile ExecutionProfile) bool {
	tr := profile.Trailing
	if !tr.Enabled {
		return false
	}
	if tr.Activation == "price_distance" {
		return distanceReached(view, tr.ActivationValue)
	}
	return tpDone(view.Checkpoints, int(tr.ActivationValue))
}

func ReplanCheckpoints(direction Direction, entryPrice, filledVolume float64, profile ExecutionProfile, spec SizingSpec, checkpoints []CheckpointState) []CheckpointState {
	maxIndex := 0
	for _, cp := range profile.TakeProfit.Checkpoints {
		if cp.TPIndex > maxIndex {
			maxIndex = cp.TPIndex
		}
	}
	for _, cp := range checkpoints {
		if cp.TPIndex > maxIndex {
			maxIndex = cp.TPIndex
		}
	}
	tps := make([]float64, maxIndex)
	for i := range tps {
		tps[i] = math.NaN()
	}
	for _, cp := range checkpoints {
		if cp.TPIndex > 0 && cp.TPIndex <= len(tps) {
			tps[cp.TPIndex-1] = cp.Price
		}
	}
	plan := PlanCheckpoints(filledVolume, direction, entryPrice, tps, profile.TakeProfit, spec)
	if !plan.OK {
		return nil
	}
	out := make([]CheckpointState, len(plan.Checkpoints))
	for i, cp := range plan.Checkpoints {
		out[i] = CheckpointState{TPIndex: cp.TPIndex, Price: cp.Price, CloseVolume: cp.CloseVolume, TargetRemainingVolume: cp.TargetRemainingVolume, Status: "pending", Attempts: 0}
	}
	return out
}

func FillCheckpoints(direction Direction, entryPrice, filledVolume float64, plannedVolume *float64, profile ExecutionProfile, spec SizingSpec, checkpoints []CheckpointState) []CheckpointState {
	if plannedVolume == nil || math.Abs(filledVolume-*plannedVolume) <= spec.VolumeStep/2 {
		return append([]CheckpointState(nil), checkpoints...)
	}
	return ReplanCheckpoints(direction, entryPrice, filledVolume, profile, spec, checkpoints)
}

type StopLossInput struct {
	LifecycleView
	Profile        ExecutionProfile
	CurrentSL      float64
	BestPrice      float64
	BEApplied      bool
	TrailingActive bool
	Digits         int
}

type StopLossDecision struct {
	SL      float64      `json:"sl"`
	Reasons []StopReason `json:"reasons"`
}

func DesiredStopLoss(input StopLossInput) *StopLossDecision {
	direction, entry, p := input.Direction, input.Entry, input.Profile
	buy := direction == Buy
	candidates := []struct {
		reason StopReason
		sl     float64
	}{}
	ordered := append([]CheckpointState(nil), input.Checkpoints...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].TPIndex < ordered[j].TPIndex })
	for _, rule := range p.StopLoss.AfterCheckpoint {
		if !tpDone(input.Checkpoints, rule.AfterTPIndex) {
			continue
		}
		if rule.MoveTo == "entry" {
			sl := entry - rule.BufferPrice
			if buy {
				sl = entry + rule.BufferPrice
			}
			candidates = append(candidates, struct {
				reason StopReason
				sl     float64
			}{StopAfterCheckpoint, sl})
			continue
		}
		idx := -1
		for i, cp := range ordered {
			if cp.TPIndex == rule.AfterTPIndex {
				idx = i
				break
			}
		}
		if idx < 0 {
			continue
		}
		if idx == 0 {
			sl := entry - rule.BufferPrice
			if buy {
				sl = entry + rule.BufferPrice
			}
			candidates = append(candidates, struct {
				reason StopReason
				sl     float64
			}{StopAfterCheckpoint, sl})
			continue
		}
		level := ordered[idx-1].Price
		sl := level + rule.BufferPrice
		if buy {
			sl = level - rule.BufferPrice
		}
		candidates = append(candidates, struct {
			reason StopReason
			sl     float64
		}{StopAfterCheckpoint, sl})
	}
	if input.BEApplied || BreakEvenTriggered(input.LifecycleView, p) {
		sl := entry - p.BreakEven.BufferPrice
		if buy {
			sl = entry + p.BreakEven.BufferPrice
		}
		candidates = append(candidates, struct {
			reason StopReason
			sl     float64
		}{StopBreakEven, sl})
	}
	if p.Trailing.Enabled && (input.TrailingActive || TrailingActivated(input.LifecycleView, p)) {
		sl := input.BestPrice + p.Trailing.DistancePrice
		if buy {
			sl = input.BestPrice - p.Trailing.DistancePrice
		}
		candidates = append(candidates, struct {
			reason StopReason
			sl     float64
		}{StopTrailing, sl})
	}
	if len(candidates) == 0 {
		return nil
	}
	chosen := RoundPrice(candidates[0].sl, input.Digits)
	rounded := make([]struct {
		reason StopReason
		sl     float64
	}, len(candidates))
	for i, c := range candidates {
		rounded[i] = struct {
			reason StopReason
			sl     float64
		}{c.reason, RoundPrice(c.sl, input.Digits)}
		if buy && rounded[i].sl > chosen || !buy && rounded[i].sl < chosen {
			chosen = rounded[i].sl
		}
	}
	if !(chosen > 0) {
		return nil
	}
	tightens := input.CurrentSL <= 0 || buy && chosen > input.CurrentSL+1e-9 || !buy && chosen < input.CurrentSL-1e-9
	if !tightens {
		return nil
	}
	reasons := []StopReason{}
	for _, c := range rounded {
		if c.sl == chosen && !hasStopReason(reasons, c.reason) {
			reasons = append(reasons, c.reason)
		}
	}
	if len(reasons) == 1 && reasons[0] == StopTrailing && input.CurrentSL > 0 {
		improvement := chosen - input.CurrentSL
		if !buy {
			improvement = input.CurrentSL - chosen
		}
		if improvement+1e-9 < p.Trailing.StepPrice {
			return nil
		}
	}
	return &StopLossDecision{SL: chosen, Reasons: reasons}
}

func hasStopReason(values []StopReason, wanted StopReason) bool {
	for _, v := range values {
		if v == wanted {
			return true
		}
	}
	return false
}

func IsStopModificationValid(direction Direction, newSL, bid, ask, stopsLevelPoints, freezeLevelPoints, point float64) bool {
	if !(newSL > 0) || !(point > 0) {
		return false
	}
	minDistance := math.Max(stopsLevelPoints, freezeLevelPoints) * point
	if direction == Buy {
		return newSL < bid-minDistance
	}
	return newSL > ask+minDistance
}

func UpdateBestPrice(direction Direction, best, closePrice float64) float64 {
	if !(best > 0) {
		return closePrice
	}
	if direction == Buy {
		return math.Max(best, closePrice)
	}
	return math.Min(best, closePrice)
}

func LastExitDeal(deals []broker.Deal) *broker.Deal {
	exits := []broker.Deal{}
	for _, d := range deals {
		if d.Entry == "OUT" || d.Entry == "OUT_BY" {
			exits = append(exits, d)
		}
	}
	if len(exits) == 0 {
		return nil
	}
	sort.Slice(exits, func(i, j int) bool {
		if exits[i].Time == exits[j].Time {
			return exits[i].Ticket < exits[j].Ticket
		}
		return exits[i].Time < exits[j].Time
	})
	return &exits[len(exits)-1]
}

func ClassifyCloseReason(deals []broker.Deal) CloseReason {
	last := LastExitDeal(deals)
	if last == nil {
		return CloseManual
	}
	if last.Reason == "SL" {
		return CloseSL
	}
	if last.Reason == "TP" {
		return CloseTP
	}
	return CloseManual
}

func RealizedPnLFromDeals(deals []broker.Deal) float64 {
	total := 0.0
	for _, d := range deals {
		if d.Entry == "OUT" || d.Entry == "OUT_BY" {
			total += d.Profit + d.Commission + d.Swap + d.Fee
		}
	}
	return math.Floor(total*100+0.5) / 100
}
