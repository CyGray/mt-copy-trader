package domain

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

const ProfileSchemaVersion = 1

type SizingMode string
type EntryPolicy string

const (
	FixedLots         SizingMode  = "fixed_lots"
	FixedRiskMoney    SizingMode  = "fixed_risk_money"
	EquityRiskPercent SizingMode  = "equity_risk_percent"
	MarketOnly        EntryPolicy = "market_only"
	FollowSignal      EntryPolicy = "follow_signal"
	PendingAtRange    EntryPolicy = "pending_at_range"
)

type ProfileSource struct {
	Type       string `json:"type"`
	ReportID   string `json:"report_id,omitempty"`
	ReportDate string `json:"report_date,omitempty"`
	Author     string `json:"author,omitempty"`
	Notes      string `json:"notes,omitempty"`
}

type SymbolMapping struct {
	SignalSymbol string `json:"signal_symbol"`
	BrokerSymbol string `json:"broker_symbol"`
}

type EntryConfig struct {
	Policy               EntryPolicy `json:"policy"`
	MarketTolerancePrice float64     `json:"market_tolerance_price"`
	PendingExpiryMinutes int         `json:"pending_expiry_minutes"`
	AllowMarketFallback  bool        `json:"allow_market_fallback"`
}

type SizingConfig struct {
	Mode           SizingMode `json:"mode"`
	FixedLots      *float64   `json:"fixed_lots,omitempty"`
	RiskMoney      *float64   `json:"risk_money,omitempty"`
	RiskPercent    *float64   `json:"risk_percent,omitempty"`
	BelowMinVolume string     `json:"below_min_volume"`
}

type ProfileCheckpoint struct {
	TPIndex      int     `json:"tp_index"`
	ClosePercent float64 `json:"close_percent"`
}

type TakeProfitConfig struct {
	Checkpoints     []ProfileCheckpoint `json:"checkpoints"`
	MissingTP       string              `json:"missing_tp"`
	InfeasibleSplit string              `json:"infeasible_split"`
	BrokerTP        string              `json:"broker_tp"`
	// DistanceStepPrice > 0 replaces the signal's take profits with entry ± k·step (k = 1..10),
	// so tp_index k means "k steps from the entry reference price".
	DistanceStepPrice float64 `json:"distance_step_price,omitempty"`
}

type AfterCheckpointStop struct {
	AfterTPIndex int     `json:"after_tp_index"`
	MoveTo       string  `json:"move_to"`
	BufferPrice  float64 `json:"buffer_price"`
}

type StopLossConfig struct {
	MinDistancePrice float64               `json:"min_distance_price"`
	MaxDistancePrice float64               `json:"max_distance_price"`
	AfterCheckpoint  []AfterCheckpointStop `json:"after_checkpoint"`
	// WidenPrice moves the signal's stop further from the entry by this price distance.
	WidenPrice float64 `json:"widen_price,omitempty"`
}

type BreakEvenConfig struct {
	Enabled      bool    `json:"enabled"`
	Trigger      string  `json:"trigger"`
	TriggerValue float64 `json:"trigger_value"`
	BufferPrice  float64 `json:"buffer_price"`
}

type TrailingConfig struct {
	Enabled         bool    `json:"enabled"`
	Activation      string  `json:"activation"`
	ActivationValue float64 `json:"activation_value"`
	DistancePrice   float64 `json:"distance_price"`
	StepPrice       float64 `json:"step_price"`
}

type ProfileLimits struct {
	MaxConcurrentPositions int     `json:"max_concurrent_positions"`
	MaxPositionsPerSymbol  int     `json:"max_positions_per_symbol"`
	MaxSpreadPrice         float64 `json:"max_spread_price"`
	MaxDeviationPoints     int     `json:"max_deviation_points"`
	SignalMaxAgeSec        int     `json:"signal_max_age_sec"`
	DailyLossLimitMoney    float64 `json:"daily_loss_limit_money"`
	MaxTotalRiskPercent    float64 `json:"max_total_risk_percent"`
}

type EditPolicy struct {
	BeforeFill      string `json:"before_fill"`
	AfterFill       string `json:"after_fill"`
	UnparseableEdit string `json:"unparseable_edit"`
	ExplicitCancel  string `json:"explicit_cancel"`
}

type ExecutionProfile struct {
	SchemaVersion   int              `json:"schema_version"`
	ProfileID       string           `json:"profile_id"`
	Version         int              `json:"version"`
	Name            string           `json:"name"`
	Description     string           `json:"description,omitempty"`
	Source          ProfileSource    `json:"source"`
	Broker          string           `json:"broker"`
	Symbols         []SymbolMapping  `json:"symbols"`
	Entry           EntryConfig      `json:"entry"`
	Sizing          SizingConfig     `json:"sizing"`
	TakeProfit      TakeProfitConfig `json:"take_profit"`
	StopLoss        StopLossConfig   `json:"stop_loss"`
	BreakEven       BreakEvenConfig  `json:"break_even"`
	Trailing        TrailingConfig   `json:"trailing"`
	Limits          ProfileLimits    `json:"limits"`
	Edits           EditPolicy       `json:"edits"`
	Recommendations map[string]any   `json:"recommendations,omitempty"`
}

type SafetyLimits struct {
	MaxRiskPercentPerTrade float64  `json:"max_risk_percent_per_trade"`
	MaxRiskMoneyPerTrade   float64  `json:"max_risk_money_per_trade"`
	MaxLotsPerTrade        float64  `json:"max_lots_per_trade"`
	MaxConcurrentPositions int      `json:"max_concurrent_positions"`
	MaxPositionsPerSymbol  int      `json:"max_positions_per_symbol"`
	DailyLossLimitMoney    float64  `json:"daily_loss_limit_money"`
	MaxTotalRiskPercent    float64  `json:"max_total_risk_percent"`
	MaxSpreadPrice         float64  `json:"max_spread_price"`
	MaxDeviationPoints     int      `json:"max_deviation_points"`
	MaxSignalAgeSec        int      `json:"max_signal_age_sec"`
	MinMarginLevelPercent  float64  `json:"min_margin_level_percent"`
	AllowedSignalSymbols   []string `json:"allowed_signal_symbols"`
}

var HardCeilings = SafetyLimits{
	MaxRiskPercentPerTrade: 5, MaxRiskMoneyPerTrade: 5000, MaxLotsPerTrade: 20,
	MaxConcurrentPositions: 20, MaxPositionsPerSymbol: 10, DailyLossLimitMoney: 20000,
	MaxTotalRiskPercent: 20, MaxSpreadPrice: 10, MaxDeviationPoints: 500,
	MaxSignalAgeSec: 3600, MinMarginLevelPercent: 10000,
}

var DefaultSafetyLimits = SafetyLimits{
	MaxRiskPercentPerTrade: 1, MaxRiskMoneyPerTrade: 50, MaxLotsPerTrade: 1,
	MaxConcurrentPositions: 3, MaxPositionsPerSymbol: 1, DailyLossLimitMoney: 100,
	MaxTotalRiskPercent: 3, MaxSpreadPrice: 0.5, MaxDeviationPoints: 30,
	MaxSignalAgeSec: 120, MinMarginLevelPercent: 200, AllowedSignalSymbols: []string{"XAUUSD"},
}

type EffectiveLimits struct {
	MaxRiskPercent        float64 `json:"maxRiskPercent"`
	MaxRiskMoney          float64 `json:"maxRiskMoney"`
	MaxLots               float64 `json:"maxLots"`
	MaxConcurrent         int     `json:"maxConcurrent"`
	MaxPerSymbol          int     `json:"maxPerSymbol"`
	DailyLossLimit        float64 `json:"dailyLossLimit"`
	MaxTotalRiskPercent   float64 `json:"maxTotalRiskPercent"`
	MaxSpreadPrice        float64 `json:"maxSpreadPrice"`
	MaxDeviationPoints    int     `json:"maxDeviationPoints"`
	MaxSignalAgeSec       int     `json:"maxSignalAgeSec"`
	MinMarginLevelPercent float64 `json:"minMarginLevelPercent"`
}

type ValidationIssue struct {
	Path     string `json:"path"`
	Message  string `json:"message"`
	Value    any    `json:"value,omitempty"`
	Limit    any    `json:"limit,omitempty"`
	HasValue bool   `json:"-"`
}

func (i ValidationIssue) MarshalJSON() ([]byte, error) {
	out := map[string]any{"path": i.Path, "message": i.Message}
	if i.HasValue || i.Value != nil {
		out["value"] = i.Value
	}
	if i.Limit != nil {
		out["limit"] = i.Limit
	}
	return json.Marshal(out)
}

type ValidationResult[T any] struct {
	OK       bool              `json:"ok"`
	Value    *T                `json:"value,omitempty"`
	Errors   []ValidationIssue `json:"errors"`
	Warnings []ValidationIssue `json:"warnings"`
}

var (
	profileIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,47}$`)
	signalSymPattern = regexp.MustCompile(`^[A-Z0-9][A-Z0-9._-]{0,31}$`)
	brokerSymPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$`)
)

type validationContext struct {
	errors   []ValidationIssue
	warnings []ValidationIssue
}

type numberRule struct {
	integer      bool
	min          *float64
	minExclusive bool
	max          *float64
	ceilingKey   string
	ceiling      *float64
}

func ptr[T any](v T) *T { return &v }

func numValue(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, !math.IsNaN(n) && !math.IsInf(n, 0)
	case float32:
		f := float64(n)
		return f, !math.IsNaN(f) && !math.IsInf(f, 0)
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case int32:
		return float64(n), true
	case json.Number:
		f, e := n.Float64()
		return f, e == nil && !math.IsNaN(f) && !math.IsInf(f, 0)
	default:
		return 0, false
	}
}

func valueShow(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		b, _ := json.Marshal(x)
		return string(b)
	case []any:
		return "array"
	case map[string]any:
		return "object"
	case bool:
		return strconv.FormatBool(x)
	default:
		if f, ok := numValue(v); ok {
			return formatNum(f)
		}
		return fmt.Sprint(v)
	}
}

func formatNum(n float64) string { return strconv.FormatFloat(n, 'f', -1, 64) }

func (c *validationContext) fail(path, message string, value, limit any) {
	if path == "" {
		path = "$"
	}
	i := ValidationIssue{Path: path, Message: message}
	if value != nil {
		i.Value = value
		i.HasValue = true
	}
	if limit != nil {
		i.Limit = limit
	}
	c.errors = append(c.errors, i)
}

func (c *validationContext) failWithValue(path, message string, value any, limit any) {
	c.fail(path, message, value, limit)
	if value == nil && len(c.errors) > 0 {
		c.errors[len(c.errors)-1].HasValue = true
	}
}

func (c *validationContext) note(path, message string) {
	if path == "" {
		path = "$"
	}
	c.warnings = append(c.warnings, ValidationIssue{Path: path, Message: message})
}

func isMap(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok && m != nil
}

func (c *validationContext) object(v any, path string, allowed []string) map[string]any {
	m, ok := isMap(v)
	if !ok {
		c.failWithValue(path, fmt.Sprintf("must be an object (got %s)", valueShow(v)), v, nil)
		return nil
	}
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, k := range allowed {
		allowedSet[k] = struct{}{}
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if _, ok := allowedSet[k]; !ok {
			c.fail(joinPath(path, k), "unknown key (allowed: "+strings.Join(allowed, ", ")+")", m[k], nil)
		}
	}
	return m
}

func joinPath(base, key string) string {
	if base == "" {
		return key
	}
	return base + "." + key
}

func (c *validationContext) section(obj map[string]any, key, base string, allowed []string) map[string]any {
	path := joinPath(base, key)
	v, ok := obj[key]
	if !ok {
		c.fail(path, "is required", nil, nil)
		return nil
	}
	return c.object(v, path, allowed)
}

func (c *validationContext) array(obj map[string]any, key, base string) []any {
	path := joinPath(base, key)
	v, ok := obj[key]
	if !ok {
		c.fail(path, "is required", nil, nil)
		return nil
	}
	a, ok := v.([]any)
	if !ok {
		c.fail(path, "must be an array", nil, nil)
		return nil
	}
	return a
}

func (c *validationContext) number(obj map[string]any, key, base string, required bool, rule numberRule) (float64, bool) {
	path := joinPath(base, key)
	v, exists := obj[key]
	if !exists {
		if required {
			c.fail(path, "is required", nil, nil)
		}
		return 0, false
	}
	n, ok := numValue(v)
	if !ok {
		c.failWithValue(path, fmt.Sprintf("must be a finite number (got %s)", valueShow(v)), v, nil)
		return 0, false
	}
	if rule.integer && math.Trunc(n) != n {
		c.fail(path, "must be an integer (got "+formatNum(n)+")", n, nil)
		return 0, false
	}
	if rule.min != nil && (n < *rule.min || rule.minExclusive && n == *rule.min) {
		op := ">="
		if rule.minExclusive {
			op = ">"
		}
		c.fail(path, fmt.Sprintf("must be %s %s (got %s)", op, formatNum(*rule.min), formatNum(n)), n, *rule.min)
		return 0, false
	}
	if rule.max != nil && n > *rule.max {
		c.fail(path, fmt.Sprintf("must be <= %s (got %s)", formatNum(*rule.max), formatNum(n)), n, *rule.max)
		return 0, false
	}
	if rule.ceiling != nil && n > *rule.ceiling {
		c.fail(path, fmt.Sprintf("%s %s exceeds hard ceiling %s %s", key, formatNum(n), rule.ceilingKey, formatNum(*rule.ceiling)), n, *rule.ceiling)
		return 0, false
	}
	return n, true
}

func minRule(n float64, exclusive bool) numberRule {
	return numberRule{min: &n, minExclusive: exclusive}
}
func maxRule(n float64) numberRule                 { return numberRule{max: &n} }
func ceilingRule(key string, n float64) numberRule { return numberRule{ceilingKey: key, ceiling: &n} }

func (c *validationContext) str(obj map[string]any, key, base string, required bool, pattern *regexp.Regexp, patternMessage string, minLen, maxLen int) (string, bool) {
	path := joinPath(base, key)
	v, exists := obj[key]
	if !exists {
		if required {
			c.fail(path, "is required", nil, nil)
		}
		return "", false
	}
	s, ok := v.(string)
	if !ok {
		c.failWithValue(path, fmt.Sprintf("must be a string (got %s)", valueShow(v)), v, nil)
		return "", false
	}
	length := len(utf16.Encode([]rune(s)))
	if minLen > 0 && maxLen > 0 && (length < minLen || length > maxLen) {
		c.fail(path, fmt.Sprintf("must be %d..%d characters (got %d)", minLen, maxLen, length), v, maxLen)
		return "", false
	}
	if pattern != nil && !pattern.MatchString(s) {
		c.fail(path, patternMessage+" (got "+valueShow(v)+")", v, nil)
		return "", false
	}
	return s, true
}

func (c *validationContext) enum(obj map[string]any, key, base string, required bool, values ...string) (string, bool) {
	path := joinPath(base, key)
	v, exists := obj[key]
	if !exists {
		if required {
			c.fail(path, "is required", nil, nil)
		}
		return "", false
	}
	s, ok := v.(string)
	if !ok || !contains(values, s) {
		c.failWithValue(path, fmt.Sprintf("must be one of: %s (got %s)", strings.Join(values, ", "), valueShow(v)), v, nil)
		return "", false
	}
	return s, true
}

func (c *validationContext) boolean(obj map[string]any, key, base string, required bool) (bool, bool) {
	path := joinPath(base, key)
	v, exists := obj[key]
	if !exists {
		if required {
			c.fail(path, "is required", nil, nil)
		}
		return false, false
	}
	b, ok := v.(bool)
	if !ok {
		c.failWithValue(path, fmt.Sprintf("must be a boolean (got %s)", valueShow(v)), v, nil)
		return false, false
	}
	return b, true
}

func (c *validationContext) literal(obj map[string]any, key, base string, expected any) {
	path := joinPath(base, key)
	v, exists := obj[key]
	if !exists {
		c.fail(path, "is required", nil, nil)
		return
	}
	if n, ok := expected.(int); ok {
		if got, valid := numValue(v); valid && got == float64(n) {
			return
		}
	}
	if v != expected {
		b, _ := json.Marshal(expected)
		c.fail(path, fmt.Sprintf("must equal %s (got %s)", b, valueShow(v)), v, nil)
	}
}

func contains(values []string, got string) bool {
	for _, v := range values {
		if v == got {
			return true
		}
	}
	return false
}

var profileKeys = []string{"schema_version", "profile_id", "version", "name", "description", "source", "broker", "symbols", "entry", "sizing", "take_profit", "stop_loss", "break_even", "trailing", "limits", "edits", "recommendations"}
var sourceKeys = []string{"type", "report_id", "report_date", "author", "notes"}
var symbolKeys = []string{"signal_symbol", "broker_symbol"}
var entryKeys = []string{"policy", "market_tolerance_price", "pending_expiry_minutes", "allow_market_fallback"}
var sizingKeys = []string{"mode", "fixed_lots", "risk_money", "risk_percent", "below_min_volume"}
var takeProfitKeys = []string{"checkpoints", "missing_tp", "infeasible_split", "broker_tp", "distance_step_price"}
var checkpointKeys = []string{"tp_index", "close_percent"}
var stopLossKeys = []string{"min_distance_price", "max_distance_price", "after_checkpoint", "widen_price"}
var afterCheckpointKeys = []string{"after_tp_index", "move_to", "buffer_price"}
var breakEvenKeys = []string{"enabled", "trigger", "trigger_value", "buffer_price"}
var trailingKeys = []string{"enabled", "activation", "activation_value", "distance_price", "step_price"}
var limitKeys = []string{"max_concurrent_positions", "max_positions_per_symbol", "max_spread_price", "max_deviation_points", "signal_max_age_sec", "daily_loss_limit_money", "max_total_risk_percent"}
var editKeys = []string{"before_fill", "after_fill", "unparseable_edit", "explicit_cancel"}

func checkProfile(c *validationContext, root map[string]any) {
	c.literal(root, "schema_version", "", ProfileSchemaVersion)
	c.str(root, "profile_id", "", true, profileIDPattern, "must match /^[a-z0-9][a-z0-9-]{2,47}$/", 0, 0)
	c.number(root, "version", "", true, numberRule{integer: true, min: ptr(1.0)})
	c.str(root, "name", "", true, nil, "", 1, 80)
	c.str(root, "description", "", false, nil, "", 0, 0)
	c.literal(root, "broker", "", "vantage_mt5")

	source := c.section(root, "source", "", sourceKeys)
	if source != nil {
		c.enum(source, "type", "source", true, "optimal_report", "manual")
		for _, key := range []string{"report_id", "report_date", "author", "notes"} {
			c.str(source, key, "source", false, nil, "", 0, 0)
		}
	}

	if rows := c.array(root, "symbols", ""); rows != nil {
		if len(rows) == 0 {
			c.fail("symbols", "must contain at least one symbol", nil, nil)
		}
		seen := map[string]bool{}
		for i, item := range rows {
			base := fmt.Sprintf("symbols.%d", i)
			row := c.object(item, base, symbolKeys)
			if row == nil {
				continue
			}
			sig, ok := c.str(row, "signal_symbol", base, true, signalSymPattern, "must be uppercase (A-Z, 0-9, ., _, -)", 0, 0)
			c.str(row, "broker_symbol", base, true, brokerSymPattern, "must be a broker symbol (letters, digits, . _ + -)", 0, 0)
			if ok {
				if seen[sig] {
					c.fail(base+".signal_symbol", "duplicate signal_symbol", nil, nil)
				}
				seen[sig] = true
			}
		}
	}

	entry := c.section(root, "entry", "", entryKeys)
	if entry != nil {
		c.enum(entry, "policy", "entry", true, "market_only", "follow_signal", "pending_at_range")
		c.number(entry, "market_tolerance_price", "entry", true, minRule(0, false))
		c.number(entry, "pending_expiry_minutes", "entry", true, numberRule{integer: true, min: ptr(1.0), max: ptr(10080.0)})
		c.boolean(entry, "allow_market_fallback", "entry", true)
	}

	sizing := c.section(root, "sizing", "", sizingKeys)
	if sizing != nil {
		mode, modeOK := c.enum(sizing, "mode", "sizing", true, "fixed_lots", "fixed_risk_money", "equity_risk_percent")
		c.enum(sizing, "below_min_volume", "sizing", true, "skip", "use_min_if_within_cap")
		fields := []struct {
			key, active, ceilingKey string
			max                     float64
		}{
			{"fixed_lots", "fixed_lots", "max_lots_per_trade", HardCeilings.MaxLotsPerTrade},
			{"risk_money", "fixed_risk_money", "max_risk_money_per_trade", HardCeilings.MaxRiskMoneyPerTrade},
			{"risk_percent", "equity_risk_percent", "max_risk_percent_per_trade", HardCeilings.MaxRiskPercentPerTrade},
		}
		for _, f := range fields {
			if modeOK && mode == f.active {
				rule := numberRule{min: ptr(0.0), minExclusive: true, ceilingKey: f.ceilingKey, ceiling: &f.max}
				if f.key == "risk_percent" {
					rule.max = ptr(10.0)
				}
				c.number(sizing, f.key, "sizing", true, rule)
			} else {
				if _, ok := c.number(sizing, f.key, "sizing", false, ceilingRule(f.ceilingKey, f.max)); ok && modeOK {
					c.note("sizing."+f.key, "ignored: sizing.mode is "+mode)
				}
			}
		}
	}

	var cpIndexes map[int]bool
	tp := c.section(root, "take_profit", "", takeProfitKeys)
	if tp != nil {
		if rows := c.array(tp, "checkpoints", "take_profit"); rows != nil {
			if len(rows) == 0 {
				c.fail("take_profit.checkpoints", "must contain at least one checkpoint", nil, nil)
			}
			found := map[int]bool{}
			previous, percentSum, wellFormed := 0, 0.0, len(rows) > 0
			for i, item := range rows {
				base := fmt.Sprintf("take_profit.checkpoints.%d", i)
				row := c.object(item, base, checkpointKeys)
				if row == nil {
					wellFormed = false
					continue
				}
				idx, idxOK := c.number(row, "tp_index", base, true, numberRule{integer: true, min: ptr(1.0), max: ptr(10.0)})
				pct, pctOK := c.number(row, "close_percent", base, true, numberRule{min: ptr(0.0), minExclusive: true, max: ptr(100.0)})
				if !idxOK || !pctOK {
					wellFormed = false
					continue
				}
				index := int(idx)
				if index <= previous {
					c.fail(base+".tp_index", "must be strictly ascending", nil, nil)
				}
				previous = index
				found[index] = true
				percentSum += pct
			}
			if wellFormed && math.Abs(percentSum-100) > 1e-6 {
				c.fail("take_profit.checkpoints", "close_percent must sum to 100 (got "+formatNum(percentSum)+")", nil, nil)
			}
			if wellFormed {
				cpIndexes = found
			}
		}
		c.enum(tp, "missing_tp", "take_profit", true, "skip_trade", "merge_into_last_available")
		c.enum(tp, "infeasible_split", "take_profit", true, "skip_trade", "merge_into_next")
		c.enum(tp, "broker_tp", "take_profit", true, "final_checkpoint", "none")
		c.number(tp, "distance_step_price", "take_profit", false, numberRule{min: ptr(0.0), max: ptr(1000.0)})
	}

	stop := c.section(root, "stop_loss", "", stopLossKeys)
	if stop != nil {
		min, minOK := c.number(stop, "min_distance_price", "stop_loss", true, minRule(0, false))
		max, maxOK := c.number(stop, "max_distance_price", "stop_loss", true, minRule(0, true))
		if minOK && maxOK && max <= min {
			c.fail("stop_loss.max_distance_price", "must be greater than min_distance_price", nil, nil)
		}
		c.number(stop, "widen_price", "stop_loss", false, numberRule{min: ptr(0.0), max: ptr(1000.0)})
		if rows := c.array(stop, "after_checkpoint", "stop_loss"); rows != nil {
			seen := map[int]bool{}
			for i, item := range rows {
				base := fmt.Sprintf("stop_loss.after_checkpoint.%d", i)
				row := c.object(item, base, afterCheckpointKeys)
				if row == nil {
					continue
				}
				idx, ok := c.number(row, "after_tp_index", base, true, numberRule{integer: true, min: ptr(1.0), max: ptr(10.0)})
				c.enum(row, "move_to", base, true, "entry", "previous_tp")
				c.number(row, "buffer_price", base, true, minRule(0, false))
				if ok {
					n := int(idx)
					if cpIndexes != nil && !cpIndexes[n] {
						c.fail(base+".after_tp_index", "must reference a checkpoint tp_index", nil, nil)
					}
					if seen[n] {
						c.fail(base+".after_tp_index", "duplicate after_tp_index", nil, nil)
					}
					seen[n] = true
				}
			}
		}
	}

	for _, spec := range []struct {
		key  string
		keys []string
	}{{"break_even", breakEvenKeys}, {"trailing", trailingKeys}} {
		section := c.section(root, spec.key, "", spec.keys)
		if section == nil {
			continue
		}
		enabled, _ := c.boolean(section, "enabled", spec.key, true)
		activationKey, valueKey := "trigger", "trigger_value"
		if spec.key == "trailing" {
			activationKey, valueKey = "activation", "activation_value"
		}
		activation, _ := c.enum(section, activationKey, spec.key, true, "price_distance", "after_tp_index")
		rule := numberRule{}
		if activation == "after_tp_index" {
			rule = numberRule{integer: true, min: ptr(1.0), max: ptr(10.0)}
		} else if activation == "price_distance" {
			rule = numberRule{min: ptr(0.0), minExclusive: enabled}
		}
		v, ok := c.number(section, valueKey, spec.key, true, rule)
		if activation == "after_tp_index" && ok && cpIndexes != nil && !cpIndexes[int(v)] {
			c.fail(spec.key+"."+valueKey, "must reference a checkpoint tp_index", nil, nil)
		}
		c.number(section, "buffer_price", spec.key, spec.key == "break_even", minRule(0, false))
		if spec.key == "trailing" {
			c.number(section, "distance_price", spec.key, true, numberRule{min: ptr(0.0), minExclusive: enabled})
			c.number(section, "step_price", spec.key, true, numberRule{min: ptr(0.0), minExclusive: enabled})
		}
	}

	limits := c.section(root, "limits", "", limitKeys)
	if limits != nil {
		concurrent, co := c.number(limits, "max_concurrent_positions", "limits", true, numberRule{integer: true, min: ptr(1.0), ceilingKey: "max_concurrent_positions", ceiling: ptr(float64(HardCeilings.MaxConcurrentPositions))})
		perSymbol, ps := c.number(limits, "max_positions_per_symbol", "limits", true, numberRule{integer: true, min: ptr(1.0), ceilingKey: "max_positions_per_symbol", ceiling: ptr(float64(HardCeilings.MaxPositionsPerSymbol))})
		if co && ps && perSymbol > concurrent {
			c.fail("limits.max_positions_per_symbol", fmt.Sprintf("must be <= max_concurrent_positions %s (got %s)", formatNum(concurrent), formatNum(perSymbol)), perSymbol, concurrent)
		}
		c.number(limits, "max_spread_price", "limits", true, numberRule{min: ptr(0.0), minExclusive: true, ceilingKey: "max_spread_price", ceiling: ptr(HardCeilings.MaxSpreadPrice)})
		c.number(limits, "max_deviation_points", "limits", true, numberRule{integer: true, min: ptr(0.0), ceilingKey: "max_deviation_points", ceiling: ptr(float64(HardCeilings.MaxDeviationPoints))})
		c.number(limits, "signal_max_age_sec", "limits", true, numberRule{integer: true, min: ptr(5.0), max: ptr(3600.0), ceilingKey: "max_signal_age_sec", ceiling: ptr(float64(HardCeilings.MaxSignalAgeSec))})
		c.number(limits, "daily_loss_limit_money", "limits", true, numberRule{min: ptr(0.0), minExclusive: true, ceilingKey: "daily_loss_limit_money", ceiling: ptr(HardCeilings.DailyLossLimitMoney)})
		c.number(limits, "max_total_risk_percent", "limits", true, numberRule{min: ptr(0.0), minExclusive: true, max: ptr(50.0), ceilingKey: "max_total_risk_percent", ceiling: ptr(HardCeilings.MaxTotalRiskPercent)})
	}

	edits := c.section(root, "edits", "", editKeys)
	if edits != nil {
		c.enum(edits, "before_fill", "edits", true, "ignore", "apply_sl_tp")
		c.enum(edits, "after_fill", "edits", true, "ignore", "apply_tighten_only", "apply")
		c.enum(edits, "unparseable_edit", "edits", true, "ignore", "cancel_pending_only")
		c.enum(edits, "explicit_cancel", "edits", true, "ignore", "cancel_pending_only", "close_position")
	}
	if v, exists := root["recommendations"]; exists {
		if _, ok := isMap(v); !ok {
			c.fail("recommendations", "must be an object", v, nil)
		}
	}
}

func ValidateProfile(input any) ValidationResult[ExecutionProfile] {
	c := &validationContext{errors: []ValidationIssue{}, warnings: []ValidationIssue{}}
	root := jsonObject(input)
	if root == nil {
		root = c.object(input, "", profileKeys)
	} else {
		root = c.object(root, "", profileKeys)
	}
	if root != nil {
		checkProfile(c, root)
	}
	result := ValidationResult[ExecutionProfile]{OK: len(c.errors) == 0, Errors: c.errors, Warnings: c.warnings}
	if result.OK {
		data, err := json.Marshal(input)
		if err == nil {
			var profile ExecutionProfile
			if json.Unmarshal(data, &profile) == nil {
				result.Value = &profile
			}
		}
		if result.Value == nil {
			result.OK = false
			result.Errors = append(result.Errors, ValidationIssue{Path: "$", Message: "profile could not be decoded"})
		}
	}
	return result
}

var safetyKeys = []string{"max_risk_percent_per_trade", "max_risk_money_per_trade", "max_lots_per_trade", "max_concurrent_positions", "max_positions_per_symbol", "daily_loss_limit_money", "max_total_risk_percent", "max_spread_price", "max_deviation_points", "max_signal_age_sec", "min_margin_level_percent", "allowed_signal_symbols"}

func ValidateSafetyLimits(input any) ValidationResult[SafetyLimits] {
	c := &validationContext{errors: []ValidationIssue{}, warnings: []ValidationIssue{}}
	root := jsonObject(input)
	var s map[string]any
	if root == nil {
		s = c.object(input, "", safetyKeys)
	} else {
		s = c.object(root, "", safetyKeys)
	}
	if s != nil {
		checks := []struct {
			key       string
			min, max  float64
			integer   bool
			exclusive bool
		}{
			{"max_risk_percent_per_trade", 0, HardCeilings.MaxRiskPercentPerTrade, false, true},
			{"max_risk_money_per_trade", 0, HardCeilings.MaxRiskMoneyPerTrade, false, true},
			{"max_lots_per_trade", 0, HardCeilings.MaxLotsPerTrade, false, true},
			{"max_concurrent_positions", 0, float64(HardCeilings.MaxConcurrentPositions), true, true},
			{"max_positions_per_symbol", 0, float64(HardCeilings.MaxPositionsPerSymbol), true, true},
			{"daily_loss_limit_money", 0, HardCeilings.DailyLossLimitMoney, false, true},
			{"max_total_risk_percent", 0, HardCeilings.MaxTotalRiskPercent, false, true},
			{"max_spread_price", 0, HardCeilings.MaxSpreadPrice, false, true},
			{"max_deviation_points", 0, float64(HardCeilings.MaxDeviationPoints), true, true},
			{"max_signal_age_sec", 0, float64(HardCeilings.MaxSignalAgeSec), true, true},
			{"min_margin_level_percent", 0, HardCeilings.MinMarginLevelPercent, false, false},
		}
		for _, x := range checks {
			c.number(s, x.key, "", true, numberRule{integer: x.integer, min: &x.min, minExclusive: x.exclusive, max: &x.max})
		}
		rows := c.array(s, "allowed_signal_symbols", "")
		if rows != nil {
			if len(rows) == 0 {
				c.fail("allowed_signal_symbols", "must contain at least one symbol", nil, nil)
			}
			for i, row := range rows {
				str, ok := row.(string)
				if !ok || !signalSymPattern.MatchString(str) {
					c.fail(fmt.Sprintf("allowed_signal_symbols.%d", i), "must be an uppercase symbol string", row, nil)
				}
			}
		}
	}
	result := ValidationResult[SafetyLimits]{OK: len(c.errors) == 0, Errors: c.errors, Warnings: c.warnings}
	if result.OK {
		data, err := json.Marshal(input)
		if err == nil {
			var safety SafetyLimits
			if json.Unmarshal(data, &safety) == nil {
				result.Value = &safety
			}
		}
		if result.Value == nil {
			result.OK = false
			result.Errors = append(result.Errors, ValidationIssue{Path: "$", Message: "safety limits could not be decoded"})
		}
	}
	return result
}

func jsonObject(input any) map[string]any {
	if object, ok := isMap(input); ok {
		return object
	}
	data, err := json.Marshal(input)
	if err != nil {
		return nil
	}
	var object map[string]any
	if json.Unmarshal(data, &object) != nil {
		return nil
	}
	return object
}

type safetyMapping struct {
	path, key string
	value     func(ExecutionProfile) float64
}

var safetyMappings = []safetyMapping{
	{"sizing.fixed_lots", "max_lots_per_trade", func(p ExecutionProfile) float64 {
		if p.Sizing.FixedLots != nil {
			return *p.Sizing.FixedLots
		}
		return math.NaN()
	}},
	{"sizing.risk_money", "max_risk_money_per_trade", func(p ExecutionProfile) float64 {
		if p.Sizing.RiskMoney != nil {
			return *p.Sizing.RiskMoney
		}
		return math.NaN()
	}},
	{"sizing.risk_percent", "max_risk_percent_per_trade", func(p ExecutionProfile) float64 {
		if p.Sizing.RiskPercent != nil {
			return *p.Sizing.RiskPercent
		}
		return math.NaN()
	}},
	{"limits.max_concurrent_positions", "max_concurrent_positions", func(p ExecutionProfile) float64 { return float64(p.Limits.MaxConcurrentPositions) }},
	{"limits.max_positions_per_symbol", "max_positions_per_symbol", func(p ExecutionProfile) float64 { return float64(p.Limits.MaxPositionsPerSymbol) }},
	{"limits.max_spread_price", "max_spread_price", func(p ExecutionProfile) float64 { return p.Limits.MaxSpreadPrice }},
	{"limits.max_deviation_points", "max_deviation_points", func(p ExecutionProfile) float64 { return float64(p.Limits.MaxDeviationPoints) }},
	{"limits.signal_max_age_sec", "max_signal_age_sec", func(p ExecutionProfile) float64 { return float64(p.Limits.SignalMaxAgeSec) }},
	{"limits.daily_loss_limit_money", "daily_loss_limit_money", func(p ExecutionProfile) float64 { return p.Limits.DailyLossLimitMoney }},
	{"limits.max_total_risk_percent", "max_total_risk_percent", func(p ExecutionProfile) float64 { return p.Limits.MaxTotalRiskPercent }},
}

func ValidateProfileAgainstSafety(profile ExecutionProfile, safety SafetyLimits) []ValidationIssue {
	issues := []ValidationIssue{}
	limits := map[string]float64{
		"max_lots_per_trade": safety.MaxLotsPerTrade, "max_risk_money_per_trade": safety.MaxRiskMoneyPerTrade,
		"max_risk_percent_per_trade": safety.MaxRiskPercentPerTrade, "max_concurrent_positions": float64(safety.MaxConcurrentPositions),
		"max_positions_per_symbol": float64(safety.MaxPositionsPerSymbol), "max_spread_price": safety.MaxSpreadPrice,
		"max_deviation_points": float64(safety.MaxDeviationPoints), "max_signal_age_sec": float64(safety.MaxSignalAgeSec),
		"daily_loss_limit_money": safety.DailyLossLimitMoney, "max_total_risk_percent": safety.MaxTotalRiskPercent,
	}
	for _, m := range safetyMappings {
		v := m.value(profile)
		limit := limits[m.key]
		if !math.IsNaN(v) && v > limit {
			leaf := m.path[strings.LastIndex(m.path, ".")+1:]
			issues = append(issues, ValidationIssue{Path: m.path, Message: fmt.Sprintf("%s %s exceeds safety limit %s %s", leaf, formatNum(v), m.key, formatNum(limit)), Value: v, Limit: limit})
		}
	}
	allowed := map[string]bool{}
	for _, s := range safety.AllowedSignalSymbols {
		allowed[strings.ToUpper(s)] = true
	}
	for i, row := range profile.Symbols {
		if !allowed[strings.ToUpper(row.SignalSymbol)] {
			issues = append(issues, ValidationIssue{Path: fmt.Sprintf("symbols.%d.signal_symbol", i), Message: fmt.Sprintf("signal_symbol %s is not in allowed_signal_symbols [%s]", row.SignalSymbol, strings.Join(safety.AllowedSignalSymbols, ", ")), Value: row.SignalSymbol, Limit: safety.AllowedSignalSymbols})
		}
	}
	return issues
}

func ResolveEffectiveLimits(profile ExecutionProfile, safety SafetyLimits) EffectiveLimits {
	min := func(a, b float64) float64 {
		if a < b {
			return a
		}
		return b
	}
	minInt := func(a, b int) int {
		if a < b {
			return a
		}
		return b
	}
	return EffectiveLimits{
		MaxRiskPercent: safety.MaxRiskPercentPerTrade, MaxRiskMoney: safety.MaxRiskMoneyPerTrade, MaxLots: safety.MaxLotsPerTrade,
		MaxConcurrent:         minInt(profile.Limits.MaxConcurrentPositions, safety.MaxConcurrentPositions),
		MaxPerSymbol:          minInt(profile.Limits.MaxPositionsPerSymbol, safety.MaxPositionsPerSymbol),
		DailyLossLimit:        min(profile.Limits.DailyLossLimitMoney, safety.DailyLossLimitMoney),
		MaxTotalRiskPercent:   min(profile.Limits.MaxTotalRiskPercent, safety.MaxTotalRiskPercent),
		MaxSpreadPrice:        min(profile.Limits.MaxSpreadPrice, safety.MaxSpreadPrice),
		MaxDeviationPoints:    minInt(profile.Limits.MaxDeviationPoints, safety.MaxDeviationPoints),
		MaxSignalAgeSec:       minInt(profile.Limits.SignalMaxAgeSec, safety.MaxSignalAgeSec),
		MinMarginLevelPercent: safety.MinMarginLevelPercent,
	}
}

func ProfileDocID(profileID string, version int) string {
	return fmt.Sprintf("%s__v%d", profileID, version)
}

func ResolveBrokerSymbol(profile ExecutionProfile, signalSymbol string) (string, bool) {
	wanted := strings.ToUpper(signalSymbol)
	for _, row := range profile.Symbols {
		if strings.ToUpper(row.SignalSymbol) == wanted {
			return row.BrokerSymbol, true
		}
	}
	return "", false
}

var profileEnvelopeFields = map[string]bool{
	"status": true, "validation": true, "doc_id": true, "created_at": true, "created_by": true, "created_by_uid": true,
	"updated_at": true, "updated_by": true, "updated_by_uid": true, "approved_at": true, "approved_by": true,
	"approved_by_uid": true, "activated_at": true, "activated_by": true, "activated_by_uid": true,
	"superseded_at": true, "rejected_at": true, "rejected_by": true, "rejected_by_uid": true, "rejected_reason": true,
}

func StripProfileEnvelope(raw map[string]any) map[string]any {
	out := make(map[string]any, len(raw))
	for k, v := range raw {
		if !profileEnvelopeFields[k] {
			out[k] = v
		}
	}
	return out
}
