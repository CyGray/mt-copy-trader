package telegram

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var historyNumber = regexp.MustCompile(`-?\d+(?:\.\d+)?`)
var historySL = regexp.MustCompile(`(?i)\bSL\b`)
var historyTP = regexp.MustCompile(`(?i)\bTP\b`)

type historyParseResult struct {
	OK     bool
	Signal map[string]any
	Error  string
}

// parseTelegramHistory preserves the existing display parser's stored shape.
// Trade execution uses domain.ParseGoldSignal separately.
func parseTelegramHistory(text string) historyParseResult {
	normalized := strings.TrimSpace(text)
	if normalized == "" {
		return historyParseResult{Error: "empty_message"}
	}
	upper := strings.ToUpper(normalized)
	if !strings.Contains(upper, "NOW") {
		return historyParseResult{Error: "missing_now"}
	}
	symbol := ""
	for _, token := range strings.Fields(upper) {
		if strings.HasSuffix(token, "USDT") {
			symbol = strings.Map(func(r rune) rune {
				if r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
					return r
				}
				return -1
			}, token)
			break
		}
	}
	if symbol == "" {
		return historyParseResult{Error: "missing_symbol"}
	}
	long, short := strings.Contains(upper, "LONG"), strings.Contains(upper, "SHORT")
	if long == short {
		return historyParseResult{Error: "missing_direction"}
	}
	direction := "short"
	if long {
		direction = "long"
	}
	var stopLoss float64
	foundSL := false
	var takeProfits []indexedHistoryTP
	for _, line := range strings.Split(normalized, "\n") {
		if historySL.MatchString(line) {
			if number := historyNumber.FindString(line); number != "" {
				stopLoss, _ = strconv.ParseFloat(number, 64)
				foundSL = stopLoss != 0
			}
		}
		if historyTP.MatchString(line) {
			if number := historyNumber.FindString(line); number != "" {
				value, err := strconv.ParseFloat(number, 64)
				if err == nil {
					takeProfits = append(takeProfits, indexedHistoryTP{value: value})
				}
			}
		}
	}
	if !foundSL {
		return historyParseResult{Error: "missing_sl"}
	}
	if len(takeProfits) < 3 {
		return historyParseResult{Error: "missing_tp"}
	}
	takeProfits = takeProfits[:3]
	values := []float64{takeProfits[0].value, takeProfits[1].value, takeProfits[2].value}
	ordered := sort.SliceIsSorted(values, func(i, j int) bool {
		if direction == "long" {
			return values[i] < values[j]
		}
		return values[i] > values[j]
	})
	if !ordered || values[0] == values[1] || values[1] == values[2] {
		return historyParseResult{Error: "invalid_tp_order"}
	}
	return historyParseResult{OK: true, Signal: map[string]any{
		"symbol": symbol, "direction": direction, "stopLoss": stopLoss, "takeProfits": values,
	}}
}

type indexedHistoryTP struct{ value float64 }
