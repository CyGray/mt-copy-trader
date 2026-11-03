package domain

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

const volumeEpsilon = 1e-9

type SizingSpec struct {
	TickSize      float64 `json:"tickSize"`
	TickValueLoss float64 `json:"tickValueLoss"`
	VolumeMin     float64 `json:"volumeMin"`
	VolumeMax     float64 `json:"volumeMax"`
	VolumeStep    float64 `json:"volumeStep"`
}

type SizingResult struct {
	OK          bool    `json:"ok"`
	Volume      float64 `json:"volume,omitempty"`
	RiskMoney   float64 `json:"riskMoney,omitempty"`
	RiskPercent float64 `json:"riskPercent,omitempty"`
	ClampedBy   string  `json:"clampedBy,omitempty"`
	Reason      string  `json:"reason,omitempty"`
	Detail      string  `json:"detail,omitempty"`
}

func (r SizingResult) MarshalJSON() ([]byte, error) {
	if r.OK {
		return json.Marshal(struct {
			OK          bool    `json:"ok"`
			Volume      float64 `json:"volume"`
			RiskMoney   float64 `json:"riskMoney"`
			RiskPercent float64 `json:"riskPercent"`
			ClampedBy   string  `json:"clampedBy,omitempty"`
		}{true, r.Volume, r.RiskMoney, r.RiskPercent, r.ClampedBy})
	}
	return json.Marshal(struct {
		OK     bool   `json:"ok"`
		Reason string `json:"reason"`
		Detail string `json:"detail"`
	}{false, r.Reason, r.Detail})
}

func VolumeDecimals(step float64) int {
	for d := 0; d <= 8; d++ {
		scaled := step * math.Pow10(d)
		if math.Abs(scaled-math.Round(scaled)) < 1e-9 {
			return d
		}
	}
	return 8
}

func RoundVolumeDown(volume, step float64) float64 {
	units := math.Floor(volume/step + volumeEpsilon)
	return roundFixed(units*step, VolumeDecimals(step))
}

func RiskPerLot(entry, stopLoss float64, spec SizingSpec) float64 {
	return math.Abs(entry-stopLoss) / spec.TickSize * spec.TickValueLoss
}

func ComputeVolume(sizing SizingConfig, entryPrice, stopLoss, equity float64, spec SizingSpec, limits EffectiveLimits) SizingResult {
	fail := func(reason, detail string) SizingResult { return SizingResult{Reason: reason, Detail: detail} }
	positive := func(v float64) bool { return v > 0 && finite(v) }
	if !positive(spec.TickSize) || !positive(spec.TickValueLoss) || !positive(spec.VolumeMin) || !positive(spec.VolumeMax) || !positive(spec.VolumeStep) || spec.VolumeMax < spec.VolumeMin {
		return fail("invalid_symbol_spec", "symbol spec has non-positive or inconsistent volume/tick values")
	}
	distance := math.Abs(entryPrice - stopLoss)
	if !finite(distance) || distance <= 0 {
		return fail("invalid_stop_distance", fmt.Sprintf("entry %s and stop %s must differ", formatNum(entryPrice), formatNum(stopLoss)))
	}
	if !positive(equity) {
		return fail("invalid_equity", fmt.Sprintf("equity must be > 0 (got %s)", formatNum(equity)))
	}
	perLot := RiskPerLot(entryPrice, stopLoss, spec)
	cap := math.Min(limits.MaxRiskMoney, equity*limits.MaxRiskPercent/100)
	maxVolume := math.Min(spec.VolumeMax, limits.MaxLots)
	step := spec.VolumeStep
	var volume float64
	clampedBy := ""
	if sizing.Mode == FixedLots {
		if sizing.FixedLots == nil || !positive(*sizing.FixedLots) {
			return fail("missing_sizing_value", "sizing.fixed_lots must be > 0 for mode fixed_lots")
		}
		lots := *sizing.FixedLots
		units := lots / step
		if math.Abs(units-math.Round(units)) > volumeEpsilon {
			return fail("volume_not_step_aligned", fmt.Sprintf("fixed_lots %s is not a multiple of volume step %s", formatNum(lots), formatNum(step)))
		}
		volume = RoundVolumeDown(lots, step)
		if volume > maxVolume+volumeEpsilon {
			return fail("volume_exceeds_max", fmt.Sprintf("fixed_lots %s exceeds max %s (min of volumeMax %s and maxLots %s)", formatNum(lots), formatNum(maxVolume), formatNum(spec.VolumeMax), formatNum(limits.MaxLots)))
		}
	} else {
		var target float64
		if sizing.Mode == FixedRiskMoney {
			if sizing.RiskMoney == nil || !positive(*sizing.RiskMoney) {
				return fail("missing_sizing_value", "sizing.risk_money must be > 0 for mode fixed_risk_money")
			}
			target = *sizing.RiskMoney
		} else {
			if sizing.RiskPercent == nil || !positive(*sizing.RiskPercent) {
				return fail("missing_sizing_value", "sizing.risk_percent must be > 0 for mode equity_risk_percent")
			}
			target = equity * *sizing.RiskPercent / 100
		}
		volume = RoundVolumeDown(math.Min(target, cap)/perLot, step)
		if volume > maxVolume+volumeEpsilon {
			volume = RoundVolumeDown(maxVolume, step)
			if spec.VolumeMax <= limits.MaxLots {
				clampedBy = "volume_max"
			} else {
				clampedBy = "max_lots"
			}
		}
	}
	if volume+volumeEpsilon < spec.VolumeMin {
		canUseMin := sizing.BelowMinVolume == "use_min_if_within_cap" && spec.VolumeMin <= maxVolume+volumeEpsilon && perLot*spec.VolumeMin <= cap+volumeEpsilon
		if !canUseMin {
			return fail("volume_below_min", fmt.Sprintf("volume %s below min %s (policy %s)", formatNum(volume), formatNum(spec.VolumeMin), sizing.BelowMinVolume))
		}
		volume, clampedBy = spec.VolumeMin, ""
	}
	riskMoney := volume * perLot
	if riskMoney > cap+volumeEpsilon {
		return fail("risk_exceeds_limit", fmt.Sprintf("risk %.2f exceeds cap %.2f", riskMoney, cap))
	}
	return SizingResult{OK: true, Volume: volume, RiskMoney: riskMoney, RiskPercent: riskMoney / equity * 100, ClampedBy: clampedBy}
}

type CheckpointPlanResult struct {
	OK          bool                `json:"ok"`
	Checkpoints []PlannedCheckpoint `json:"checkpoints,omitempty"`
	BrokerTP    float64             `json:"brokerTp,omitempty"`
	Warnings    []string            `json:"warnings,omitempty"`
	Reason      string              `json:"reason,omitempty"`
	Detail      string              `json:"detail,omitempty"`
}

func (r CheckpointPlanResult) MarshalJSON() ([]byte, error) {
	if r.OK {
		return json.Marshal(struct {
			OK          bool                `json:"ok"`
			Checkpoints []PlannedCheckpoint `json:"checkpoints"`
			BrokerTP    float64             `json:"brokerTp"`
			Warnings    []string            `json:"warnings"`
		}{true, r.Checkpoints, r.BrokerTP, r.Warnings})
	}
	return json.Marshal(struct {
		OK     bool   `json:"ok"`
		Reason string `json:"reason"`
		Detail string `json:"detail"`
	}{false, r.Reason, r.Detail})
}

type checkpointCandidate struct {
	index          int
	price, percent float64
}

func PlanCheckpoints(totalVolume float64, direction Direction, entryPrice float64, takeProfits []float64, cfg TakeProfitConfig, spec SizingSpec) CheckpointPlanResult {
	warnings := []string{}
	candidates := make([]checkpointCandidate, 0, len(cfg.Checkpoints))
	missing := []int{}
	for _, cp := range cfg.Checkpoints {
		idx := cp.TPIndex - 1
		if idx < 0 || idx >= len(takeProfits) || !finite(takeProfits[idx]) {
			missing = append(missing, cp.TPIndex)
		} else {
			candidates = append(candidates, checkpointCandidate{cp.TPIndex, takeProfits[idx], cp.ClosePercent})
		}
	}
	if len(missing) > 0 {
		if cfg.MissingTP == "skip_trade" || len(candidates) == 0 {
			parts := make([]string, len(missing))
			for i, n := range missing {
				parts[i] = fmt.Sprintf("TP%d", n)
			}
			return CheckpointPlanResult{Reason: "tp_missing", Detail: "missing take profit(s): " + strings.Join(parts, ", ")}
		}
		folded := 0.0
		missingSet := map[int]bool{}
		for _, n := range missing {
			missingSet[n] = true
		}
		for _, cp := range cfg.Checkpoints {
			if missingSet[cp.TPIndex] {
				folded += cp.ClosePercent
			}
		}
		last := len(candidates) - 1
		candidates[last].percent += folded
		parts := make([]string, len(missing))
		for i, n := range missing {
			parts[i] = fmt.Sprintf("TP%d", n)
		}
		warnings = append(warnings, fmt.Sprintf("%s missing; %s%% merged into TP%d", strings.Join(parts, ", "), formatNum(folded), candidates[last].index))
	}
	for i, cp := range candidates {
		beyond := direction == Buy && cp.price > entryPrice || direction == Sell && cp.price < entryPrice
		if !beyond {
			return CheckpointPlanResult{Reason: "tp_order_invalid", Detail: fmt.Sprintf("TP%d %s is not beyond entry %s for %s", cp.index, formatNum(cp.price), formatNum(entryPrice), direction)}
		}
		if i > 0 {
			prev := candidates[i-1].price
			monotonic := direction == Buy && cp.price > prev || direction == Sell && cp.price < prev
			if !monotonic {
				return CheckpointPlanResult{Reason: "tp_order_invalid", Detail: fmt.Sprintf("TP%d %s is not beyond TP%d %s", cp.index, formatNum(cp.price), candidates[i-1].index, formatNum(prev))}
			}
		}
	}
	if !(totalVolume > 0) || !finite(totalVolume) || totalVolume+volumeEpsilon < spec.VolumeMin {
		return CheckpointPlanResult{Reason: "tp_split_infeasible", Detail: fmt.Sprintf("total volume %s below min %s", formatNum(totalVolume), formatNum(spec.VolumeMin))}
	}
	for {
		closes, remaining := splitVolumes(totalVolume, candidates, spec.VolumeStep)
		bad := firstUndersized(closes, remaining, spec.VolumeMin)
		if bad < 0 {
			out := make([]PlannedCheckpoint, len(candidates))
			for i, cp := range candidates {
				target := remaining[i]
				if i == len(candidates)-1 {
					target = 0
				}
				out[i] = PlannedCheckpoint{TPIndex: cp.index, Price: cp.price, ClosePercent: cp.percent, CloseVolume: closes[i], TargetRemainingVolume: roundFixed(target, VolumeDecimals(spec.VolumeStep))}
			}
			brokerTP := 0.0
			if cfg.BrokerTP == "final_checkpoint" {
				brokerTP = candidates[len(candidates)-1].price
			}
			return CheckpointPlanResult{OK: true, Checkpoints: out, BrokerTP: brokerTP, Warnings: warnings}
		}
		if cfg.InfeasibleSplit == "skip_trade" || len(candidates) == 1 {
			return CheckpointPlanResult{Reason: "tp_split_infeasible", Detail: fmt.Sprintf("TP%d split below volume min %s for total %s", candidates[bad].index, formatNum(spec.VolumeMin), formatNum(totalVolume))}
		}
		target := bad + 1
		if bad == len(candidates)-1 {
			target = bad - 1
		}
		removed, receiver := candidates[bad], candidates[target]
		candidates[target].percent += removed.percent
		candidates = append(candidates[:bad], candidates[bad+1:]...)
		warnings = append(warnings, fmt.Sprintf("TP%d split infeasible; merged %s%% into TP%d", removed.index, formatNum(removed.percent), receiver.index))
	}
}

func splitVolumes(total float64, candidates []checkpointCandidate, step float64) ([]float64, []float64) {
	closes := make([]float64, len(candidates))
	remaining := make([]float64, len(candidates))
	allocated, left := 0.0, total
	for i, cp := range candidates {
		close := RoundVolumeDown(total*cp.percent/100, step)
		if i == len(candidates)-1 {
			close = roundFixed(total-allocated, VolumeDecimals(step))
		}
		closes[i] = close
		allocated += close
		left = roundFixed(left-close, VolumeDecimals(step))
		remaining[i] = left
	}
	return closes, remaining
}

func firstUndersized(closes, remaining []float64, volumeMin float64) int {
	for i, close := range closes {
		if close+volumeEpsilon < volumeMin || i < len(closes)-1 && remaining[i]+volumeEpsilon < volumeMin {
			return i
		}
	}
	return -1
}

func roundFixed(value float64, decimals int) float64 {
	// Formatting then parsing mirrors the source's Number(value.toFixed(digits)).
	text := fmt.Sprintf("%.*f", decimals, value)
	out, _ := strconv.ParseFloat(text, 64)
	return out
}
