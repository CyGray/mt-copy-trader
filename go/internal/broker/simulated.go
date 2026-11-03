package broker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"sync"
	"time"
)

const (
	retcodePlaced        = 10008
	retcodeDone          = 10009
	retcodeRejected      = 10006
	retcodeInvalidPrice  = 10015
	retcodeNoQuote       = 10018
	duplicateLookbackSec = int64(7 * 86400)
	dealRetentionSec     = int64(30 * 86400)
	volumeEpsilon        = 1e-9
	priceEpsilon         = 1e-9
)

type Quote struct {
	Bid     float64 `json:"bid"`
	Ask     float64 `json:"ask"`
	TimeMsc int64   `json:"timeMsc,omitempty"`
}

type SimPosition struct {
	Ticket          int64     `json:"ticket"`
	Symbol          string    `json:"symbol"`
	Type            OrderSide `json:"type"`
	Volume          float64   `json:"volume"`
	OpenPrice       float64   `json:"openPrice"`
	SL              float64   `json:"sl"`
	TP              float64   `json:"tp"`
	Magic           int64     `json:"magic"`
	Comment         string    `json:"comment"`
	TimeOpen        int64     `json:"timeOpen"`
	OpenOrderTicket int64     `json:"openOrderTicket"`
	OpenDealTicket  int64     `json:"openDealTicket"`
}

type SimOrder struct {
	Ticket         int64     `json:"ticket"`
	Symbol         string    `json:"symbol"`
	Type           OrderType `json:"type"`
	Volume         float64   `json:"volume"`
	PriceOpen      float64   `json:"priceOpen"`
	SL             float64   `json:"sl"`
	TP             float64   `json:"tp"`
	Magic          int64     `json:"magic"`
	Comment        string    `json:"comment"`
	TimeSetup      int64     `json:"timeSetup"`
	TimeExpiration int64     `json:"timeExpiration"`
}

type SimDeal struct {
	Ticket     int64     `json:"ticket"`
	Order      int64     `json:"order"`
	PositionID int64     `json:"positionId"`
	Symbol     string    `json:"symbol"`
	Type       OrderSide `json:"type"`
	Entry      string    `json:"entry"`
	Volume     float64   `json:"volume"`
	Price      float64   `json:"price"`
	Profit     float64   `json:"profit"`
	Magic      int64     `json:"magic"`
	Comment    string    `json:"comment"`
	Time       int64     `json:"time"`
	Reason     string    `json:"reason"`
}

type SimState struct {
	Version         int                   `json:"version"`
	Balance         float64               `json:"balance"`
	Specs           map[string]SymbolInfo `json:"specs"`
	SpecFetchedAt   map[string]int64      `json:"spec_fetched_at,omitempty"`
	Quotes          map[string]Quote      `json:"quotes"`
	NextOrderTicket int64                 `json:"nextOrderTicket"`
	NextDealTicket  int64                 `json:"nextDealTicket"`
	Orders          []SimOrder            `json:"orders"`
	Positions       []SimPosition         `json:"positions"`
	Deals           []SimDeal             `json:"deals"`
}

type SimPersistence interface {
	Load(context.Context) (*SimState, error)
	Save(context.Context, SimState) error
}

type FailureKind string

const (
	FailReject      FailureKind = "reject"
	FailAmbiguous   FailureKind = "ambiguous"
	FailUnavailable FailureKind = "unavailable"
)

type SimFailure struct {
	Kind    FailureKind
	Retcode int
}

type SimulatedOptions struct {
	Magic              int64
	Account            *AccountInfo
	Symbols            map[string]SymbolInfo
	SymbolProvider     func(context.Context, string) (SymbolInfo, error)
	QuoteProvider      func(context.Context, string) (Quote, error)
	Persistence        SimPersistence
	Now                func() time.Time
	SpecTTL            time.Duration
	MaxQuoteAge        time.Duration
	SupportsExpiration *bool
	RewriteComment     func(string) string
}

type EvaluateReport struct {
	Filled  []int64 `json:"filled"`
	Expired []int64 `json:"expired"`
	Closed  []struct {
		Ticket int64   `json:"ticket"`
		Reason string  `json:"reason"`
		Price  float64 `json:"price"`
		Profit float64 `json:"profit"`
	} `json:"closed"`
}

type SimulatedBroker struct {
	mu                 sync.Mutex
	magic              int64
	account            AccountInfo
	seedSpecs          map[string]SymbolInfo
	symbolProvider     func(context.Context, string) (SymbolInfo, error)
	quoteProvider      func(context.Context, string) (Quote, error)
	persistence        SimPersistence
	now                func() time.Time
	specTTL            time.Duration
	maxQuoteAge        time.Duration
	supportsExpiration bool
	rewriteComment     func(string) string
	state              *SimState
	failures           map[string][]SimFailure
	requestSeq         uint64
	durableState       *SimState
}

var defaultSimAccount = AccountInfo{
	TradeMode: Demo, MarginMode: "HEDGING", Currency: "USD", Balance: 10000, Equity: 10000,
	Leverage: 100, TradeAllowed: true, TradeExpert: true, TerminalTradeAllowed: true,
	Server: "simulated", Company: "ByTrader",
}

func NewSimulated(ctx context.Context, opts SimulatedOptions) (*SimulatedBroker, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	account := defaultSimAccount
	if opts.Account != nil {
		account = *opts.Account
		if account.Equity == 0 {
			account.Equity = account.Balance
		}
		if account.Leverage <= 0 {
			account.Leverage = defaultSimAccount.Leverage
		}
		if account.TradeMode == "" {
			account.TradeMode = defaultSimAccount.TradeMode
		}
		if account.MarginMode == "" {
			account.MarginMode = defaultSimAccount.MarginMode
		}
		if account.Currency == "" {
			account.Currency = defaultSimAccount.Currency
		}
		if account.Server == "" {
			account.Server = defaultSimAccount.Server
		}
		if account.Company == "" {
			account.Company = defaultSimAccount.Company
		}
	}
	rewrite := opts.RewriteComment
	if rewrite == nil {
		rewrite = func(s string) string { return s }
	}
	s := &SimulatedBroker{magic: opts.Magic, account: account, seedSpecs: opts.Symbols, symbolProvider: opts.SymbolProvider,
		quoteProvider: opts.QuoteProvider, persistence: opts.Persistence, now: now, specTTL: opts.SpecTTL,
		maxQuoteAge: opts.MaxQuoteAge, supportsExpiration: opts.SupportsExpiration == nil || *opts.SupportsExpiration, rewriteComment: rewrite,
		failures: map[string][]SimFailure{}}
	if opts.Persistence != nil {
		state, err := opts.Persistence.Load(ctx)
		if err != nil {
			return nil, err
		}
		if state != nil {
			if state.Version != 1 {
				return nil, fmt.Errorf("unsupported simulated broker state version %d", state.Version)
			}
			s.state = cloneState(*state)
		}
	}
	if s.state == nil {
		s.state = s.freshState()
	}
	for k, v := range opts.Symbols {
		s.state.Specs[k] = v
	}
	s.durableState = cloneState(*s.state)
	return s, nil
}

func (s *SimulatedBroker) Kind() Kind   { return Simulated }
func (s *SimulatedBroker) Magic() int64 { return s.magic }

func (s *SimulatedBroker) freshState() *SimState {
	state := &SimState{Version: 1, Balance: s.account.Balance, Specs: map[string]SymbolInfo{}, SpecFetchedAt: map[string]int64{}, Quotes: map[string]Quote{}, NextOrderTicket: 100001, NextDealTicket: 500001}
	for symbol, spec := range s.seedSpecs {
		state.Specs[symbol] = spec
		state.SpecFetchedAt[symbol] = s.now().UnixMilli()
		state.Quotes[symbol] = Quote{Bid: spec.Bid, Ask: spec.Ask, TimeMsc: spec.TickTimeMsc}
	}
	return state
}

func (s *SimulatedBroker) ensure() {
	if s.state == nil {
		s.state = s.freshState()
	}
}

func (s *SimulatedBroker) nowSec() int64 { return s.now().UTC().Unix() }

func (s *SimulatedBroker) before(method, action string) (bool, error) {
	queue := s.failures[method]
	if len(queue) == 0 {
		return false, nil
	}
	f := queue[0]
	s.failures[method] = queue[1:]
	switch f.Kind {
	case FailReject:
		code := f.Retcode
		if code == 0 {
			code = retcodeRejected
		}
		return false, &RejectedError{Retcode: code, Message: "simulated broker rejected " + method}
	case FailUnavailable:
		return false, &UnavailableError{Action: action, Message: "simulated broker unavailable before " + action}
	case FailAmbiguous:
		return true, nil
	default:
		return false, &UnavailableError{Action: action, Message: "unknown simulated failure"}
	}
}

func (s *SimulatedBroker) afterAmbiguous(action string, ambiguous bool) error {
	if !ambiguous {
		return nil
	}
	expires := s.nowSec() + 8
	s.requestSeq++
	return &AmbiguousError{Action: action, RequestID: fmt.Sprintf("sim-%d-%d", s.now().UnixMilli(), s.requestSeq), ExpiresAt: &expires, Message: "simulated mutation completed but its reply was lost"}
}

func (s *SimulatedBroker) persist(ctx context.Context) error {
	if s.persistence == nil {
		return nil
	}
	next := cloneState(*s.state)
	if err := s.persistence.Save(ctx, *next); err != nil {
		if s.durableState != nil {
			s.state = cloneState(*s.durableState)
		}
		return err
	}
	s.durableState = cloneState(*next)
	return nil
}

func cloneState(in SimState) *SimState {
	b, _ := json.Marshal(in)
	var out SimState
	_ = json.Unmarshal(b, &out)
	if out.Specs == nil {
		out.Specs = map[string]SymbolInfo{}
	}
	if out.SpecFetchedAt == nil {
		out.SpecFetchedAt = map[string]int64{}
	}
	if out.Quotes == nil {
		out.Quotes = map[string]Quote{}
	}
	return &out
}

func (s *SimulatedBroker) checkContext(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return nil
}

func (s *SimulatedBroker) FailNext(method string, kind FailureKind, retcode int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failures[method] = append(s.failures[method], SimFailure{Kind: kind, Retcode: retcode})
}

func (s *SimulatedBroker) Snapshot(ctx context.Context) (SimState, error) {
	if err := s.checkContext(ctx); err != nil {
		return SimState{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure()
	return *cloneState(*s.state), nil
}

func (s *SimulatedBroker) SetQuote(ctx context.Context, symbol string, bid, ask float64, timeMsc int64) error {
	if err := s.checkContext(ctx); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure()
	sp, ok := s.state.Specs[symbol]
	if !ok {
		return &RejectedError{Retcode: 5007, Message: "unknown symbol: " + symbol}
	}
	if timeMsc == 0 {
		timeMsc = s.now().UnixMilli()
	}
	s.state.Quotes[symbol] = Quote{Bid: bid, Ask: ask, TimeMsc: timeMsc}
	sp.Bid, sp.Ask, sp.TickTimeMsc = bid, ask, timeMsc
	s.state.Specs[symbol] = sp
	return s.persist(ctx)
}

func (s *SimulatedBroker) GetState(ctx context.Context) (SimState, error) { return s.Snapshot(ctx) }

func (s *SimulatedBroker) Ping(ctx context.Context) (PingInfo, error) {
	if err := s.checkContext(ctx); err != nil {
		return PingInfo{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure()
	return PingInfo{EAVersion: "simulated", TerminalConnected: true, TradeAllowed: s.account.TradeAllowed && s.account.TradeExpert && s.account.TerminalTradeAllowed, GMTTime: s.nowSec(), ServerTime: s.nowSec(), ServerTimeSource: "simulated"}, nil
}

func (s *SimulatedBroker) GetAccountInfo(ctx context.Context) (AccountInfo, error) {
	if err := s.checkContext(ctx); err != nil {
		return AccountInfo{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure()
	account := s.account
	account.Balance = s.state.Balance
	account.Equity = s.state.Balance
	account.Margin = 0
	for _, p := range s.state.Positions {
		account.Equity += s.positionPnL(p)
		if spec, ok := s.state.Specs[p.Symbol]; ok && account.Leverage > 0 {
			account.Margin += p.Volume * spec.ContractSize * p.OpenPrice / float64(account.Leverage)
		}
	}
	account.MarginFree = account.Equity - account.Margin
	if account.Margin > 0 {
		account.MarginLevel = account.Equity / account.Margin * 100
	} else {
		account.MarginLevel = 0
	}
	return account, nil
}

func (s *SimulatedBroker) GetSymbolInfo(ctx context.Context, symbol string) (SymbolInfo, error) {
	if err := s.checkContext(ctx); err != nil {
		return SymbolInfo{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure()
	return s.symbolInfoLocked(ctx, symbol)
}

func (s *SimulatedBroker) symbolInfoLocked(ctx context.Context, symbol string) (SymbolInfo, error) {
	sp, ok := s.state.Specs[symbol]
	fetched := s.state.SpecFetchedAt[symbol]
	refresh := !ok || s.specTTL > 0 && s.now().UnixMilli()-fetched >= s.specTTL.Milliseconds()
	if refresh && s.symbolProvider != nil {
		fresh, err := s.symbolProvider(ctx, symbol)
		if err != nil {
			return SymbolInfo{}, err
		}
		sp, ok = fresh, true
		s.state.Specs[symbol] = fresh
		s.state.SpecFetchedAt[symbol] = s.now().UnixMilli()
	} else if !ok {
		return SymbolInfo{}, &RejectedError{Retcode: 5007, Message: "unknown symbol: " + symbol}
	}
	q, ok := s.state.Quotes[symbol]
	if s.quoteProvider != nil {
		fresh, err := s.quoteProvider(ctx, symbol)
		if err != nil {
			return SymbolInfo{}, err
		}
		q, ok = fresh, true
		s.state.Quotes[symbol] = fresh
	}
	if !ok {
		q = Quote{Bid: sp.Bid, Ask: sp.Ask, TimeMsc: sp.TickTimeMsc}
	}
	if q.TimeMsc == 0 {
		q.TimeMsc = s.now().UnixMilli()
	}
	sp.Bid, sp.Ask, sp.TickTimeMsc = q.Bid, q.Ask, q.TimeMsc
	if sp.Point > 0 {
		sp.SpreadPoints = math.Round((q.Ask - q.Bid) / sp.Point)
	}
	s.state.Specs[symbol] = sp
	return sp, nil
}

func (s *SimulatedBroker) GetPositions(ctx context.Context, symbol string) ([]Position, error) {
	if err := s.checkContext(ctx); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure()
	out := []Position{}
	for _, p := range s.state.Positions {
		if p.Magic != s.magic || symbol != "" && p.Symbol != symbol {
			continue
		}
		q := s.quote(p.Symbol)
		price := q.Bid
		if p.Type == Sell {
			price = q.Ask
		}
		out = append(out, Position{Ticket: p.Ticket, Identifier: p.Ticket, Symbol: p.Symbol, Type: p.Type, Volume: p.Volume, OpenPrice: p.OpenPrice, PriceCurrent: price, SL: p.SL, TP: p.TP, Profit: s.positionPnL(p), Magic: p.Magic, Comment: p.Comment, TimeOpen: p.TimeOpen})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ticket < out[j].Ticket })
	return out, nil
}

func (s *SimulatedBroker) GetOrders(ctx context.Context, symbol string) ([]Order, error) {
	if err := s.checkContext(ctx); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure()
	out := []Order{}
	for _, o := range s.state.Orders {
		if o.Magic == s.magic && (symbol == "" || o.Symbol == symbol) {
			out = append(out, Order{Ticket: o.Ticket, Symbol: o.Symbol, Type: o.Type, VolumeInitial: o.Volume, VolumeCurrent: o.Volume, PriceOpen: o.PriceOpen, SL: o.SL, TP: o.TP, Magic: o.Magic, Comment: o.Comment, TimeSetup: o.TimeSetup, TimeExpiration: o.TimeExpiration})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ticket < out[j].Ticket })
	return out, nil
}

func (s *SimulatedBroker) GetDeals(ctx context.Context, q DealQuery) ([]Deal, error) {
	if err := s.checkContext(ctx); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure()
	out := []Deal{}
	for _, d := range s.state.Deals {
		if d.Magic != s.magic || d.Time < q.FromSec || q.ToSec != nil && d.Time > *q.ToSec || q.PositionID != nil && d.PositionID != *q.PositionID {
			continue
		}
		out = append(out, Deal{Ticket: d.Ticket, Order: d.Order, PositionID: d.PositionID, Symbol: d.Symbol, Type: d.Type, Entry: d.Entry, Volume: d.Volume, Price: d.Price, Profit: d.Profit, Magic: d.Magic, Comment: d.Comment, Time: d.Time, Reason: d.Reason})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Time == out[j].Time {
			return out[i].Ticket < out[j].Ticket
		}
		return out[i].Time < out[j].Time
	})
	return out, nil
}

func (s *SimulatedBroker) CheckOrder(ctx context.Context, req PlaceOrderRequest) (OrderCheckResult, error) {
	if err := s.checkContext(ctx); err != nil {
		return OrderCheckResult{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure()
	if _, _, _, _, _, err := s.validateEntry(ctx, req); err != nil {
		var rejected *RejectedError
		if errors.As(err, &rejected) {
			return OrderCheckResult{OK: false, Retcode: rejected.Retcode, MarginFree: s.account.MarginFree, Comment: rejected.Message}, nil
		}
		return OrderCheckResult{}, err
	}
	sp := s.state.Specs[req.Symbol]
	info := s.account
	margin := 0.0
	if info.Leverage > 0 {
		margin = req.Volume * sp.ContractSize * math.Max(req.Price, sp.Bid) / float64(info.Leverage)
	}
	return OrderCheckResult{OK: true, Retcode: 0, Margin: margin, MarginFree: info.MarginFree, Comment: "Done"}, nil
}

func (s *SimulatedBroker) PlaceOrder(ctx context.Context, req PlaceOrderRequest) (PlaceOrderResult, error) {
	if err := s.checkContext(ctx); err != nil {
		return PlaceOrderResult{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure()
	ambiguous, err := s.before("placeOrder", "ORDER_SEND")
	if err != nil {
		return PlaceOrderResult{}, err
	}
	if res, found := s.duplicate(req.Comment); found {
		if e := s.persist(ctx); e != nil {
			return PlaceOrderResult{}, e
		}
		if ambiguous {
			return PlaceOrderResult{}, s.afterAmbiguous("ORDER_SEND", true)
		}
		return res, nil
	}
	price, sl, tp, sp, quote, err := s.validateEntry(ctx, req)
	if err != nil {
		return PlaceOrderResult{}, err
	}
	comment := s.rewriteComment(req.Comment)
	orderTicket := s.state.NextOrderTicket
	s.state.NextOrderTicket++
	if isPending(req.OrderType) {
		expiration := int64(0)
		applied := false
		if req.ExpirationGMT != nil && *req.ExpirationGMT > 0 && s.supportsExpiration {
			expiration, applied = *req.ExpirationGMT, true
		}
		s.state.Orders = append(s.state.Orders, SimOrder{Ticket: orderTicket, Symbol: req.Symbol, Type: req.OrderType, Volume: req.Volume, PriceOpen: price, SL: sl, TP: tp, Magic: s.magic, Comment: comment, TimeSetup: s.nowSec(), TimeExpiration: expiration})
		if e := s.persist(ctx); e != nil {
			return PlaceOrderResult{}, e
		}
		result := PlaceOrderResult{Retcode: retcodePlaced, OrderTicket: orderTicket, Price: price, Volume: req.Volume, ExpirationApplied: boolPtr(applied)}
		if ambiguous {
			return PlaceOrderResult{}, s.afterAmbiguous("ORDER_SEND", true)
		}
		return result, nil
	}
	buy := req.OrderType == MarketBuy
	fillPrice := quote.Bid
	side := Sell
	if buy {
		fillPrice, side = quote.Ask, Buy
	}
	positionTicket := orderTicket
	dealTicket := s.newDealTicket()
	position := SimPosition{Ticket: positionTicket, Symbol: req.Symbol, Type: side, Volume: req.Volume, OpenPrice: roundTo(fillPrice, sp.Digits), SL: sl, TP: tp, Magic: s.magic, Comment: comment, TimeOpen: s.nowSec(), OpenOrderTicket: orderTicket, OpenDealTicket: dealTicket}
	s.state.Positions = append(s.state.Positions, position)
	s.state.Deals = append(s.state.Deals, SimDeal{Ticket: dealTicket, Order: orderTicket, PositionID: positionTicket, Symbol: req.Symbol, Type: side, Entry: "IN", Volume: req.Volume, Price: position.OpenPrice, Magic: s.magic, Comment: comment, Time: s.nowSec(), Reason: "EXPERT"})
	if e := s.persist(ctx); e != nil {
		return PlaceOrderResult{}, e
	}
	result := PlaceOrderResult{Retcode: retcodeDone, OrderTicket: orderTicket, DealTicket: dealTicket, PositionTicket: positionTicket, Price: position.OpenPrice, Volume: req.Volume}
	if ambiguous {
		return PlaceOrderResult{}, s.afterAmbiguous("ORDER_SEND", true)
	}
	return result, nil
}

func (s *SimulatedBroker) ModifyPosition(ctx context.Context, ticket int64, sl, tp float64) (int, bool, error) {
	return s.modifyPosition(ctx, ticket, sl, tp)
}

func (s *SimulatedBroker) modifyPosition(ctx context.Context, ticket int64, sl, tp float64) (int, bool, error) {
	if err := s.checkContext(ctx); err != nil {
		return 0, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure()
	ambiguous, err := s.before("modifyPosition", "POSITION_MODIFY")
	if err != nil {
		return 0, false, err
	}
	i := s.positionIndex(ticket)
	if i < 0 {
		return 0, false, &RejectedError{Retcode: 5008, Message: "position not found"}
	}
	p := &s.state.Positions[i]
	if p.Magic != s.magic {
		return 0, false, &RejectedError{Retcode: 5006, Message: "position not owned"}
	}
	sp := s.state.Specs[p.Symbol]
	q := s.quote(p.Symbol)
	buy := p.Type == Buy
	if err := checkTradeMode(sp, false, buy); err != nil {
		return retcodeRejected, false, err
	}
	ref := q.Ask
	if buy {
		ref = q.Bid
	}
	if s.stale(q) || !(ref > 0) {
		return retcodeNoQuote, false, &RejectedError{Retcode: retcodeNoQuote, Message: "market closed: stale or missing quote"}
	}
	unchanged := sl == p.SL && tp == p.TP
	if unchanged {
		return 0, true, nil
	}
	if err := s.checkStops(sp, buy, q.Bid, q.Ask, ref, sl, tp, true, true); err != nil {
		return retcodeRejected, false, err
	}
	if sp.FreezeLevelPoints > 0 {
		freeze := sp.FreezeLevelPoints * sp.Point
		if sl != p.SL && p.SL > 0 && math.Abs(ref-p.SL) < freeze-priceEpsilon || tp != p.TP && p.TP > 0 && math.Abs(ref-p.TP) < freeze-priceEpsilon {
			return retcodeRejected, false, &RejectedError{Retcode: 5005, Message: "existing stop violates freeze level"}
		}
	}
	p.SL, p.TP = roundTo(sl, sp.Digits), roundTo(tp, sp.Digits)
	if e := s.persist(ctx); e != nil {
		return 0, false, e
	}
	if ambiguous {
		return 0, false, s.afterAmbiguous("POSITION_MODIFY", true)
	}
	return retcodeDone, false, nil
}

func (s *SimulatedBroker) ModifyPendingOrder(ctx context.Context, ticket int64, price, sl, tp float64) (int, error) {
	if err := s.checkContext(ctx); err != nil {
		return 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure()
	ambiguous, err := s.before("modifyPendingOrder", "PENDING_MODIFY")
	if err != nil {
		return 0, err
	}
	i := s.orderIndex(ticket)
	if i < 0 {
		return 0, &RejectedError{Retcode: 5008, Message: "order not found"}
	}
	o := &s.state.Orders[i]
	if o.Magic != s.magic {
		return 0, &RejectedError{Retcode: 5006, Message: "order not owned"}
	}
	sp := s.state.Specs[o.Symbol]
	q := s.quote(o.Symbol)
	if err := checkTradeMode(sp, false, isBuy(o.Type)); err != nil {
		return retcodeRejected, err
	}
	if price <= 0 {
		price = o.PriceOpen
	}
	priceChanged := price != o.PriceOpen
	if q.Bid > 0 && q.Ask > 0 {
		if err := checkPendingPrice(o.Type, price, q); err != nil {
			return retcodeInvalidPrice, err
		}
	}
	if err := s.checkStops(sp, isBuy(o.Type), q.Bid, q.Ask, price, sl, tp, true, true); err != nil {
		return retcodeRejected, err
	}
	if priceChanged && sp.FreezeLevelPoints > 0 {
		market := q.Bid
		if isBuy(o.Type) {
			market = q.Ask
		}
		if math.Abs(market-o.PriceOpen) < sp.FreezeLevelPoints*sp.Point-priceEpsilon {
			return retcodeRejected, &RejectedError{Retcode: 5005, Message: "pending price violates freeze level"}
		}
	}
	o.PriceOpen, o.SL, o.TP = roundTo(price, sp.Digits), roundTo(sl, sp.Digits), roundTo(tp, sp.Digits)
	if e := s.persist(ctx); e != nil {
		return 0, e
	}
	if ambiguous {
		return 0, s.afterAmbiguous("PENDING_MODIFY", true)
	}
	return retcodeDone, nil
}

func (s *SimulatedBroker) ClosePosition(ctx context.Context, ticket int64, volume *float64) (CloseResult, error) {
	if err := s.checkContext(ctx); err != nil {
		return CloseResult{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure()
	ambiguous, err := s.before("closePosition", "CLOSE_POSITION")
	if err != nil {
		return CloseResult{}, err
	}
	i := s.positionIndex(ticket)
	if i < 0 {
		return CloseResult{}, &RejectedError{Retcode: 5008, Message: "position not found"}
	}
	p := s.state.Positions[i]
	if p.Magic != s.magic {
		return CloseResult{}, &RejectedError{Retcode: 5006, Message: "position not owned"}
	}
	sp := s.state.Specs[p.Symbol]
	q := s.quote(p.Symbol)
	if s.stale(q) || !(q.Bid > 0) || !(q.Ask > 0) {
		return CloseResult{}, &RejectedError{Retcode: retcodeNoQuote, Message: "market closed: stale or missing quote"}
	}
	closeVolume := p.Volume
	if volume != nil && *volume > 0 {
		closeVolume = *volume
	}
	if closeVolume > p.Volume+volumeEpsilon {
		return CloseResult{}, &RejectedError{Retcode: 5004, Message: "close volume exceeds position volume"}
	}
	if err := checkVolume(sp, closeVolume); err != nil {
		return CloseResult{}, err
	}
	remaining := roundTo(p.Volume-closeVolume, volumeDecimals(sp.VolumeStep))
	if remaining > volumeEpsilon && remaining+volumeEpsilon < sp.VolumeMin {
		return CloseResult{}, &RejectedError{Retcode: 5004, Message: "partial close would leave volume below min"}
	}
	price := q.Ask
	if p.Type == Buy {
		price = q.Bid
	}
	profit := positionPnL(sp, p.Type, p.OpenPrice, price, closeVolume)
	dealTicket := s.newDealTicket()
	s.state.Deals = append(s.state.Deals, SimDeal{Ticket: dealTicket, Order: p.OpenOrderTicket, PositionID: p.Ticket, Symbol: p.Symbol, Type: p.Type, Entry: "OUT", Volume: closeVolume, Price: roundTo(price, sp.Digits), Profit: roundTo(profit, 2), Magic: p.Magic, Comment: p.Comment, Time: s.nowSec(), Reason: "EXPERT"})
	s.state.Balance += profit
	if remaining <= volumeEpsilon {
		s.state.Positions = append(s.state.Positions[:i], s.state.Positions[i+1:]...)
	} else {
		s.state.Positions[i].Volume = remaining
	}
	s.trimDeals()
	if e := s.persist(ctx); e != nil {
		return CloseResult{}, e
	}
	result := CloseResult{Retcode: retcodeDone, DealTicket: dealTicket, ClosedVolume: closeVolume, Price: roundTo(price, sp.Digits), RemainingVolume: remaining}
	if ambiguous {
		return CloseResult{}, s.afterAmbiguous("CLOSE_POSITION", true)
	}
	return result, nil
}

func (s *SimulatedBroker) CancelOrder(ctx context.Context, ticket int64) (int, error) {
	if err := s.checkContext(ctx); err != nil {
		return 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure()
	ambiguous, err := s.before("cancelOrder", "CANCEL_ORDER")
	if err != nil {
		return 0, err
	}
	i := s.orderIndex(ticket)
	if i < 0 {
		return 0, &RejectedError{Retcode: 5008, Message: "order not found"}
	}
	if s.state.Orders[i].Magic != s.magic {
		return 0, &RejectedError{Retcode: 5006, Message: "order not owned"}
	}
	s.state.Orders = append(s.state.Orders[:i], s.state.Orders[i+1:]...)
	if e := s.persist(ctx); e != nil {
		return 0, e
	}
	if ambiguous {
		return 0, s.afterAmbiguous("CANCEL_ORDER", true)
	}
	return retcodeDone, nil
}

func (s *SimulatedBroker) Evaluate(ctx context.Context) (EvaluateReport, error) {
	if err := s.checkContext(ctx); err != nil {
		return EvaluateReport{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure()
	report := EvaluateReport{Filled: []int64{}, Expired: []int64{}, Closed: []struct {
		Ticket int64   `json:"ticket"`
		Reason string  `json:"reason"`
		Price  float64 `json:"price"`
		Profit float64 `json:"profit"`
	}{}}
	now := s.nowSec()
	for i := 0; i < len(s.state.Orders); {
		o := s.state.Orders[i]
		q := s.quote(o.Symbol)
		if s.stale(q) {
			i++
			continue
		}
		if o.TimeExpiration > 0 && now >= o.TimeExpiration {
			report.Expired = append(report.Expired, o.Ticket)
			s.state.Orders = append(s.state.Orders[:i], s.state.Orders[i+1:]...)
			continue
		}
		if !shouldFill(o, q) {
			i++
			continue
		}
		sp := s.state.Specs[o.Symbol]
		buy := isBuy(o.Type)
		side, price := Sell, q.Bid
		if buy {
			side, price = Buy, q.Ask
		}
		positionTicket := s.state.NextOrderTicket
		s.state.NextOrderTicket++
		dealTicket := s.newDealTicket()
		p := SimPosition{Ticket: positionTicket, Symbol: o.Symbol, Type: side, Volume: o.Volume, OpenPrice: roundTo(price, sp.Digits), SL: o.SL, TP: o.TP, Magic: o.Magic, Comment: o.Comment, TimeOpen: now, OpenOrderTicket: o.Ticket, OpenDealTicket: dealTicket}
		s.state.Positions = append(s.state.Positions, p)
		s.state.Deals = append(s.state.Deals, SimDeal{Ticket: dealTicket, Order: o.Ticket, PositionID: positionTicket, Symbol: o.Symbol, Type: side, Entry: "IN", Volume: o.Volume, Price: p.OpenPrice, Magic: o.Magic, Comment: o.Comment, Time: now, Reason: "EXPERT"})
		report.Filled = append(report.Filled, o.Ticket)
		s.state.Orders = append(s.state.Orders[:i], s.state.Orders[i+1:]...)
	}
	for i := 0; i < len(s.state.Positions); {
		p := s.state.Positions[i]
		q := s.quote(p.Symbol)
		if s.stale(q) {
			i++
			continue
		}
		trigger, level, ok := triggerFor(p, q)
		if !ok {
			i++
			continue
		}
		sp := s.state.Specs[p.Symbol]
		price := level
		profit := positionPnL(sp, p.Type, p.OpenPrice, price, p.Volume)
		dealTicket := s.newDealTicket()
		s.state.Deals = append(s.state.Deals, SimDeal{Ticket: dealTicket, Order: p.OpenOrderTicket, PositionID: p.Ticket, Symbol: p.Symbol, Type: p.Type, Entry: "OUT", Volume: p.Volume, Price: roundTo(price, sp.Digits), Profit: roundTo(profit, 2), Magic: p.Magic, Comment: p.Comment, Time: now, Reason: trigger})
		s.state.Balance += profit
		report.Closed = append(report.Closed, struct {
			Ticket int64   `json:"ticket"`
			Reason string  `json:"reason"`
			Price  float64 `json:"price"`
			Profit float64 `json:"profit"`
		}{p.Ticket, trigger, price, profit})
		s.state.Positions = append(s.state.Positions[:i], s.state.Positions[i+1:]...)
	}
	s.trimDeals()
	if err := s.persist(ctx); err != nil {
		return EvaluateReport{}, err
	}
	return report, nil
}

func (s *SimulatedBroker) validateEntry(ctx context.Context, req PlaceOrderRequest) (float64, float64, float64, SymbolInfo, Quote, error) {
	if !validOrderType(req.OrderType) {
		return 0, 0, 0, SymbolInfo{}, Quote{}, &RejectedError{Retcode: 4001, Message: "invalid order_type"}
	}
	sp, ok := s.state.Specs[req.Symbol]
	if !ok && s.symbolProvider != nil {
		var err error
		sp, err = s.symbolProvider(ctx, req.Symbol)
		if err != nil {
			return 0, 0, 0, SymbolInfo{}, Quote{}, err
		}
		s.state.Specs[req.Symbol] = sp
		s.state.SpecFetchedAt[req.Symbol] = s.now().UnixMilli()
		ok = true
	}
	if !ok {
		return 0, 0, 0, SymbolInfo{}, Quote{}, &RejectedError{Retcode: 5007, Message: "unknown symbol: " + req.Symbol}
	}
	if s.magic == 0 {
		return 0, 0, 0, SymbolInfo{}, Quote{}, &RejectedError{Retcode: 5010, Message: "invalid EA magic"}
	}
	if !s.account.TerminalTradeAllowed || !s.account.TradeAllowed || !s.account.TradeExpert {
		return 0, 0, 0, SymbolInfo{}, Quote{}, &RejectedError{Retcode: 5002, Message: "trading not allowed"}
	}
	if err := checkTradeMode(sp, true, isBuy(req.OrderType)); err != nil {
		return 0, 0, 0, SymbolInfo{}, Quote{}, err
	}
	if err := validateRequest(req, s.nowSec()); err != nil {
		return 0, 0, 0, SymbolInfo{}, Quote{}, err
	}
	if err := checkVolume(sp, req.Volume); err != nil {
		return 0, 0, 0, SymbolInfo{}, Quote{}, err
	}
	q := s.quote(req.Symbol)
	if s.quoteProvider != nil {
		fresh, err := s.quoteProvider(ctx, req.Symbol)
		if err != nil {
			return 0, 0, 0, SymbolInfo{}, Quote{}, err
		}
		q = fresh
		s.state.Quotes[req.Symbol] = q
	}
	if s.stale(q) {
		return 0, 0, 0, SymbolInfo{}, Quote{}, &RejectedError{Retcode: retcodeNoQuote, Message: "market closed: stale quote for " + req.Symbol}
	}
	sl, tp := roundTo(req.SL, sp.Digits), roundTo(req.TP, sp.Digits)
	if isPending(req.OrderType) {
		price := roundTo(req.Price, sp.Digits)
		if err := checkPendingPrice(req.OrderType, price, q); err != nil {
			return 0, 0, 0, SymbolInfo{}, Quote{}, err
		}
		if err := s.checkStops(sp, isBuy(req.OrderType), q.Bid, q.Ask, price, sl, tp, true, true); err != nil {
			return 0, 0, 0, SymbolInfo{}, Quote{}, err
		}
		if sp.VolumeLimit > 0 {
			volume := req.Volume
			for _, p := range s.state.Positions {
				if p.Symbol == req.Symbol {
					volume += p.Volume
				}
			}
			for _, o := range s.state.Orders {
				if o.Symbol == req.Symbol {
					volume += o.Volume
				}
			}
			if volume > sp.VolumeLimit+sp.VolumeStep/2 {
				return 0, 0, 0, SymbolInfo{}, Quote{}, &RejectedError{Retcode: 5004, Message: "symbol volume limit exceeded"}
			}
		}
		return price, sl, tp, sp, q, nil
	}
	ref := q.Bid
	if req.OrderType == MarketSell {
		ref = q.Ask
	}
	if !(ref > 0) {
		return 0, 0, 0, SymbolInfo{}, Quote{}, &RejectedError{Retcode: retcodeNoQuote, Message: "market closed: no quote for " + req.Symbol}
	}
	if err := s.checkStops(sp, isBuy(req.OrderType), q.Bid, q.Ask, ref, sl, tp, true, true); err != nil {
		return 0, 0, 0, SymbolInfo{}, Quote{}, err
	}
	if sp.VolumeLimit > 0 {
		volume := req.Volume
		for _, p := range s.state.Positions {
			if p.Symbol == req.Symbol {
				volume += p.Volume
			}
		}
		for _, o := range s.state.Orders {
			if o.Symbol == req.Symbol {
				volume += o.Volume
			}
		}
		if volume > sp.VolumeLimit+sp.VolumeStep/2 {
			return 0, 0, 0, SymbolInfo{}, Quote{}, &RejectedError{Retcode: 5004, Message: "symbol volume limit exceeded"}
		}
	}
	return 0, sl, tp, sp, q, nil
}

func (s *SimulatedBroker) checkStops(sp SymbolInfo, buy bool, bid, ask, reference, sl, tp float64, checkSide, checkDistance bool) error {
	minDistance := sp.StopsLevelPoints * sp.Point
	stopRef := bid
	if buy {
		stopRef = ask
	}
	if checkSide {
		if sl > 0 && (buy && sl >= reference || !buy && sl <= reference) {
			return &RejectedError{Retcode: 5005, Message: "stop loss is on the wrong side"}
		}
		if tp > 0 && (buy && tp <= reference || !buy && tp >= reference) {
			return &RejectedError{Retcode: 5005, Message: "take profit is on the wrong side"}
		}
	}
	if checkDistance {
		if sl > 0 && math.Abs(stopRef-sl)+priceEpsilon < minDistance {
			return &RejectedError{Retcode: 5005, Message: "stop loss violates stops level"}
		}
		if tp > 0 && math.Abs(stopRef-tp)+priceEpsilon < minDistance {
			return &RejectedError{Retcode: 5005, Message: "take profit violates stops level"}
		}
	}
	return nil
}

func (s *SimulatedBroker) quote(symbol string) Quote {
	q, ok := s.state.Quotes[symbol]
	if !ok {
		if sp, exists := s.state.Specs[symbol]; exists {
			return Quote{Bid: sp.Bid, Ask: sp.Ask, TimeMsc: sp.TickTimeMsc}
		}
		return Quote{}
	}
	if q.TimeMsc == 0 {
		q.TimeMsc = s.now().UnixMilli()
	}
	return q
}

func (s *SimulatedBroker) stale(q Quote) bool {
	if s.maxQuoteAge <= 0 || q.TimeMsc <= 0 {
		return false
	}
	age := s.now().UnixMilli() - q.TimeMsc
	return age > s.maxQuoteAge.Milliseconds() || age < 0
}

func (s *SimulatedBroker) duplicate(comment string) (PlaceOrderResult, bool) {
	if comment == "" {
		return PlaceOrderResult{}, false
	}
	cutoff := s.nowSec() - duplicateLookbackSec
	for _, p := range s.state.Positions {
		if p.Magic == s.magic && p.Comment == comment {
			return PlaceOrderResult{Retcode: retcodeDone, OrderTicket: p.OpenOrderTicket, DealTicket: p.OpenDealTicket, PositionTicket: p.Ticket, Price: p.OpenPrice, Volume: p.Volume, Duplicate: true}, true
		}
	}
	for _, o := range s.state.Orders {
		if o.Magic == s.magic && o.Comment == comment {
			return PlaceOrderResult{Retcode: retcodePlaced, OrderTicket: o.Ticket, Price: o.PriceOpen, Volume: o.Volume, Duplicate: true}, true
		}
	}
	for _, d := range s.state.Deals {
		if d.Time >= cutoff && d.Magic == s.magic && d.Comment == comment && d.Entry == "IN" {
			return PlaceOrderResult{Retcode: retcodeDone, OrderTicket: d.Order, DealTicket: d.Ticket, PositionTicket: d.PositionID, Price: d.Price, Volume: d.Volume, Duplicate: true}, true
		}
	}
	return PlaceOrderResult{}, false
}

func (s *SimulatedBroker) positionIndex(ticket int64) int {
	for i := range s.state.Positions {
		if s.state.Positions[i].Ticket == ticket {
			return i
		}
	}
	return -1
}
func (s *SimulatedBroker) orderIndex(ticket int64) int {
	for i := range s.state.Orders {
		if s.state.Orders[i].Ticket == ticket {
			return i
		}
	}
	return -1
}
func (s *SimulatedBroker) newDealTicket() int64 {
	ticket := s.state.NextDealTicket
	s.state.NextDealTicket++
	return ticket
}

func (s *SimulatedBroker) positionPnL(p SimPosition) float64 {
	sp, ok := s.state.Specs[p.Symbol]
	if !ok {
		return 0
	}
	q := s.quote(p.Symbol)
	price := q.Ask
	if p.Type == Buy {
		price = q.Bid
	}
	return positionPnL(sp, p.Type, p.OpenPrice, price, p.Volume)
}

func positionPnL(sp SymbolInfo, side OrderSide, open, close, volume float64) float64 {
	if !(sp.TickSize > 0) {
		return 0
	}
	delta := close - open
	if side == Sell {
		delta = open - close
	}
	value := sp.TickValue
	if sp.TickValueProfit > 0 {
		value = sp.TickValueProfit
	}
	return delta / sp.TickSize * value * volume
}

func (s *SimulatedBroker) trimDeals() {
	cutoff := s.nowSec() - dealRetentionSec
	kept := s.state.Deals[:0]
	for _, d := range s.state.Deals {
		if d.Time >= cutoff {
			kept = append(kept, d)
		}
	}
	s.state.Deals = kept
}

func validateRequest(req PlaceOrderRequest, now int64) error {
	if req.Symbol == "" || req.Volume <= 0 || !finite(req.Volume) || req.DeviationPoints < 0 || len(req.Comment) > 31 {
		return &RejectedError{Retcode: 4001, Message: "invalid order request"}
	}
	if isPending(req.OrderType) && !(req.Price > 0) {
		return &RejectedError{Retcode: 4001, Message: "pending order requires a price"}
	}
	if req.ExpirationGMT != nil && *req.ExpirationGMT > 0 && *req.ExpirationGMT <= now {
		return &RejectedError{Retcode: 5009, Message: "pending order expiration is in the past"}
	}
	return nil
}

func validOrderType(t OrderType) bool { return t == MarketBuy || t == MarketSell || isPending(t) }
func isPending(t OrderType) bool {
	return t == BuyLimit || t == SellLimit || t == BuyStop || t == SellStop
}
func isBuy(t OrderType) bool { return t == MarketBuy || t == BuyLimit || t == BuyStop }
func finite(v float64) bool  { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func checkVolume(sp SymbolInfo, volume float64) error {
	if !finite(volume) || volume+volumeEpsilon < sp.VolumeMin || volume > sp.VolumeMax+volumeEpsilon {
		return &RejectedError{Retcode: 5004, Message: "volume outside symbol min/max"}
	}
	if !(sp.VolumeStep > 0) || math.Abs(volume/sp.VolumeStep-math.Round(volume/sp.VolumeStep)) > volumeEpsilon {
		return &RejectedError{Retcode: 5004, Message: "volume is not aligned to symbol step"}
	}
	return nil
}

func checkTradeMode(sp SymbolInfo, entry, buy bool) error {
	switch sp.TradeMode {
	case "FULL":
		return nil
	case "LONGONLY":
		if buy {
			return nil
		}
	case "SHORTONLY":
		if !buy {
			return nil
		}
	case "CLOSEONLY":
		if !entry {
			return nil
		}
	}
	return &RejectedError{Retcode: 5003, Message: "symbol trade mode forbids operation"}
}

func checkPendingPrice(t OrderType, price float64, q Quote) error {
	valid := t == BuyLimit && price < q.Ask || t == SellLimit && price > q.Bid || t == BuyStop && price > q.Ask || t == SellStop && price < q.Bid
	if !valid {
		return &RejectedError{Retcode: retcodeInvalidPrice, Message: "invalid pending price"}
	}
	return nil
}

func shouldFill(o SimOrder, q Quote) bool {
	switch o.Type {
	case BuyLimit:
		return q.Ask <= o.PriceOpen
	case SellLimit:
		return q.Bid >= o.PriceOpen
	case BuyStop:
		return q.Ask >= o.PriceOpen
	case SellStop:
		return q.Bid <= o.PriceOpen
	default:
		return false
	}
}

func triggerFor(p SimPosition, q Quote) (string, float64, bool) {
	price := q.Bid
	if p.Type == Sell {
		price = q.Ask
	}
	if p.Type == Buy {
		if p.SL > 0 && price <= p.SL {
			return "SL", p.SL, true
		}
		if p.TP > 0 && price >= p.TP {
			return "TP", p.TP, true
		}
	} else {
		if p.SL > 0 && price >= p.SL {
			return "SL", p.SL, true
		}
		if p.TP > 0 && price <= p.TP {
			return "TP", p.TP, true
		}
	}
	return "", 0, false
}

func roundTo(v float64, digits int) float64 {
	return math.Round(v*math.Pow10(digits)) / math.Pow10(digits)
}
func volumeDecimals(step float64) int {
	for i := 0; i <= 8; i++ {
		if math.Abs(step*math.Pow10(i)-math.Round(step*math.Pow10(i))) < 1e-9 {
			return i
		}
	}
	return 8
}
func boolPtr(v bool) *bool { return &v }

var _ Broker = (*SimulatedBroker)(nil)
