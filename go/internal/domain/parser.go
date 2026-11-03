package domain

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

var (
	orderTypePattern     = regexp.MustCompile(`(?i)\b(BUY\s*LIMIT|SELL\s*LIMIT|BUY\s*STOP|SELL\s*STOP)\b`)
	directionPattern     = regexp.MustCompile(`(?im)^[ \t>]*(BUY(?:ING)?|SELL(?:ING)?)\b`)
	entryPattern         = regexp.MustCompile(`(?i)\b(?:OPEN|ENTRY(?:\s*ZONE)?)\s*:?\s*(-?\d+(?:\.\d+)?)(?:\s*[-–]\s*(-?\d+(?:\.\d+)?))?`)
	stopLossPattern      = regexp.MustCompile(`(?i)\b(?:SL|STOP\s*LOSS)\s*:?\s*(-?\d+(?:\.\d+)?)`)
	takeProfitPattern    = regexp.MustCompile(`(?i)\bTP\s*(\d+)\s*:?\s*(-?\d+(?:\.\d+)?)`)
	symbolPattern        = regexp.MustCompile(`\b([A-Z]{2,6}(?:USD|USDT))\b`)
	goldPattern          = regexp.MustCompile(`(?i)\bGOLD\b`)
	cancelPattern        = regexp.MustCompile(`(?i)\bcancel(?:l?ed)?\b`)
	deleteSignalPattern  = regexp.MustCompile(`(?i)\bdelete\s+this\s+signal\b`)
	ignoreSignalPattern  = regexp.MustCompile(`(?i)\bignore\s+this\s+signal\b`)
	invalidSignalPattern = regexp.MustCompile(`(?i)\binvalid\s+signal\b`)
	negationPattern      = regexp.MustCompile(`(?i)(?:\b(?:not|never|no|don['’]?t|do\s+not|won['’]?t)\s+)$`)

	// "Gold BUY Now INSTANT" template: "@ 4010.5 - 4008", "Take Profit 1 - 4015", "Stoploss - 4000".
	instantHeadPattern  = regexp.MustCompile(`(?im)^[ \t]*GOLD\s+(BUY|SELL)\s+NOW\b`)
	instantEntryPattern = regexp.MustCompile(`(?m)^[ \t]*@\s*(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)[ \t]*$`)
	instantTPPattern    = regexp.MustCompile(`(?im)^[ \t]*TAKE\s*PROFIT\s*(\d+)\s*[-–:]\s*(\d+(?:\.\d+)?)[ \t]*$`)
	instantSLPattern    = regexp.MustCompile(`(?im)^[ \t]*STOP\s*LOSS\s*[-–:]\s*(\d+(?:\.\d+)?)[ \t]*$`)
)

type ParseResult struct {
	OK     bool    `json:"ok"`
	Signal *Signal `json:"signal,omitempty"`
	Error  string  `json:"error,omitempty"`
}

func ParseGoldSignal(text string) ParseResult {
	result := parseStandardSignal(text)
	if !result.OK {
		if instant, matched := parseInstantSignal(text); matched {
			return instant
		}
	}
	return result
}

func parseStandardSignal(text string) ParseResult {
	normalized := strings.TrimSpace(text)
	if normalized == "" {
		return ParseResult{Error: "empty_message"}
	}

	orderType := MarketOrder
	if m := orderTypePattern.FindStringSubmatch(normalized); len(m) > 1 {
		switch strings.ToUpper(strings.Join(strings.Fields(m[1]), "_")) {
		case "BUY_LIMIT":
			orderType = BuyLimit
		case "SELL_LIMIT":
			orderType = SellLimit
		case "BUY_STOP":
			orderType = BuyStop
		case "SELL_STOP":
			orderType = SellStop
		}
	}

	directionMatch := directionPattern.FindStringSubmatch(normalized)
	if len(directionMatch) < 2 {
		return ParseResult{Error: "missing_direction"}
	}
	direction := Sell
	if strings.HasPrefix(strings.ToUpper(directionMatch[1]), "B") {
		direction = Buy
	}

	entryMatch := entryPattern.FindStringSubmatch(normalized)
	if len(entryMatch) < 2 {
		return ParseResult{Error: "missing_entry"}
	}
	entryFirst, err := strconv.ParseFloat(entryMatch[1], 64)
	if err != nil {
		return ParseResult{Error: "invalid_entry"}
	}
	entrySecond := entryFirst
	if len(entryMatch) > 2 && entryMatch[2] != "" {
		entrySecond = expandShortRange(entryMatch[1], entryMatch[2])
		if !finite(entrySecond) {
			return ParseResult{Error: "invalid_entry"}
		}
	}
	entryLow, entryHigh := mathMin(entryFirst, entrySecond), mathMax(entryFirst, entrySecond)

	slMatch := stopLossPattern.FindStringSubmatch(normalized)
	if len(slMatch) < 2 {
		return ParseResult{Error: "missing_sl"}
	}
	stopLoss, err := strconv.ParseFloat(slMatch[1], 64)
	if err != nil || !finite(stopLoss) {
		return ParseResult{Error: "invalid_sl"}
	}

	type indexedTP struct {
		index int
		value float64
	}
	matches := takeProfitPattern.FindAllStringSubmatch(normalized, -1)
	tps := make([]indexedTP, 0, len(matches))
	for _, match := range matches {
		index, e1 := strconv.Atoi(match[1])
		value, e2 := strconv.ParseFloat(match[2], 64)
		if e1 != nil || e2 != nil || !finite(value) {
			continue
		}
		tps = append(tps, indexedTP{index: index, value: value})
	}
	if len(tps) == 0 {
		return ParseResult{Error: "missing_tp"}
	}
	sort.SliceStable(tps, func(i, j int) bool { return tps[i].index < tps[j].index })
	values := make([]float64, len(tps))
	for i, item := range tps {
		values[i] = item.value
	}
	for i := 1; i < len(values); i++ {
		ordered := direction == Buy && values[i] > values[i-1] || direction == Sell && values[i] < values[i-1]
		if !ordered {
			return ParseResult{Error: "invalid_tp_order"}
		}
	}
	if direction == Buy {
		if stopLoss >= entryLow {
			return ParseResult{Error: "invalid_sl_side"}
		}
		if values[0] <= entryHigh {
			return ParseResult{Error: "invalid_tp_side"}
		}
	} else {
		if stopLoss <= entryHigh {
			return ParseResult{Error: "invalid_sl_side"}
		}
		if values[0] >= entryLow {
			return ParseResult{Error: "invalid_tp_side"}
		}
	}

	symbol := "XAUUSD"
	if match := symbolPattern.FindStringSubmatch(strings.ToUpper(normalized)); len(match) > 1 {
		symbol = match[1]
	} else if !goldPattern.MatchString(normalized) {
		symbol = "XAUUSD"
	}
	return ParseResult{OK: true, Signal: &Signal{Symbol: symbol, Direction: direction, OrderType: orderType, EntryLow: entryLow, EntryHigh: entryHigh, StopLoss: stopLoss, TakeProfits: values}}
}

// parseInstantSignal reads the "Gold BUY|SELL Now" template. matched is false when the text is not
// that template, so the caller keeps the standard parser's error.
func parseInstantSignal(text string) (ParseResult, bool) {
	head := instantHeadPattern.FindStringSubmatch(text)
	entry := instantEntryPattern.FindStringSubmatch(text)
	sl := instantSLPattern.FindStringSubmatch(text)
	tpRows := instantTPPattern.FindAllStringSubmatch(text, -1)
	if head == nil || entry == nil || sl == nil || len(tpRows) == 0 {
		return ParseResult{}, false
	}
	direction := Sell
	if strings.EqualFold(head[1], "BUY") {
		direction = Buy
	}
	first, second := parseNum(entry[1]), parseNum(entry[2])
	stopLoss := parseNum(sl[1])
	if !finite(second) || !(first > 0) || !(second > 0) || !(stopLoss > 0) {
		return ParseResult{Error: "invalid_entry"}, true
	}
	entryLow, entryHigh := mathMin(first, second), mathMax(first, second)
	type indexedTP struct {
		index int
		value float64
	}
	tps := make([]indexedTP, 0, len(tpRows))
	for _, row := range tpRows {
		index, err := strconv.Atoi(row[1])
		value := parseNum(row[2])
		if err != nil || !(value > 0) {
			continue
		}
		tps = append(tps, indexedTP{index, value})
	}
	if len(tps) == 0 {
		return ParseResult{Error: "missing_tp"}, true
	}
	sort.SliceStable(tps, func(i, j int) bool { return tps[i].index < tps[j].index })
	// This provider sometimes mistypes a later target; keep the targets up to the first out-of-order one.
	values := []float64{}
	for i, tp := range tps {
		if i > 0 && !(direction == Buy && tp.value > values[i-1] || direction == Sell && tp.value < values[i-1]) {
			break
		}
		values = append(values, tp.value)
	}
	if direction == Buy && stopLoss >= entryLow || direction == Sell && stopLoss <= entryHigh {
		return ParseResult{Error: "invalid_sl_side"}, true
	}
	if direction == Buy && values[0] <= entryHigh || direction == Sell && values[0] >= entryLow {
		return ParseResult{Error: "invalid_tp_side"}, true
	}
	return ParseResult{OK: true, Signal: &Signal{Symbol: "XAUUSD", Direction: direction, OrderType: MarketOrder, EntryLow: entryLow, EntryHigh: entryHigh, StopLoss: stopLoss, TakeProfits: values}}, true
}

func expandShortRange(firstRaw, secondRaw string) float64 {
	first, e1 := strconv.ParseFloat(firstRaw, 64)
	second, e2 := strconv.ParseFloat(secondRaw, 64)
	if e1 != nil || e2 != nil {
		return math.NaN()
	}
	if second >= first {
		return second
	}
	clean := func(s string) string { return strings.NewReplacer("-", "", "+", "", ".", "").Replace(s) }
	firstDigits, secondDigits := clean(firstRaw), clean(secondRaw)
	if len(secondDigits) >= len(firstDigits) {
		return second
	}
	return parseNum(firstDigits[:len(firstDigits)-len(secondDigits)] + secondDigits)
}

func DetectCancelIntent(text string) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || len(utf16.Encode([]rune(trimmed))) > 120 {
		return false
	}
	if ParseGoldSignal(trimmed).OK {
		return false
	}
	for _, pattern := range []*regexp.Regexp{cancelPattern, deleteSignalPattern, ignoreSignalPattern, invalidSignalPattern} {
		for _, match := range pattern.FindAllStringIndex(trimmed, -1) {
			before := trimmed[:match[0]]
			if !negationPattern.MatchString(before) {
				return true
			}
		}
	}
	return false
}

func parseNum(s string) float64 { v, _ := strconv.ParseFloat(s, 64); return v }
func finite(v float64) bool     { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func mathMin(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
func mathMax(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}
