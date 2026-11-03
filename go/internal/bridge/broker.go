package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"sync"
	"time"

	"github.com/bytrader/bytrader/internal/broker"
)

const (
	offsetTTL       = time.Minute
	maxCommentChars = 31
)

var pendingTypes = map[broker.OrderType]bool{
	broker.BuyLimit: true, broker.SellLimit: true, broker.BuyStop: true, broker.SellStop: true,
}

type MT5BrokerOptions struct {
	Magic  int64
	Client *Client
	Now    func() time.Time
}

type MT5Broker struct {
	mu       sync.RWMutex
	magic    int64
	client   *Client
	now      func() time.Time
	offset   int64
	offsetAt time.Time
}

func NewMT5Broker(opts MT5BrokerOptions) (*MT5Broker, error) {
	if opts.Magic <= 0 {
		return nil, fmt.Errorf("invalid MT5 magic: %d", opts.Magic)
	}
	if opts.Client == nil {
		return nil, errors.New("MT5 bridge client is required")
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &MT5Broker{magic: opts.Magic, client: opts.Client, now: opts.Now}, nil
}

func (b *MT5Broker) Kind() broker.Kind { return broker.MT5 }
func (b *MT5Broker) Magic() int64      { return b.magic }

func (b *MT5Broker) Ping(ctx context.Context) (broker.PingInfo, error) {
	d, err := b.call(ctx, "PING", nil, false)
	if err != nil {
		return broker.PingInfo{}, err
	}
	b.applyPing(d)
	return broker.PingInfo{
		EAVersion: str(d["ea_version"]), TerminalConnected: boolean(d["terminal_connected"]),
		TradeAllowed: boolean(d["terminal_trade_allowed"]) && boolean(d["mql_trade_allowed"]),
		GMTTime:      integer(d["gmt_time"]), ServerTime: integer(d["server_time"]),
		ServerTimeSource: str(d["server_time_source"]),
	}, nil
}

func (b *MT5Broker) GetAccountInfo(ctx context.Context) (broker.AccountInfo, error) {
	d, err := b.call(ctx, "ACCOUNT_INFO", nil, false)
	if err != nil {
		return broker.AccountInfo{}, err
	}
	return broker.AccountInfo{
		Login: integer(d["login"]), TradeMode: broker.TradeMode(strOr(d["trade_mode"], "REAL")),
		MarginMode: strOr(d["margin_mode"], "UNKNOWN"), Currency: str(d["currency"]),
		Balance: number(d["balance"]), Equity: number(d["equity"]), Margin: number(d["margin"]),
		MarginFree: number(d["margin_free"]), MarginLevel: number(d["margin_level"]),
		Leverage: int(number(d["leverage"])), TradeAllowed: boolean(d["trade_allowed"]),
		TradeExpert: boolean(d["trade_expert"]), TerminalTradeAllowed: boolean(d["terminal_trade_allowed"]),
		Server: str(d["server"]), Company: str(d["company"]),
	}, nil
}

func (b *MT5Broker) GetSymbolInfo(ctx context.Context, symbol string) (broker.SymbolInfo, error) {
	offset, err := b.ensureOffset(ctx)
	if err != nil {
		return broker.SymbolInfo{}, err
	}
	d, err := b.call(ctx, "SYMBOL_INFO", map[string]any{"symbol": symbol, "auto_suffix": true}, false)
	if err != nil {
		return broker.SymbolInfo{}, err
	}
	tick := integer(d["tick_time_msc"])
	if tick > 0 {
		tick -= offset * 1000
	}
	return broker.SymbolInfo{
		Symbol: strOr(d["symbol"], symbol), Digits: int(number(d["digits"])), Point: number(d["point"]),
		TickSize: number(d["tick_size"]), TickValue: number(d["tick_value"]),
		TickValueProfit: number(d["tick_value_profit"]), TickValueLoss: number(d["tick_value_loss"]),
		ContractSize: number(d["contract_size"]), VolumeMin: number(d["volume_min"]),
		VolumeMax: number(d["volume_max"]), VolumeStep: number(d["volume_step"]),
		VolumeLimit: number(d["volume_limit"]), StopsLevelPoints: number(d["stops_level"]),
		FreezeLevelPoints: number(d["freeze_level"]), TradeMode: strOr(d["trade_mode"], "DISABLED"),
		FillingFOK: boolean(d["filling_fok"]), FillingIOC: boolean(d["filling_ioc"]),
		Bid: number(d["bid"]), Ask: number(d["ask"]), SpreadPoints: number(d["spread_points"]),
		TickTimeMsc: tick, CurrencyProfit: str(d["currency_profit"]), CurrencyMargin: str(d["currency_margin"]),
	}, nil
}

func (b *MT5Broker) GetPositions(ctx context.Context, symbol string) ([]broker.Position, error) {
	offset, err := b.ensureOffset(ctx)
	if err != nil {
		return nil, err
	}
	params := map[string]any{"magic": b.magic}
	if symbol != "" {
		params["symbol"] = symbol
	}
	d, err := b.call(ctx, "GET_POSITIONS", params, false)
	if err != nil {
		return nil, err
	}
	positions := []broker.Position{}
	for _, row := range rows(d["positions"]) {
		if integer(row["magic"]) != b.magic {
			continue
		}
		positions = append(positions, broker.Position{
			Ticket: integer(row["ticket"]), Identifier: integer(row["identifier"]), Symbol: str(row["symbol"]),
			Type: broker.OrderSide(strOr(row["type"], "OTHER")), Volume: number(row["volume"]),
			OpenPrice: number(row["open_price"]), PriceCurrent: number(row["price_current"]),
			SL: number(row["sl"]), TP: number(row["tp"]), Profit: number(row["profit"]),
			Swap: number(row["swap"]), Magic: integer(row["magic"]), Comment: str(row["comment"]),
			TimeOpen: serverToGMT(integer(row["time_open"]), offset),
		})
	}
	return positions, nil
}

func (b *MT5Broker) GetOrders(ctx context.Context, symbol string) ([]broker.Order, error) {
	offset, err := b.ensureOffset(ctx)
	if err != nil {
		return nil, err
	}
	params := map[string]any{"magic": b.magic}
	if symbol != "" {
		params["symbol"] = symbol
	}
	d, err := b.call(ctx, "GET_ORDERS", params, false)
	if err != nil {
		return nil, err
	}
	orders := []broker.Order{}
	for _, row := range rows(d["orders"]) {
		typ := broker.OrderType(strOr(row["type"], "OTHER"))
		if integer(row["magic"]) != b.magic || !pendingTypes[typ] {
			continue
		}
		orders = append(orders, broker.Order{
			Ticket: integer(row["ticket"]), Symbol: str(row["symbol"]), Type: typ,
			VolumeInitial: number(row["volume_initial"]), VolumeCurrent: number(row["volume_current"]),
			PriceOpen: number(row["price_open"]), SL: number(row["sl"]), TP: number(row["tp"]),
			Magic: integer(row["magic"]), Comment: str(row["comment"]),
			TimeSetup:      serverToGMT(integer(row["time_setup"]), offset),
			TimeExpiration: serverToGMT(integer(row["time_expiration"]), offset),
		})
	}
	return orders, nil
}

func (b *MT5Broker) GetDeals(ctx context.Context, q broker.DealQuery) ([]broker.Deal, error) {
	if !finite(float64(q.FromSec)) {
		return nil, &broker.RejectedError{Retcode: 4001, Message: "get deals: from must be finite"}
	}
	offset, err := b.ensureOffset(ctx)
	if err != nil {
		return nil, err
	}
	params := map[string]any{"from": q.FromSec + offset, "magic": b.magic}
	if q.ToSec != nil {
		params["to"] = *q.ToSec + offset
	}
	if q.PositionID != nil {
		params["position_id"] = *q.PositionID
	}
	d, err := b.call(ctx, "GET_DEALS", params, false)
	if err != nil {
		return nil, err
	}
	deals := []broker.Deal{}
	for _, row := range rows(d["deals"]) {
		magic := integer(row["magic"])
		positionID := integer(row["position_id"])
		if magic != b.magic || q.PositionID != nil && positionID != *q.PositionID {
			continue
		}
		deals = append(deals, broker.Deal{
			Ticket: integer(row["ticket"]), Order: integer(row["order"]), PositionID: positionID,
			Symbol: str(row["symbol"]), Type: broker.OrderSide(strOr(row["type"], "OTHER")),
			Entry: strOr(row["entry"], "OUT"), Volume: number(row["volume"]), Price: number(row["price"]),
			Profit: number(row["profit"]), Commission: number(row["commission"]), Swap: number(row["swap"]),
			Fee: number(row["fee"]), Magic: magic, Comment: str(row["comment"]),
			Time: serverToGMT(integer(row["time"]), offset), Reason: strOr(row["reason"], "OTHER"),
		})
	}
	return deals, nil
}

func (b *MT5Broker) CheckOrder(ctx context.Context, req broker.PlaceOrderRequest) (broker.OrderCheckResult, error) {
	if err := validateOrder(req); err != nil {
		return broker.OrderCheckResult{}, err
	}
	params := orderParams(req)
	d, err := b.call(ctx, "ORDER_CHECK", params, false)
	if err != nil {
		var bridgeErr *BridgeError
		if errors.As(err, &bridgeErr) && bridgeErr.Data != nil {
			return broker.OrderCheckResult{OK: false, Retcode: integerInt(bridgeErr.Data["retcode"]),
				Margin: number(bridgeErr.Data["margin"]), MarginFree: number(bridgeErr.Data["margin_free"]),
				Comment: strOr(bridgeErr.Data["comment"], bridgeErr.Message)}, nil
		}
		return broker.OrderCheckResult{}, err
	}
	retcode := integerInt(d["retcode"])
	return broker.OrderCheckResult{OK: retcode == 0, Retcode: retcode, Margin: number(d["margin"]),
		MarginFree: number(d["margin_free"]), Comment: str(d["comment"])}, nil
}

func (b *MT5Broker) PlaceOrder(ctx context.Context, req broker.PlaceOrderRequest) (broker.PlaceOrderResult, error) {
	if err := validateOrder(req); err != nil {
		return broker.PlaceOrderResult{}, err
	}
	if !pendingTypes[req.OrderType] {
		spec, err := b.GetSymbolInfo(ctx, req.Symbol)
		if err != nil {
			return broker.PlaceOrderResult{}, err
		}
		if err := validateMarketEntryFilling(spec); err != nil {
			return broker.PlaceOrderResult{}, err
		}
	}
	offset, err := b.ensureOffset(ctx)
	if err != nil {
		return broker.PlaceOrderResult{}, err
	}
	params := orderParams(req)
	params["comment"], params["magic"] = req.Comment, b.magic
	if req.ExpirationGMT != nil {
		params["expiration"] = *req.ExpirationGMT + offset
	}
	d, err := b.call(ctx, "ORDER_SEND", params, true)
	if err != nil {
		return broker.PlaceOrderResult{}, err
	}
	retcode := integerInt(d["retcode"])
	duplicate := boolean(d["duplicate"])
	if !duplicate && retcode != 10008 && retcode != 10009 && retcode != 10010 {
		return broker.PlaceOrderResult{}, &broker.RejectedError{Retcode: retcode, Message: fmt.Sprintf("ORDER_SEND returned unexpected retcode %d", retcode)}
	}
	result := broker.PlaceOrderResult{Retcode: retcode, OrderTicket: integer(d["order"]), DealTicket: integer(d["deal"]),
		PositionTicket: integer(d["position"]), Price: number(d["price"]), Volume: number(d["volume"]), Duplicate: duplicate}
	if value, ok := d["expiration_applied"].(bool); ok {
		result.ExpirationApplied = &value
	}
	return result, nil
}

func (b *MT5Broker) ModifyPosition(ctx context.Context, ticket int64, sl, tp float64) (int, bool, error) {
	d, err := b.call(ctx, "POSITION_MODIFY", map[string]any{"ticket": ticket, "sl": sl, "tp": tp}, true)
	if err != nil {
		return 0, false, err
	}
	retcode, unchanged := integerInt(d["retcode"]), boolean(d["unchanged"])
	if err := mutationRetcodeError("POSITION_MODIFY", retcode); err != nil {
		return retcode, unchanged, err
	}
	return retcode, unchanged, nil
}

func (b *MT5Broker) ModifyPendingOrder(ctx context.Context, ticket int64, price, sl, tp float64) (int, error) {
	d, err := b.call(ctx, "PENDING_MODIFY", map[string]any{"ticket": ticket, "price": price, "sl": sl, "tp": tp}, true)
	if err != nil {
		return 0, err
	}
	retcode := integerInt(d["retcode"])
	if err := mutationRetcodeError("PENDING_MODIFY", retcode); err != nil {
		return retcode, err
	}
	return retcode, nil
}

func (b *MT5Broker) ClosePosition(ctx context.Context, ticket int64, volume *float64) (broker.CloseResult, error) {
	positions, err := b.GetPositions(ctx, "")
	if err != nil {
		return broker.CloseResult{}, err
	}
	var selected *broker.Position
	for i := range positions {
		if positions[i].Ticket == ticket && positions[i].Magic == b.magic {
			selected = &positions[i]
			break
		}
	}
	if selected == nil {
		return broker.CloseResult{}, &broker.RejectedError{Retcode: 5008, Message: "close position preflight could not find the exact owned ticket"}
	}
	spec, err := b.GetSymbolInfo(ctx, selected.Symbol)
	if err != nil {
		return broker.CloseResult{}, err
	}
	if err := validateCloseFilling(spec); err != nil {
		return broker.CloseResult{}, err
	}
	params := map[string]any{"ticket": ticket}
	if volume != nil {
		if !finite(*volume) || *volume <= 0 {
			return broker.CloseResult{}, &broker.RejectedError{Retcode: 4001, Message: "close volume must be finite and > 0"}
		}
		params["volume"] = *volume
	}
	d, err := b.call(ctx, "CLOSE_POSITION", params, true)
	if err != nil {
		return broker.CloseResult{}, err
	}
	retcode := integerInt(d["retcode"])
	if err := closeRetcodeError(retcode); err != nil {
		return broker.CloseResult{}, err
	}
	return broker.CloseResult{Retcode: retcode, DealTicket: integer(d["deal"]),
		ClosedVolume: number(d["closed_volume"]), Price: number(d["price"]), RemainingVolume: number(d["remaining_volume"])}, nil
}

func validateCloseFilling(spec broker.SymbolInfo) error {
	if spec.FillingFOK || spec.FillingIOC {
		return nil
	}
	return &broker.RejectedError{Retcode: 4001, Message: fmt.Sprintf("close on %s requires FOK or IOC; RETURN can leave a remainder working after a partial result", spec.Symbol)}
}

func validateMarketEntryFilling(spec broker.SymbolInfo) error {
	if spec.FillingFOK || spec.FillingIOC {
		return nil
	}
	return &broker.RejectedError{Retcode: 4001, Message: fmt.Sprintf("market entry on %s requires FOK or IOC; RETURN can leave a remainder working after a partial result", spec.Symbol)}
}

func closeRetcodeError(retcode int) error {
	if retcode == 10008 {
		return &broker.AmbiguousError{Action: "CLOSE_POSITION", Message: "broker placed the close request but did not confirm completion; exact ticket state must be reconciled"}
	}
	if retcode != 10009 && retcode != 10010 {
		return &broker.RejectedError{Retcode: retcode, Message: fmt.Sprintf("CLOSE_POSITION returned unexpected retcode %d", retcode)}
	}
	return nil
}

func (b *MT5Broker) CancelOrder(ctx context.Context, ticket int64) (int, error) {
	d, err := b.call(ctx, "CANCEL_ORDER", map[string]any{"ticket": ticket}, true)
	if err != nil {
		return 0, err
	}
	retcode := integerInt(d["retcode"])
	if err := mutationRetcodeError("CANCEL_ORDER", retcode); err != nil {
		return retcode, err
	}
	return retcode, nil
}

func mutationRetcodeError(action string, retcode int) error {
	if retcode != 10008 && retcode != 10010 || action == "ORDER_SEND" {
		return nil
	}
	message := "broker reported a pending result; exact ticket state must be reconciled"
	if retcode == 10010 {
		message = "broker reported a partial result; exact ticket state must be reconciled"
	}
	return &broker.AmbiguousError{Action: action, Message: message}
}

func (b *MT5Broker) call(ctx context.Context, action string, params map[string]any, mutation bool) (map[string]any, error) {
	data, err := b.client.Do(ctx, action, params)
	if err == nil {
		return data, nil
	}
	var bridgeErr *BridgeError
	var ambiguous *AmbiguousError
	var unavailable *UnavailableError
	switch {
	case errors.As(err, &bridgeErr):
		return nil, &broker.RejectedError{Retcode: bridgeErr.Retcode, Message: bridgeErr.Error()}
	case errors.As(err, &ambiguous):
		expires := ambiguous.ExpiresAt
		return nil, &broker.AmbiguousError{Action: action, RequestID: ambiguous.RequestID, ExpiresAt: &expires, Message: ambiguous.Error()}
	case errors.As(err, &unavailable):
		return nil, &broker.UnavailableError{Action: action, Message: unavailable.Error()}
	default:
		if mutation {
			return nil, &broker.AmbiguousError{Action: action, Message: err.Error()}
		}
		return nil, &broker.UnavailableError{Action: action, Message: err.Error()}
	}
}

func (b *MT5Broker) ensureOffset(ctx context.Context) (int64, error) {
	now := b.now()
	b.mu.RLock()
	offset, offsetAt := b.offset, b.offsetAt
	b.mu.RUnlock()
	age := now.Sub(offsetAt)
	if !offsetAt.IsZero() && age >= 0 && age < offsetTTL {
		return offset, nil
	}
	if _, err := b.Ping(ctx); err != nil {
		return 0, err
	}
	b.mu.RLock()
	offset, offsetAt = b.offset, b.offsetAt
	b.mu.RUnlock()
	age = b.now().Sub(offsetAt)
	if offsetAt.IsZero() || age < 0 || age >= offsetTTL {
		return 0, &broker.UnavailableError{Action: "PING", Message: "server time offset is unknown"}
	}
	return offset, nil
}

func (b *MT5Broker) applyPing(d map[string]any) {
	server, gmt := number(d["server_time"]), number(d["gmt_time"])
	source := str(d["server_time_source"])
	b.mu.Lock()
	defer b.mu.Unlock()
	b.offset = 0
	b.offsetAt = time.Time{}
	if source != "TimeTradeServer" || !finite(server) || !finite(gmt) || server <= 0 || gmt <= 0 {
		return
	}
	raw := server - gmt
	rounded := math.Round(raw/900) * 900
	if math.Abs(raw) > 14*3600 || math.Abs(raw-rounded) > 5 {
		return
	}
	b.offset = int64(rounded)
	b.offsetAt = b.now()
}

func orderParams(req broker.PlaceOrderRequest) map[string]any {
	price := req.Price
	if !pendingTypes[req.OrderType] {
		price = 0
	}
	return map[string]any{"symbol": req.Symbol, "order_type": req.OrderType, "volume": req.Volume,
		"price": price, "sl": req.SL, "tp": req.TP, "deviation": req.DeviationPoints}
}

func validateOrder(req broker.PlaceOrderRequest) error {
	bad := func(reason string) error {
		return &broker.RejectedError{Retcode: 4001, Message: "invalid order request: " + reason}
	}
	valid := req.OrderType == broker.MarketBuy || req.OrderType == broker.MarketSell || pendingTypes[req.OrderType]
	if req.Symbol == "" {
		return bad("symbol required")
	}
	if !valid {
		return bad("unknown order type")
	}
	if !finite(req.Volume) || req.Volume <= 0 {
		return bad("volume must be finite and > 0")
	}
	if !finite(req.Price) || req.Price < 0 || pendingTypes[req.OrderType] && req.Price <= 0 {
		return bad("invalid price")
	}
	if !finite(req.SL) || req.SL < 0 || !finite(req.TP) || req.TP < 0 {
		return bad("SL and TP must be finite and >= 0")
	}
	if req.DeviationPoints < 0 {
		return bad("deviation must be >= 0")
	}
	if len([]rune(req.Comment)) > maxCommentChars {
		return bad("comment exceeds 31 characters")
	}
	if req.ExpirationGMT != nil && *req.ExpirationGMT <= 0 {
		return bad("expiration must be > 0")
	}
	return nil
}

func serverToGMT(server, offset int64) int64 {
	if server == 0 {
		return 0
	}
	return server - offset
}
func finite(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) }
func number(v any) float64 {
	switch n := v.(type) {
	case float64:
		if finite(n) {
			return n
		}
	case float32:
		if finite(float64(n)) {
			return float64(n)
		}
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		f, err := strconv.ParseFloat(string(n), 64)
		if err == nil && finite(f) {
			return f
		}
	}
	return 0
}

func integer(v any) int64  { return int64(number(v)) }
func integerInt(v any) int { return int(number(v)) }
func boolean(v any) bool   { value, _ := v.(bool); return value }
func str(v any) string     { value, _ := v.(string); return value }
func strOr(v any, fallback string) string {
	if value := str(v); value != "" {
		return value
	}
	return fallback
}
func rows(v any) []map[string]any {
	items, _ := v.([]any)
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if row, ok := item.(map[string]any); ok {
			out = append(out, row)
		}
	}
	return out
}

var _ broker.Broker = (*MT5Broker)(nil)
