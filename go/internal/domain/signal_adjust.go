package domain

// MaxDistanceTargets is how many synthetic take profits take_profit.distance_step_price produces.
const MaxDistanceTargets = 10

// ApplyProfileToSignal returns the signal the engine trades under the profile: the stop moved
// stop_loss.widen_price further from the entry and, when take_profit.distance_step_price is set,
// take profits at entryRef ± k·step instead of the provider's. The input signal is not modified.
func ApplyProfileToSignal(signal Signal, profile ExecutionProfile, entryRef float64) Signal {
	out := signal
	out.TakeProfits = append([]float64(nil), signal.TakeProfits...)
	buy := signal.Direction == Buy
	if w := profile.StopLoss.WidenPrice; w > 0 {
		if buy {
			out.StopLoss = signal.StopLoss - w
		} else {
			out.StopLoss = signal.StopLoss + w
		}
	}
	if step := profile.TakeProfit.DistanceStepPrice; step > 0 && finite(entryRef) && entryRef > 0 {
		out.TakeProfits = make([]float64, MaxDistanceTargets)
		for k := range out.TakeProfits {
			d := step * float64(k+1)
			if buy {
				out.TakeProfits[k] = entryRef + d
			} else {
				out.TakeProfits[k] = entryRef - d
			}
		}
	}
	return out
}
