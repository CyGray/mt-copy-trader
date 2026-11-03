package domain

import "strings"

type PreviewStage string

const (
	PreviewSymbol      PreviewStage = "symbol"
	PreviewEntry       PreviewStage = "entry"
	PreviewStopLoss    PreviewStage = "stop_loss"
	PreviewSizing      PreviewStage = "sizing"
	PreviewCheckpoints PreviewStage = "checkpoints"
)

type PreviewInput struct {
	Signal Signal `json:"signal"`
	Quote  struct {
		Bid float64 `json:"bid"`
		Ask float64 `json:"ask"`
	} `json:"quote"`
	Equity float64    `json:"equity"`
	Spec   SizingSpec `json:"spec"`
}

type ProfilePreview struct {
	OK           bool                  `json:"ok"`
	FailedAt     *PreviewStage         `json:"failedAt"`
	SymbolMapped bool                  `json:"symbolMapped"`
	BrokerSymbol *string               `json:"brokerSymbol"`
	Limits       EffectiveLimits       `json:"limits"`
	Entry        *EntryDecision        `json:"entry"`
	StopLoss     *StopLossCheck        `json:"stopLoss"`
	Sizing       *SizingResult         `json:"sizing"`
	Checkpoints  *CheckpointPlanResult `json:"checkpoints"`
}

type ParsedPreviewInput struct {
	OK    bool          `json:"ok"`
	Value *PreviewInput `json:"value,omitempty"`
	Error string        `json:"error,omitempty"`
}

func BuildProfilePreview(profile ExecutionProfile, safety SafetyLimits, input PreviewInput) ProfilePreview {
	limits := ResolveEffectiveLimits(profile, safety)
	brokerSymbol, mapped := ResolveBrokerSymbol(profile, input.Signal.Symbol)
	result := ProfilePreview{SymbolMapped: mapped, Limits: limits}
	if mapped {
		result.BrokerSymbol = &brokerSymbol
	} else {
		stage := PreviewSymbol
		result.FailedAt = &stage
		return result
	}
	entry := DecideEntry(input.Signal, input.Quote.Bid, input.Quote.Ask, profile.Entry)
	result.Entry = &entry
	if !entry.OK {
		stage := PreviewEntry
		result.FailedAt = &stage
		return result
	}
	stop := ValidateStopLoss(input.Signal.Direction, entry.EntryRefPrice, input.Signal.StopLoss, profile.StopLoss)
	result.StopLoss = &stop
	if !stop.OK {
		stage := PreviewStopLoss
		result.FailedAt = &stage
		return result
	}
	sizing := ComputeVolume(profile.Sizing, entry.EntryRefPrice, input.Signal.StopLoss, input.Equity, input.Spec, limits)
	result.Sizing = &sizing
	if !sizing.OK {
		stage := PreviewSizing
		result.FailedAt = &stage
		return result
	}
	checkpoints := PlanCheckpoints(sizing.Volume, input.Signal.Direction, entry.EntryRefPrice, input.Signal.TakeProfits, profile.TakeProfit, input.Spec)
	result.Checkpoints = &checkpoints
	if !checkpoints.OK {
		stage := PreviewCheckpoints
		result.FailedAt = &stage
		return result
	}
	result.OK = true
	return result
}

func ParsePreviewInput(raw any) ParsedPreviewInput {
	fail := func(message string) ParsedPreviewInput { return ParsedPreviewInput{Error: message} }
	obj, ok := isMap(raw)
	if !ok {
		return fail("preview must be an object")
	}
	sig, ok := isMap(obj["signal"])
	if !ok {
		return fail("preview.signal must be an object")
	}
	symbol, ok := sig["symbol"].(string)
	if !ok || strings.TrimSpace(symbol) == "" {
		return fail("preview.signal.symbol is required")
	}
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	direction, ok := sig["direction"].(string)
	if !ok || (direction != "buy" && direction != "sell") {
		return fail("preview.signal.direction must be buy or sell")
	}
	orderType, ok := sig["orderType"].(string)
	if !ok || !contains([]string{"market", "buy_limit", "sell_limit", "buy_stop", "sell_stop"}, orderType) {
		return fail("preview.signal.orderType must be market, buy_limit, sell_limit, buy_stop or sell_stop")
	}
	entryLow, ok := previewNumber(sig["entryLow"])
	if !ok {
		return fail("preview.signal.entryLow must be a number")
	}
	entryHigh, ok := previewNumber(sig["entryHigh"])
	if !ok {
		return fail("preview.signal.entryHigh must be a number")
	}
	sl, ok := previewNumber(sig["stopLoss"])
	if !ok {
		return fail("preview.signal.stopLoss must be a number")
	}
	quote, _ := isMap(obj["quote"])
	bid, ok := previewNumber(quote["bid"])
	if !ok {
		return fail("preview.quote.bid must be a number")
	}
	ask, ok := previewNumber(quote["ask"])
	if !ok {
		return fail("preview.quote.ask must be a number")
	}
	equity, ok := previewNumber(obj["equity"])
	if !ok {
		return fail("preview.equity must be a number")
	}
	spec, _ := isMap(obj["spec"])
	tickSize, ok := previewNumber(spec["tickSize"])
	if !ok {
		return fail("preview.spec.tickSize must be a number")
	}
	tickValueLoss, ok := previewNumber(spec["tickValueLoss"])
	if !ok {
		return fail("preview.spec.tickValueLoss must be a number")
	}
	volumeMin, ok := previewNumber(spec["volumeMin"])
	if !ok {
		return fail("preview.spec.volumeMin must be a number")
	}
	volumeMax, ok := previewNumber(spec["volumeMax"])
	if !ok {
		return fail("preview.spec.volumeMax must be a number")
	}
	volumeStep, ok := previewNumber(spec["volumeStep"])
	if !ok {
		return fail("preview.spec.volumeStep must be a number")
	}
	tpValues, ok := sig["takeProfits"].([]any)
	if !ok {
		return fail("preview.signal.takeProfits must be a list of numbers")
	}
	tps := make([]float64, len(tpValues))
	for i, rawTP := range tpValues {
		value, ok := previewNumber(rawTP)
		if !ok {
			return fail("preview.signal.takeProfits must be a list of numbers")
		}
		tps[i] = value
	}
	input := PreviewInput{Signal: Signal{Symbol: symbol, Direction: Direction(direction), OrderType: SignalOrderType(orderType), EntryLow: entryLow, EntryHigh: entryHigh, StopLoss: sl, TakeProfits: tps}, Equity: equity, Spec: SizingSpec{TickSize: tickSize, TickValueLoss: tickValueLoss, VolumeMin: volumeMin, VolumeMax: volumeMax, VolumeStep: volumeStep}}
	input.Quote.Bid, input.Quote.Ask = bid, ask
	return ParsedPreviewInput{OK: true, Value: &input}
}

func previewNumber(value any) (float64, bool) {
	n, ok := numValue(value)
	if !ok {
		return 0, false
	}
	return n, true
}
