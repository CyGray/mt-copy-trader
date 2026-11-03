package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/bytrader/bytrader/internal/broker"
	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
)

const mutationTestMagic = int64(98981)

type engineSimPersistence struct{ db *store.SQLiteStore }

func (p engineSimPersistence) Load(ctx context.Context) (*broker.SimState, error) {
	doc, err := p.db.Get(ctx, "paper_broker", "state")
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(doc)
	if err != nil {
		return nil, err
	}
	var state broker.SimState
	err = json.Unmarshal(data, &state)
	return &state, err
}

func (p engineSimPersistence) Save(ctx context.Context, state broker.SimState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	var doc store.Document
	if err := json.Unmarshal(data, &doc); err != nil {
		return err
	}
	return p.db.Put(ctx, "paper_broker", "state", doc)
}

type intentTestWorld struct {
	t     *testing.T
	db    *store.SQLiteStore
	path  string
	now   time.Time
	sim   *broker.SimulatedBroker
	br    *intentTestBroker
	close *int
}

type intentTestBroker struct {
	broker.Broker
	db                    *store.SQLiteStore
	tradeID               string
	cancelCalls           int
	closeCalls            int
	modifyCalls           int
	pendingModifyCalls    int
	placeCalls            int
	checkIntent           bool
	crashClose            bool
	suppressPlace         bool
	noOpCancel            bool
	noOpClose             bool
	cancelError           error
	closeError            error
	placeResultOverride   *broker.PlaceOrderResult
	placeVolumeOverride   float64
	positionIdentifierGap int64
	partialCloseVolumes   []float64
	requestedCloseVolumes []float64
	closeVolumes          []float64
	closeRetcodeOverride  int
}

type laggingReadBroker struct {
	broker.Broker
	hideFill bool
}

type reconciliationViewBroker struct {
	broker.Broker
	hidePositions bool
	rewriteTicket int64
	extraOrders   []broker.Order
}

func (b *laggingReadBroker) GetPositions(ctx context.Context, symbol string) ([]broker.Position, error) {
	if b.hideFill {
		return []broker.Position{}, nil
	}
	return b.Broker.GetPositions(ctx, symbol)
}

func (b *laggingReadBroker) GetDeals(ctx context.Context, query broker.DealQuery) ([]broker.Deal, error) {
	if b.hideFill {
		return []broker.Deal{}, nil
	}
	return b.Broker.GetDeals(ctx, query)
}

func (b *reconciliationViewBroker) GetPositions(ctx context.Context, symbol string) ([]broker.Position, error) {
	if b.hidePositions {
		return []broker.Position{}, nil
	}
	positions, err := b.Broker.GetPositions(ctx, symbol)
	if err != nil {
		return nil, err
	}
	for i := range positions {
		if positions[i].Ticket == b.rewriteTicket {
			positions[i].Comment = "BROKER_REWRITTEN"
		}
	}
	return positions, nil
}

func (b *reconciliationViewBroker) GetOrders(ctx context.Context, symbol string) ([]broker.Order, error) {
	orders, err := b.Broker.GetOrders(ctx, symbol)
	if err != nil {
		return nil, err
	}
	return append(orders, b.extraOrders...), nil
}

type mt5NoClockBroker struct{ broker.Broker }

func (b *mt5NoClockBroker) Kind() broker.Kind { return broker.MT5 }
func (b *mt5NoClockBroker) Ping(context.Context) (broker.PingInfo, error) {
	return broker.PingInfo{TerminalConnected: true, TradeAllowed: true, ServerTime: 1, ServerTimeSource: "TimeTradeServer"}, nil
}

type mt5OffsetBroker struct {
	broker.Broker
	GMTTime int64
}

func (b *intentTestBroker) PlaceOrder(ctx context.Context, req broker.PlaceOrderRequest) (broker.PlaceOrderResult, error) {
	b.placeCalls++
	if b.suppressPlace {
		if b.placeResultOverride == nil {
			return broker.PlaceOrderResult{}, errors.New("place result override missing")
		}
		return *b.placeResultOverride, nil
	}
	if b.placeVolumeOverride > 0 {
		req.Volume = b.placeVolumeOverride
	}
	result, err := b.Broker.PlaceOrder(ctx, req)
	if err != nil {
		return result, err
	}
	if b.placeResultOverride != nil {
		return *b.placeResultOverride, nil
	}
	if b.positionIdentifierGap != 0 {
		result.PositionTicket += b.positionIdentifierGap
		result.Volume, result.Price = 0, 0
	}
	return result, nil
}

func (b *intentTestBroker) GetPositions(ctx context.Context, symbol string) ([]broker.Position, error) {
	positions, err := b.Broker.GetPositions(ctx, symbol)
	if err != nil {
		return nil, err
	}
	if b.positionIdentifierGap != 0 {
		for i := range positions {
			positions[i].Identifier += b.positionIdentifierGap
		}
	}
	return positions, nil
}

func (b *intentTestBroker) GetDeals(ctx context.Context, query broker.DealQuery) ([]broker.Deal, error) {
	if query.PositionID != nil && b.positionIdentifierGap != 0 {
		id := *query.PositionID - b.positionIdentifierGap
		query.PositionID = &id
	}
	deals, err := b.Broker.GetDeals(ctx, query)
	if err != nil {
		return nil, err
	}
	if b.positionIdentifierGap != 0 {
		for i := range deals {
			deals[i].PositionID += b.positionIdentifierGap
		}
	}
	return deals, nil
}

func (b *mt5OffsetBroker) Kind() broker.Kind { return broker.MT5 }
func (b *mt5OffsetBroker) Ping(context.Context) (broker.PingInfo, error) {
	return broker.PingInfo{TerminalConnected: true, TradeAllowed: true, GMTTime: b.GMTTime, ServerTime: b.GMTTime, ServerTimeSource: "TimeTradeServer"}, nil
}

func (b *intentTestBroker) CancelOrder(ctx context.Context, ticket int64) (int, error) {
	b.cancelCalls++
	if b.checkIntent {
		doc, err := b.db.Get(ctx, "trade_sets", b.tradeID)
		if err != nil || object(doc["mutation_intent"]) == nil {
			return 0, fmt.Errorf("cancel sent without durable intent: %v", err)
		}
	}
	if b.noOpCancel {
		b.noOpCancel = false
		return 0, &broker.AmbiguousError{Action: "CANCEL_ORDER", Message: "reply lost before simulated cancel"}
	}
	if b.cancelError != nil {
		err := b.cancelError
		b.cancelError = nil
		return 0, err
	}
	return b.Broker.CancelOrder(ctx, ticket)
}

func (b *intentTestBroker) ClosePosition(ctx context.Context, ticket int64, volume *float64) (broker.CloseResult, error) {
	b.closeCalls++
	if b.checkIntent {
		doc, err := b.db.Get(ctx, "trade_sets", b.tradeID)
		if err != nil || object(doc["mutation_intent"]) == nil {
			return broker.CloseResult{}, fmt.Errorf("close sent without durable intent: %v", err)
		}
	}
	if b.noOpClose {
		b.noOpClose = false
		return broker.CloseResult{}, &broker.AmbiguousError{Action: "CLOSE_POSITION", Message: "reply lost before simulated close"}
	}
	if b.closeError != nil {
		err := b.closeError
		b.closeError = nil
		return broker.CloseResult{}, err
	}
	if volume == nil {
		b.requestedCloseVolumes = append(b.requestedCloseVolumes, 0)
	} else {
		b.requestedCloseVolumes = append(b.requestedCloseVolumes, *volume)
	}
	injectedPartial := len(b.partialCloseVolumes) > 0
	if injectedPartial {
		partial := b.partialCloseVolumes[0]
		b.partialCloseVolumes = b.partialCloseVolumes[1:]
		volume = &partial
	}
	if volume == nil {
		b.closeVolumes = append(b.closeVolumes, 0)
	} else {
		b.closeVolumes = append(b.closeVolumes, *volume)
	}
	result, err := b.Broker.ClosePosition(ctx, ticket, volume)
	if err == nil && injectedPartial {
		// The simulated broker applies the volume passed above; model the EA's
		// accepted partial-fill retcode for the injected partial acknowledgment.
		result.Retcode = 10010
	}
	if err == nil && b.closeRetcodeOverride > 0 {
		result.Retcode = b.closeRetcodeOverride
	}
	if err == nil && b.crashClose {
		b.crashClose = false
		panic("crash_after_close_handoff")
	}
	return result, err
}

func (b *intentTestBroker) ModifyPosition(ctx context.Context, ticket int64, sl, tp float64) (int, bool, error) {
	b.modifyCalls++
	if b.checkIntent {
		doc, err := b.db.Get(ctx, "trade_sets", b.tradeID)
		if err != nil || object(doc["mutation_intent"]) == nil {
			return 0, false, fmt.Errorf("position modify sent without durable intent: %v", err)
		}
	}
	return b.Broker.ModifyPosition(ctx, ticket, sl, tp)
}

func (b *intentTestBroker) ModifyPendingOrder(ctx context.Context, ticket int64, price, sl, tp float64) (int, error) {
	b.pendingModifyCalls++
	if b.checkIntent {
		doc, err := b.db.Get(ctx, "trade_sets", b.tradeID)
		if err != nil || object(doc["mutation_intent"]) == nil {
			return 0, fmt.Errorf("pending modify sent without durable intent: %v", err)
		}
	}
	return b.Broker.ModifyPendingOrder(ctx, ticket, price, sl, tp)
}

func newIntentTestWorld(t *testing.T) *intentTestWorld {
	t.Helper()
	t.Setenv("ALERT_NOTIFICATIONS", "disabled")
	w := &intentTestWorld{t: t, path: filepath.Join(t.TempDir(), "engine.sqlite"), now: time.Now().UTC().Truncate(time.Millisecond)}
	var err error
	w.db, err = store.Open(w.path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.db.Close() })
	w.makeBroker()
	w.br = &intentTestBroker{Broker: w.sim, db: w.db}
	return w
}

func (w *intentTestWorld) makeBroker() {
	spec := broker.SymbolInfo{Symbol: "XAUUSD", Digits: 2, Point: .01, TickSize: .01, TickValue: 1, TickValueProfit: 1, TickValueLoss: 1,
		ContractSize: 100, VolumeMin: .01, VolumeMax: 100, VolumeStep: .01, VolumeLimit: 100, TradeMode: "FULL", FillingIOC: true, Bid: 2000, Ask: 2000.2, TickTimeMsc: w.now.UnixMilli(), CurrencyProfit: "USD"}
	var err error
	w.sim, err = broker.NewSimulated(context.Background(), broker.SimulatedOptions{Magic: mutationTestMagic,
		Symbols: map[string]broker.SymbolInfo{"XAUUSD": spec}, Persistence: engineSimPersistence{db: w.db},
		Now: func() time.Time { return w.now }, MaxQuoteAge: time.Hour})
	if err != nil {
		w.t.Fatal(err)
	}
}

func (w *intentTestWorld) runner() *Runner {
	return NewRunner(w.db, Config{Now: func() time.Time { return w.now }, Owner: "engine-test", CloseAllSettle: -1,
		Controls:      func(context.Context) (Control, error) { return Control{Mode: "paper"}, nil },
		BrokerForMode: func(context.Context, string) (broker.Broker, error) { return w.br, nil }})
}

func (w *intentTestWorld) marketPosition(comment string) broker.Position {
	return w.marketPositionVolume(comment, .03)
}

func (w *intentTestWorld) marketPositionVolume(comment string, volume float64) broker.Position {
	w.t.Helper()
	placed, err := w.sim.PlaceOrder(context.Background(), broker.PlaceOrderRequest{Symbol: "XAUUSD", OrderType: broker.MarketBuy, Volume: volume, SL: 1990, TP: 2020, Comment: comment})
	if err != nil {
		w.t.Fatal(err)
	}
	positions, err := w.sim.GetPositions(context.Background(), "XAUUSD")
	if err != nil || len(positions) != 1 || positions[0].Ticket != placed.PositionTicket {
		w.t.Fatalf("market position not created: positions=%+v err=%v", positions, err)
	}
	return positions[0]
}

func (w *intentTestWorld) pendingOrder(comment string) broker.Order {
	w.t.Helper()
	placed, err := w.sim.PlaceOrder(context.Background(), broker.PlaceOrderRequest{Symbol: "XAUUSD", OrderType: broker.BuyLimit, Volume: .03, Price: 1990, SL: 1980, TP: 2010, Comment: comment})
	if err != nil {
		w.t.Fatal(err)
	}
	orders, err := w.sim.GetOrders(context.Background(), "XAUUSD")
	if err != nil || len(orders) != 1 || orders[0].Ticket != placed.OrderTicket {
		w.t.Fatalf("pending order not created: orders=%+v err=%v", orders, err)
	}
	return orders[0]
}

func (w *intentTestWorld) seedTrade(trade domain.TradeSet) {
	w.t.Helper()
	doc, err := jsonDocument(trade)
	if err != nil {
		w.t.Fatal(err)
	}
	if err := w.db.Put(context.Background(), "trade_sets", trade.TradeSetID, doc); err != nil {
		w.t.Fatal(err)
	}
}

func (w *intentTestWorld) trade(state domain.TradeState, order *broker.Order, position *broker.Position) domain.TradeSet {
	id := "-100900_77"
	comment := "BT-123456789abc"
	symbol := "XAUUSD"
	trade := domain.TradeSet{Schema: 2, TradeSetID: id, ChatID: "-100900", MessageID: "77", EventID: "signal-event", Signal: domain.Signal{Symbol: "XAUUSD", Direction: domain.Buy, OrderType: domain.MarketOrder, EntryLow: 2000, EntryHigh: 2001, StopLoss: 1990, TakeProfits: []float64{2010, 2020}},
		SignalRevisions: []domain.SignalRevision{}, Symbol: "XAUUSD", BrokerSymbol: &symbol, Direction: domain.Buy, Mode: "paper", State: state, CorrelationComment: comment,
		Claim: domain.TradeClaim{Attempts: 1, ClaimedAt: store.ISO(w.now.Add(-time.Minute)), Owner: "engine-test"}, CreatedAt: store.ISO(w.now.Add(-time.Hour)), UpdatedAt: store.ISO(w.now),
		Plan:            &domain.TradePlan{Volume: .03, EntryRefPrice: 2000, OrderPrice: 2000, SL: 1990, BrokerTP: 2020},
		Lifecycle:       &domain.TradeLifecycle{Checkpoints: []domain.CheckpointState{}, CurrentVolume: .03, CurrentSL: 1990, CurrentTP: 2020},
		ProfileSnapshot: &domain.ExecutionProfile{Edits: domain.EditPolicy{ExplicitCancel: "close_position", BeforeFill: "apply_sl_tp", UnparseableEdit: "cancel_pending_only"}}}
	refs := domain.BrokerRefs{FillPrice: 2000, FilledVolume: .03}
	if order != nil {
		refs.OrderTicket = order.Ticket
		trade.OrderType = stringPointer("BUY_LIMIT")
	}
	if position != nil {
		refs.PositionTicket = position.Ticket
		refs.PositionIdentifier = position.Identifier
		refs.FillPrice = position.OpenPrice
		trade.Lifecycle.CurrentVolume = position.Volume
		trade.Lifecycle.CurrentSL, trade.Lifecycle.CurrentTP = position.SL, position.TP
	}
	trade.BrokerRefs = &refs
	return trade
}

func (w *intentTestWorld) claimedMarketSubmission() (domain.TradeSet, string, *prepared) {
	trade := w.trade(domain.TradeClaimed, nil, nil)
	corr := correlationComment(trade.TradeSetID)
	trade.CorrelationComment = corr
	profile := validMutationTestProfile(w.t)
	trade.ProfileSnapshot = &profile
	w.seedTrade(trade)
	p := &prepared{mode: "paper", broker: w.br, profile: profile, profileDocID: "profile__v1", brokerSymbol: "XAUUSD",
		spec: broker.SymbolInfo{VolumeMin: .01, VolumeStep: .01}, direction: domain.Buy,
		decision: domain.EntryDecision{OK: true, OrderType: "MARKET", OrderPrice: 2000, EntryRefPrice: 2000},
		sizing:   domain.SizingResult{OK: true, Volume: .03}, brokerTP: 2020, sl: 1990,
		request: broker.PlaceOrderRequest{Symbol: "XAUUSD", OrderType: broker.MarketBuy, Volume: .03, SL: 1990, TP: 2020, Comment: corr}}
	return trade, corr, p
}

func (w *intentTestWorld) reopen() {
	w.t.Helper()
	if err := w.db.Close(); err != nil {
		w.t.Fatal(err)
	}
	var err error
	w.db, err = store.Open(w.path)
	if err != nil {
		w.t.Fatal(err)
	}
	w.makeBroker()
	w.br = &intentTestBroker{Broker: w.sim, db: w.db}
}

func TestReconcileAmbiguousCancelDoesNotOverwritePendingFill(t *testing.T) {
	w := newIntentTestWorld(t)
	order := w.pendingOrder("BT-123456789abc")
	if err := w.sim.SetQuote(context.Background(), "XAUUSD", 1989.6, 1989.8, w.now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := w.sim.Evaluate(context.Background()); err != nil {
		t.Fatal(err)
	}
	trade := w.trade(domain.TradePendingOrder, &order, nil)
	trade.CancelRequested = &domain.CancelRequest{Reason: "unparseable_edit", EventID: "cancel-event", MutationStatus: "ambiguous"}
	trade.MutationIntent = &domain.MutationIntent{Action: "CANCEL_ORDER", Ticket: order.Ticket, At: store.ISO(w.now), ExpiresAt: w.now.Unix() + 8, PriorPrice: order.PriceOpen, PriorVolume: order.VolumeCurrent, SuccessPatch: map[string]any{"state": string(domain.TradeCancelled)}}
	w.seedTrade(trade)
	if err := w.runner().Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil {
		t.Fatal(err)
	}
	if doc["state"] != string(domain.TradeOpen) || doc["mutation_intent"] != nil {
		t.Fatalf("cancel resolution overwrote a correlated fill: state=%v intent=%v", doc["state"], doc["mutation_intent"])
	}
	if refs := object(doc["broker_refs"]); refs["position_ticket"] == nil || refs["position_ticket"] == float64(0) {
		t.Fatalf("filled position was not linked: %+v", refs)
	}
}

func TestAbsentPendingOrderWaitsForAuthoritativeFillRead(t *testing.T) {
	w := newIntentTestWorld(t)
	order := w.pendingOrder("BT-123456789abc")
	if err := w.sim.SetQuote(context.Background(), "XAUUSD", 1989.6, 1989.8, w.now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := w.sim.Evaluate(context.Background()); err != nil {
		t.Fatal(err)
	}
	trade := w.trade(domain.TradePendingOrder, &order, nil)
	trade.MutationIntent = &domain.MutationIntent{Action: "CANCEL_ORDER", Ticket: order.Ticket, At: store.ISO(w.now), ExpiresAt: w.now.Unix() + 8, PriorPrice: order.PriceOpen, PriorVolume: order.VolumeCurrent}
	w.seedTrade(trade)
	lagging := &laggingReadBroker{Broker: w.br, hideFill: true}
	runner := NewRunner(w.db, Config{Now: func() time.Time { return w.now }, Controls: func(context.Context) (Control, error) { return Control{Mode: "paper"}, nil }, BrokerForMode: func(context.Context, string) (broker.Broker, error) { return lagging, nil }})
	if err := runner.Reconcile(context.Background()); err == nil {
		t.Fatal("absent order with a lagging correlated-fill view should stay unresolved")
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradePendingOrder) || doc["mutation_intent"] == nil {
		t.Fatalf("one absent-order view terminalized an ambiguous fill: state=%v intent=%v err=%v", doc["state"], doc["mutation_intent"], err)
	}
	lagging.hideFill = false
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err = w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeOpen) || doc["mutation_intent"] != nil {
		t.Fatalf("later authoritative fill read was not adopted: state=%v intent=%v err=%v", doc["state"], doc["mutation_intent"], err)
	}
}

func TestMT5ReconciliationRefusesUnknownGMT(t *testing.T) {
	w := newIntentTestWorld(t)
	unknownClock := &mt5NoClockBroker{Broker: w.br}
	runner := NewRunner(w.db, Config{BrokerForMode: func(context.Context, string) (broker.Broker, error) { return unknownClock, nil }})
	if _, err := runner.readReconcileView(context.Background(), "live"); err == nil {
		t.Fatal("MT5 reconciliation accepted unknown GMT")
	}
}

func TestClockSkewDefaultsToFiveSecondsAndRejectsSixSecondOffsets(t *testing.T) {
	w := newIntentTestWorld(t)
	t.Setenv("MAX_CLOCK_SKEW_SEC", "")
	if got := NewRunner(w.db, Config{}).cfg.MaxClockSkew; got != 5*time.Second {
		t.Fatalf("default clock-skew limit=%s, want 5s", got)
	}
	t.Setenv("MAX_CLOCK_SKEW_SEC", "12")
	if got := NewRunner(w.db, Config{}).cfg.MaxClockSkew; got != 12*time.Second {
		t.Fatalf("MAX_CLOCK_SKEW_SEC override=%s, want 12s", got)
	}
	t.Setenv("MAX_CLOCK_SKEW_SEC", "")
	profile := validMutationTestProfile(t)
	safety := domain.DefaultSafetyLimits
	control := Control{Mode: "demo", ActiveProfileDocID: "test-profile", ActiveProfile: &profile, Safety: &safety}
	event := domain.SignalEvent{EventID: "clock-event", ChatID: "-100900", MessageID: "88", MessageDate: store.ISO(w.now), Kind: "signal", Signal: &domain.Signal{Symbol: "XAUUSD", Direction: domain.Buy, OrderType: domain.MarketOrder, EntryLow: 2000, EntryHigh: 2001, StopLoss: 1990, TakeProfits: []float64{2010, 2020, 2030}}}
	for _, offset := range []int64{-6, 6} {
		adapter := &mt5OffsetBroker{Broker: w.br, GMTTime: w.now.Unix() + offset}
		runner := NewRunner(w.db, Config{Now: func() time.Time { return w.now }, MaxClockSkew: 5 * time.Second, BrokerForMode: func(context.Context, string) (broker.Broker, error) { return adapter, nil }})
		_, refused, err := runner.prepare(context.Background(), event, control, "clock-test", "BT-123456789abc")
		if err != nil || refused == nil || refused.reason != "clock_skew" {
			t.Fatalf("clock offset %ds not rejected: refused=%+v err=%v", offset, refused, err)
		}
	}
}

func TestSourceChatAllowlistAndStaleQuoteGuards(t *testing.T) {
	w := newIntentTestWorld(t)
	if err := w.db.Put(context.Background(), "settings", "default", store.Document{"mt5": map[string]any{"source_chat_ids": []any{"-100900"}}}); err != nil {
		t.Fatal(err)
	}
	result := w.runner().HandleEvent(context.Background(), domain.SignalEvent{EventID: "foreign", ChatID: "-100other", MessageID: "1", Kind: "signal"})
	if result.Reason != "chat_not_configured" {
		t.Fatalf("unconfigured source chat was not ignored: %+v", result)
	}
	profile := validMutationTestProfile(t)
	safety := domain.DefaultSafetyLimits
	control := Control{Mode: "paper", ActiveProfileDocID: "test-profile", ActiveProfile: &profile, Safety: &safety}
	event := domain.SignalEvent{EventID: "stale-quote", ChatID: "-100900", MessageID: "89", MessageDate: store.ISO(w.now), Kind: "signal", Signal: &domain.Signal{Symbol: "XAUUSD", Direction: domain.Buy, OrderType: domain.MarketOrder, EntryLow: 2000, EntryHigh: 2001, StopLoss: 1990, TakeProfits: []float64{2010, 2020, 2030}}}
	if err := w.sim.SetQuote(context.Background(), "XAUUSD", 2000, 2000.2, w.now.Add(-2*time.Minute).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	runner := NewRunner(w.db, Config{Now: func() time.Time { return w.now }, MaxQuoteAge: time.Minute, BrokerForMode: func(context.Context, string) (broker.Broker, error) { return w.sim, nil }})
	_, refused, err := runner.prepare(context.Background(), event, control, "stale-test", "BT-123456789abc")
	if err != nil || refused == nil || refused.reason != "quote_stale" {
		t.Fatalf("stale quote was not refused: refused=%+v err=%v", refused, err)
	}
	if err := w.sim.SetQuote(context.Background(), "XAUUSD", 2000, 2000.2, w.now.Add(4*time.Second).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	_, refused, err = runner.prepare(context.Background(), event, control, "future-test", "BT-123456789abc")
	if err != nil || refused == nil || refused.reason != "quote_stale" {
		t.Fatalf("future quote was not refused: refused=%+v err=%v", refused, err)
	}
}

func validMutationTestProfile(t *testing.T) domain.ExecutionProfile {
	t.Helper()
	data, err := os.ReadFile("../../docs/project_memory/examples/optimal_report_profile.example.json")
	if err != nil {
		t.Fatal(err)
	}
	var profile domain.ExecutionProfile
	if err := json.Unmarshal(data, &profile); err != nil {
		t.Fatal(err)
	}
	profile.Entry.Policy = domain.MarketOnly
	profile.Sizing.Mode = domain.FixedLots
	lots := .03
	profile.Sizing.FixedLots = &lots
	checked := domain.ValidateProfile(profile)
	if !checked.OK || checked.Value == nil {
		t.Fatalf("test profile invalid: %+v", checked.Errors)
	}
	return *checked.Value
}

func TestCloseAllCancelIntentRetriesAsCloseWhenPendingOrderFills(t *testing.T) {
	w := newIntentTestWorld(t)
	order := w.pendingOrder("BT-123456789abc")
	if err := w.sim.SetQuote(context.Background(), "XAUUSD", 1989.6, 1989.8, w.now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := w.sim.Evaluate(context.Background()); err != nil {
		t.Fatal(err)
	}
	trade := w.trade(domain.TradePendingOrder, &order, nil)
	trade.CloseRequestedBy, trade.CloseRequestStatus = "close_all", "ambiguous"
	trade.MutationIntent = &domain.MutationIntent{Action: "CANCEL_ORDER", Ticket: order.Ticket, At: store.ISO(w.now), ExpiresAt: w.now.Unix() + 8, PriorPrice: order.PriceOpen, PriorVolume: order.VolumeCurrent, Reason: "close_all"}
	w.seedTrade(trade)
	w.br.tradeID, w.br.checkIntent = trade.TradeSetID, true
	if err := w.runner().Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeClosed) || doc["close_request_status"] != "done" || doc["mutation_intent"] != nil {
		t.Fatalf("filled order was not converted to close-all position close: state=%v request=%v intent=%v err=%v", doc["state"], doc["close_request_status"], doc["mutation_intent"], err)
	}
	if w.br.closeCalls != 1 {
		t.Fatalf("close-all should close newly filled position once, calls=%d", w.br.closeCalls)
	}
}

func TestMutationPriorStateRemainsFencedAfterRequestTTL(t *testing.T) {
	w := newIntentTestWorld(t)
	order := w.pendingOrder("BT-123456789abc")
	trade := w.trade(domain.TradePendingOrder, &order, nil)
	trade.CancelRequested = &domain.CancelRequest{Reason: "explicit_cancel", EventID: "cancel-event", MutationStatus: "ambiguous"}
	trade.MutationIntent = &domain.MutationIntent{Action: "CANCEL_ORDER", Ticket: order.Ticket, At: store.ISO(w.now), ExpiresAt: w.now.Unix() + 8, PriorPrice: order.PriceOpen, PriorSL: order.SL, PriorTP: order.TP, PriorVolume: order.VolumeCurrent}
	w.seedTrade(trade)
	w.br.tradeID, w.br.checkIntent = trade.TradeSetID, true
	runner := w.runner()
	if err := runner.Reconcile(context.Background()); err == nil {
		t.Fatal("unexpired ambiguous cancel unexpectedly resolved")
	}
	if w.br.cancelCalls != 0 {
		t.Fatal("cancel was repeated before its expiry window")
	}
	w.now = w.now.Add(20 * time.Second)
	if err := runner.Reconcile(context.Background()); err == nil {
		t.Fatal("unchanged exact prior state after TTL incorrectly resolved an ambiguous cancel")
	}
	if w.br.cancelCalls != 0 {
		t.Fatalf("ambiguous cancel was repeated after TTL: calls=%d", w.br.cancelCalls)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradePendingOrder) || doc["mutation_intent"] == nil {
		t.Fatalf("ambiguous cancel lost its durable fence: state=%v intent=%v err=%v", doc["state"], doc["mutation_intent"], err)
	}
	alert, err := w.db.Get(context.Background(), "alerts", "mutation_unknown__"+trade.TradeSetID)
	if err != nil || alert["status"] != "open" {
		t.Fatalf("unresolved mutation alert was incorrectly cleared: status=%v err=%v", alert["status"], err)
	}
}

func TestAmbiguousCloseIntentRemainsFencedAcrossRestartAfterTTL(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("BT-123456789abc")
	trade := w.trade(domain.TradeOpen, nil, &position)
	trade.CancelRequested = &domain.CancelRequest{Reason: "explicit_cancel", EventID: "restart-cancel", MutationStatus: "ambiguous"}
	trade.MutationIntent = &domain.MutationIntent{Action: "CLOSE_POSITION", Ticket: position.Ticket, At: store.ISO(w.now), ExpiresAt: w.now.Unix() + 8,
		PriorSL: position.SL, PriorTP: position.TP, PriorVolume: position.Volume, TargetRemainingVolume: 0, Reason: "cancel", EventID: "restart-cancel"}
	w.seedTrade(trade)
	w.now = w.now.Add(20 * time.Second)
	w.reopen()
	w.br.tradeID, w.br.checkIntent = trade.TradeSetID, true
	if err := w.runner().Reconcile(context.Background()); err == nil {
		t.Fatal("crash-before-send intent was cleared solely because its request TTL elapsed")
	}
	if w.br.closeCalls != 0 {
		t.Fatalf("restart resent a possibly handed-off close: calls=%d", w.br.closeCalls)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["mutation_intent"] == nil || doc["state"] != string(domain.TradeOpen) {
		t.Fatalf("restart lost the unresolved close fence: state=%v intent=%v err=%v", doc["state"], doc["mutation_intent"], err)
	}
}

func TestExpiredSubmitUnknownAdoptsLateExactCorrelationWithoutRejectOrResend(t *testing.T) {
	w := newIntentTestWorld(t)
	trade := w.trade(domain.TradeSubmitUnknown, nil, nil)
	trade.Lifecycle.CurrentVolume = 0
	expired := w.now.Unix() - 20
	trade.Submission = &domain.Submission{SubmittedAt: store.ISO(w.now.Add(-time.Minute)), ExpiresAt: expired, RequestID: "request-late-fill"}
	w.seedTrade(trade)
	runner := w.runner()
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeSubmitUnknown) {
		t.Fatalf("absent entry was terminalized from expiry alone: state=%v err=%v", doc["state"], err)
	}
	position := w.marketPosition(trade.CorrelationComment)
	if position.Ticket <= 0 {
		t.Fatal("late exact correlated position was not created")
	}
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err = w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeOpen) || object(doc["broker_refs"])["position_ticket"] != float64(position.Ticket) {
		t.Fatalf("late correlated fill was not adopted: state=%v refs=%v err=%v", doc["state"], doc["broker_refs"], err)
	}
	positions, err := w.sim.GetPositions(context.Background(), "XAUUSD")
	if err != nil || len(positions) != 1 {
		t.Fatalf("late-fill adoption duplicated or lost the position: positions=%+v err=%v", positions, err)
	}
}

func TestSubmitUnknownEntryHistoryWithoutExactExitDoesNotTerminalize(t *testing.T) {
	w := newIntentTestWorld(t)
	trade := w.trade(domain.TradeSubmitUnknown, nil, nil)
	trade.Lifecycle.CurrentVolume = 0
	trade.Submission = &domain.Submission{SubmittedAt: store.ISO(w.now.Add(-time.Minute)), ExpiresAt: w.now.Unix() - 20, RequestID: "request-entry-history"}
	w.seedTrade(trade)
	position := w.marketPosition(trade.CorrelationComment)
	adapter := &reconciliationViewBroker{Broker: w.br, hidePositions: true}
	runner := NewRunner(w.db, Config{Now: func() time.Time { return w.now }, Controls: func(context.Context) (Control, error) { return Control{Mode: "paper"}, nil }, BrokerForMode: func(context.Context, string) (broker.Broker, error) { return adapter, nil }})
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeSubmitUnknown) {
		t.Fatalf("entry history without exact current-position or exit evidence was terminalized: state=%v err=%v", doc["state"], err)
	}
	var lifecycle domain.TradeLifecycle
	if err := decodeJSON(doc["lifecycle"], &lifecycle); err != nil || lifecycle.CurrentVolume != 0 {
		t.Fatalf("unknown entry acquired fabricated live volume: current_volume=%v err=%v", lifecycle.CurrentVolume, err)
	}
	if position.Ticket <= 0 {
		t.Fatal("test setup did not create the delayed broker position")
	}
}

func TestSubmitUnknownPartialExitAndRewrittenPositionCommentStayFenced(t *testing.T) {
	w := newIntentTestWorld(t)
	trade := w.trade(domain.TradeSubmitUnknown, nil, nil)
	trade.Lifecycle.CurrentVolume = 0
	trade.Submission = &domain.Submission{SubmittedAt: store.ISO(w.now.Add(-time.Minute)), ExpiresAt: w.now.Unix() - 20, RequestID: "request-partial-exit-history"}
	w.seedTrade(trade)
	position := w.marketPosition(trade.CorrelationComment)
	partial := .01
	if _, err := w.sim.ClosePosition(context.Background(), position.Ticket, &partial); err != nil {
		t.Fatal(err)
	}
	adapter := &reconciliationViewBroker{Broker: w.br, rewriteTicket: position.Ticket}
	runner := NewRunner(w.db, Config{Now: func() time.Time { return w.now }, Controls: func(context.Context) (Control, error) { return Control{Mode: "paper"}, nil }, BrokerForMode: func(context.Context, string) (broker.Broker, error) { return adapter, nil }})
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeSubmitUnknown) {
		t.Fatalf("partial exit or rewritten current comment was treated as a completed/linked trade: state=%v err=%v", doc["state"], err)
	}
	if w.br.closeCalls != 0 {
		t.Fatalf("reconciliation sent a broker close while resolving mismatched history: calls=%d", w.br.closeCalls)
	}
}

func TestSubmitUnknownCompleteEntryAndExitVolumesSettleClosed(t *testing.T) {
	w := newIntentTestWorld(t)
	trade := w.trade(domain.TradeSubmitUnknown, nil, nil)
	trade.Lifecycle.CurrentVolume = 0
	trade.Submission = &domain.Submission{SubmittedAt: store.ISO(w.now.Add(-time.Minute)), ExpiresAt: w.now.Unix() - 20, RequestID: "request-full-exit-history"}
	w.seedTrade(trade)
	position := w.marketPosition(trade.CorrelationComment)
	if _, err := w.sim.ClosePosition(context.Background(), position.Ticket, nil); err != nil {
		t.Fatal(err)
	}
	runner := w.runner()
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeClosed) {
		t.Fatalf("complete exact entry/exit volumes did not settle CLOSED: state=%v err=%v", doc["state"], err)
	}
}

func TestCompleteExitEvidenceRequiresAllHedgingVolumeAndRejectsInOut(t *testing.T) {
	base := []broker.Deal{{PositionID: 42, Magic: mutationTestMagic, Entry: "IN", Volume: .03, Comment: "BT-123456789abc"}}
	if completeExitEvidence(append(append([]broker.Deal{}, base...), broker.Deal{PositionID: 42, Magic: mutationTestMagic, Entry: "OUT", Volume: .02}), 42, mutationTestMagic, "BT-123456789abc") {
		t.Fatal("partial exit volume was treated as a complete close")
	}
	if completeExitEvidence(append(append([]broker.Deal{}, base...), broker.Deal{PositionID: 42, Magic: mutationTestMagic, Entry: "INOUT", Volume: .03}), 42, mutationTestMagic, "BT-123456789abc") {
		t.Fatal("INOUT reversal was treated as proof of a flat position")
	}
	if !completeExitEvidence(append(append([]broker.Deal{}, base...), broker.Deal{PositionID: 42, Magic: mutationTestMagic, Entry: "OUT_BY", Volume: .03}), 42, mutationTestMagic, "BT-123456789abc") {
		t.Fatal("full OUT_BY volume did not prove the position flat")
	}
}

func TestUnknownPositionAndWorkingOrderRemainderStayFenced(t *testing.T) {
	w := newIntentTestWorld(t)
	trade := w.trade(domain.TradeSubmitUnknown, nil, nil)
	trade.Lifecycle.CurrentVolume = 0
	trade.Submission = &domain.Submission{SubmittedAt: store.ISO(w.now.Add(-time.Minute)), ExpiresAt: w.now.Unix() - 20, RequestID: "request-working-remainder"}
	w.seedTrade(trade)
	position := w.marketPosition(trade.CorrelationComment)
	order := broker.Order{Ticket: position.Ticket + 500, Symbol: position.Symbol, Type: broker.BuyLimit, VolumeInitial: .03, VolumeCurrent: .01, PriceOpen: 1990, Magic: mutationTestMagic, Comment: trade.CorrelationComment}
	adapter := &reconciliationViewBroker{Broker: w.br, extraOrders: []broker.Order{order}}
	runner := NewRunner(w.db, Config{Now: func() time.Time { return w.now }, Controls: func(context.Context) (Control, error) { return Control{Mode: "paper"}, nil }, BrokerForMode: func(context.Context, string) (broker.Broker, error) { return adapter, nil }})
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeSubmitUnknown) {
		t.Fatalf("trade opened while a correlated remainder could still fill: state=%v err=%v", doc["state"], err)
	}
}

func TestPendingTradeWithPositionAndWorkingOrderRemainsPending(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("BT-123456789abc")
	order := broker.Order{Ticket: position.Ticket + 500, Symbol: position.Symbol, Type: broker.BuyLimit, VolumeInitial: .03, VolumeCurrent: .01, PriceOpen: 1990, Magic: mutationTestMagic, Comment: position.Comment}
	trade := w.trade(domain.TradePendingOrder, &order, nil)
	trade.Lifecycle.CurrentVolume = 0
	w.seedTrade(trade)
	if position.Ticket <= 0 {
		t.Fatal("test setup did not create the correlated position")
	}
	adapter := &reconciliationViewBroker{Broker: w.br, extraOrders: []broker.Order{order}}
	runner := NewRunner(w.db, Config{Now: func() time.Time { return w.now }, Controls: func(context.Context) (Control, error) { return Control{Mode: "paper"}, nil }, BrokerForMode: func(context.Context, string) (broker.Broker, error) { return adapter, nil }})
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradePendingOrder) {
		t.Fatalf("pending trade advanced while a correlated order remainder was live: state=%v err=%v", doc["state"], err)
	}
}

func TestPendingPartialExitWithRewrittenPositionCommentStaysPending(t *testing.T) {
	w := newIntentTestWorld(t)
	order := w.pendingOrder("BT-123456789abc")
	if err := w.sim.SetQuote(context.Background(), "XAUUSD", 1989.6, 1989.8, w.now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := w.sim.Evaluate(context.Background()); err != nil {
		t.Fatal(err)
	}
	positions, err := w.sim.GetPositions(context.Background(), "XAUUSD")
	if err != nil || len(positions) != 1 {
		t.Fatalf("pending order did not fill: positions=%+v err=%v", positions, err)
	}
	partial := .01
	if _, err := w.sim.ClosePosition(context.Background(), positions[0].Ticket, &partial); err != nil {
		t.Fatal(err)
	}
	trade := w.trade(domain.TradePendingOrder, &order, nil)
	trade.Lifecycle.CurrentVolume = 0
	w.seedTrade(trade)
	adapter := &reconciliationViewBroker{Broker: w.br, rewriteTicket: positions[0].Ticket}
	runner := NewRunner(w.db, Config{Now: func() time.Time { return w.now }, Controls: func(context.Context) (Control, error) { return Control{Mode: "paper"}, nil }, BrokerForMode: func(context.Context, string) (broker.Broker, error) { return adapter, nil }})
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradePendingOrder) {
		t.Fatalf("partial exit history or rewritten position comment terminalized pending trade: state=%v err=%v", doc["state"], err)
	}
}

func TestPendingFullEntryAndExitVolumesSettleClosed(t *testing.T) {
	w := newIntentTestWorld(t)
	order := w.pendingOrder("BT-123456789abc")
	if err := w.sim.SetQuote(context.Background(), "XAUUSD", 1989.6, 1989.8, w.now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := w.sim.Evaluate(context.Background()); err != nil {
		t.Fatal(err)
	}
	positions, err := w.sim.GetPositions(context.Background(), "XAUUSD")
	if err != nil || len(positions) != 1 {
		t.Fatalf("pending order did not fill: positions=%+v err=%v", positions, err)
	}
	if _, err := w.sim.ClosePosition(context.Background(), positions[0].Ticket, nil); err != nil {
		t.Fatal(err)
	}
	trade := w.trade(domain.TradePendingOrder, &order, nil)
	trade.Lifecycle.CurrentVolume = 0
	w.seedTrade(trade)
	if err := w.runner().Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeClosed) {
		t.Fatalf("complete exact entry/exit volumes did not close pending trade: state=%v err=%v", doc["state"], err)
	}
}

func TestAmbiguousPositionCancelSettlesFromExitDealWithoutResend(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("BT-123456789abc")
	trade := w.trade(domain.TradeOpen, nil, &position)
	w.seedTrade(trade)
	w.sim.FailNext("closePosition", broker.FailAmbiguous, 0)
	w.br.tradeID = trade.TradeSetID
	result := w.runner().handleCancel(context.Background(), domain.SignalEvent{EventID: "cancel-event", ChatID: trade.ChatID, MessageID: trade.MessageID, CancelReason: "explicit_cancel"})
	if result.Reason != "cancel_ambiguous" || w.br.closeCalls != 1 {
		t.Fatalf("expected one ambiguous close, got result=%+v calls=%d", result, w.br.closeCalls)
	}
	if err := w.runner().Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeClosed) || doc["mutation_intent"] != nil {
		t.Fatalf("ambiguous close was not settled from exit deal: state=%v intent=%v err=%v", doc["state"], doc["mutation_intent"], err)
	}
	if w.br.closeCalls != 1 {
		t.Fatalf("ambiguous close was repeated: calls=%d", w.br.closeCalls)
	}
}

func TestPositionModifyRevisionRecoveryAndExitPersistence(t *testing.T) {
	t.Run("exact_target_commits_revision", func(t *testing.T) {
		w := newIntentTestWorld(t)
		position := w.marketPosition("BT-123456789abc")
		if _, _, err := w.sim.ModifyPosition(context.Background(), position.Ticket, 1995, 2015); err != nil {
			t.Fatal(err)
		}
		trade := w.trade(domain.TradeOpen, nil, &position)
		entry := domain.SignalRevision{EventID: "revision-1", Outcome: "applied", Reason: "sl_tp_changed"}
		trade.RevisionIntent = &domain.RevisionIntent{Entry: entry, Patch: map[string]any{"signal": domain.Signal{Symbol: "XAUUSD", Direction: domain.Buy, StopLoss: 1995}}, TargetKind: "position", TargetSL: 1995, TargetTP: 2015, PriorSL: 1990, PriorTP: 2020}
		trade.MutationIntent = &domain.MutationIntent{Action: "POSITION_MODIFY", Ticket: position.Ticket, At: store.ISO(w.now), ExpiresAt: w.now.Unix() + 8, PriorSL: 1990, PriorTP: 2020, TargetSL: 1995, TargetTP: 2015, EventID: entry.EventID}
		w.seedTrade(trade)
		if err := w.runner().Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
		doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
		if err != nil || doc["mutation_intent"] != nil || doc["revision_intent"] != nil || len(asArray(doc["signal_revisions"])) != 1 {
			t.Fatalf("observed revision target was not durably committed: %+v err=%v", doc, err)
		}
	})
	t.Run("position_exit_closes_trade_and_revision", func(t *testing.T) {
		w := newIntentTestWorld(t)
		position := w.marketPosition("BT-123456789abc")
		if _, err := w.sim.ClosePosition(context.Background(), position.Ticket, nil); err != nil {
			t.Fatal(err)
		}
		trade := w.trade(domain.TradeOpen, nil, &position)
		entry := domain.SignalRevision{EventID: "revision-closed", Outcome: "applied"}
		trade.RevisionIntent = &domain.RevisionIntent{Entry: entry, TargetKind: "position"}
		trade.MutationIntent = &domain.MutationIntent{Action: "POSITION_MODIFY", Ticket: position.Ticket, At: store.ISO(w.now), ExpiresAt: w.now.Unix() + 8, TargetSL: 1995, TargetTP: 2020}
		w.seedTrade(trade)
		if err := w.runner().Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
		doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
		if err != nil || doc["state"] != string(domain.TradeClosed) || doc["result"] == nil || doc["mutation_intent"] != nil || doc["revision_intent"] != nil {
			t.Fatalf("closed position revision failed to persist the terminal snapshot: state=%v result=%v intents=%v/%v err=%v", doc["state"], doc["result"], doc["mutation_intent"], doc["revision_intent"], err)
		}
	})
	t.Run("revision_without_mutation_intent_closes_from_exit_deal", func(t *testing.T) {
		w := newIntentTestWorld(t)
		position := w.marketPosition("BT-123456789abc")
		if _, err := w.sim.ClosePosition(context.Background(), position.Ticket, nil); err != nil {
			t.Fatal(err)
		}
		trade := w.trade(domain.TradeOpen, nil, &position)
		entry := domain.SignalRevision{EventID: "revision-only-closed", Outcome: "applied"}
		trade.RevisionIntent = &domain.RevisionIntent{Entry: entry, TargetKind: "position"}
		w.seedTrade(trade)
		if err := w.runner().Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
		doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
		if err != nil || doc["state"] != string(domain.TradeClosed) || doc["result"] == nil || doc["revision_intent"] != nil {
			t.Fatalf("revision-only absent position did not settle terminal snapshot: state=%v result=%v revision=%v err=%v", doc["state"], doc["result"], doc["revision_intent"], err)
		}
	})
}

func TestPendingModifyRevisionRemainsFencedAfterRequestTTL(t *testing.T) {
	w := newIntentTestWorld(t)
	order := w.pendingOrder("BT-123456789abc")
	trade := w.trade(domain.TradePendingOrder, &order, nil)
	entry := domain.SignalRevision{EventID: "pending-revision-1", Outcome: "applied", Reason: "sl_tp_changed"}
	trade.RevisionIntent = &domain.RevisionIntent{Entry: entry, Patch: map[string]any{"signal": domain.Signal{Symbol: "XAUUSD", Direction: domain.Buy, StopLoss: 1975}}, TargetKind: "pending",
		PriorPrice: order.PriceOpen, PriorSL: order.SL, PriorTP: order.TP, TargetPrice: 1989, TargetSL: 1975, TargetTP: 2010}
	trade.MutationIntent = &domain.MutationIntent{Action: "PENDING_MODIFY", Ticket: order.Ticket, At: store.ISO(w.now), ExpiresAt: w.now.Unix() + 8,
		PriorPrice: order.PriceOpen, PriorSL: order.SL, PriorTP: order.TP, TargetPrice: 1989, TargetSL: 1975, TargetTP: 2010, EventID: entry.EventID}
	w.seedTrade(trade)
	w.br.tradeID, w.br.checkIntent = trade.TradeSetID, true
	runner := w.runner()
	if err := runner.Reconcile(context.Background()); err == nil {
		t.Fatal("unexpired pending revision unexpectedly resolved")
	}
	if w.br.pendingModifyCalls != 0 {
		t.Fatal("pending modify repeated before expiry")
	}
	w.now = w.now.Add(20 * time.Second)
	if err := runner.Reconcile(context.Background()); err == nil {
		t.Fatal("unchanged exact prior state after TTL incorrectly resolved an ambiguous revision")
	}
	if w.br.pendingModifyCalls != 0 {
		t.Fatalf("ambiguous pending modify was resent after TTL: calls=%d", w.br.pendingModifyCalls)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["mutation_intent"] == nil || doc["revision_intent"] == nil || len(asArray(doc["signal_revisions"])) != 0 {
		t.Fatalf("pending revision lost its durable fence: state=%v mutation=%v revision=%v err=%v", doc["state"], doc["mutation_intent"], doc["revision_intent"], err)
	}
}

func TestRecoveredRevisionRejectionIsTerminal(t *testing.T) {
	w := newIntentTestWorld(t)
	order := w.pendingOrder("BT-123456789abc")
	trade := w.trade(domain.TradePendingOrder, &order, nil)
	entry := domain.SignalRevision{EventID: "pending-revision-rejected", Outcome: "applied"}
	trade.RevisionIntent = &domain.RevisionIntent{Entry: entry, Patch: map[string]any{"signal": domain.Signal{Symbol: "XAUUSD", Direction: domain.Buy}}, TargetKind: "pending",
		PriorPrice: order.PriceOpen, PriorSL: order.SL, PriorTP: order.TP, TargetPrice: 1989, TargetSL: 1975, TargetTP: 2010}
	w.seedTrade(trade)
	w.br.tradeID, w.br.checkIntent = trade.TradeSetID, true
	w.sim.FailNext("modifyPendingOrder", broker.FailReject, 10016)
	runner := w.runner()
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w.br.pendingModifyCalls != 1 {
		t.Fatalf("rejected recovered revision resent: calls=%d", w.br.pendingModifyCalls)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["mutation_intent"] != nil || doc["revision_intent"] != nil {
		t.Fatalf("rejected revision did not clear intent: mutation=%v revision=%v err=%v", doc["mutation_intent"], doc["revision_intent"], err)
	}
	revisions := asArray(doc["signal_revisions"])
	if len(revisions) != 1 || object(revisions[0])["outcome"] != "ignored" || object(revisions[0])["reason"] != "broker_rejected_10016" {
		t.Fatalf("rejection outcome not recorded terminally: %+v", revisions)
	}
}

func TestPendingExpiryCancelAmbiguityDoesNotRetryAfterTTL(t *testing.T) {
	w := newIntentTestWorld(t)
	order := w.pendingOrder("BT-123456789abc")
	trade := w.trade(domain.TradePendingOrder, &order, nil)
	expires := w.now.Unix() - 60
	trade.Submission = &domain.Submission{PendingExpiresAt: &expires}
	w.seedTrade(trade)
	w.br.tradeID, w.br.checkIntent, w.br.noOpCancel = trade.TradeSetID, true, true
	runner := w.runner()
	if err := runner.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := runner.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w.br.cancelCalls != 1 {
		t.Fatalf("pending expiry resent before broker request expiry: cancel calls=%d", w.br.cancelCalls)
	}
	w.now = w.now.Add(20 * time.Second)
	if err := runner.Reconcile(context.Background()); err == nil {
		t.Fatal("unchanged order after TTL incorrectly cleared an ambiguous expiry cancel")
	}
	if err := runner.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w.br.cancelCalls != 1 {
		t.Fatalf("pending expiry cancel was resent after TTL: calls=%d", w.br.cancelCalls)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradePendingOrder) || doc["mutation_intent"] == nil {
		t.Fatalf("pending expiry ambiguity lost its fence: state=%v intent=%v err=%v", doc["state"], doc["mutation_intent"], err)
	}
}

func TestProtectiveStopMutationPersistsBeforeSendAndReconciles(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("BT-123456789abc")
	trade := w.trade(domain.TradeOpen, nil, &position)
	trade.ProfileSnapshot.BreakEven = domain.BreakEvenConfig{Enabled: true, Trigger: "price_distance", TriggerValue: 10}
	w.seedTrade(trade)
	w.br.tradeID, w.br.checkIntent = trade.TradeSetID, true
	w.sim.FailNext("modifyPosition", broker.FailAmbiguous, 0)
	if err := w.sim.SetQuote(context.Background(), "XAUUSD", 2015, 2015.2, w.now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	runner := w.runner()
	if err := runner.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w.br.modifyCalls != 1 {
		t.Fatalf("expected one stop move, calls=%d", w.br.modifyCalls)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || object(doc["mutation_intent"]) == nil {
		t.Fatalf("ambiguous stop change did not retain durable intent: intent=%v err=%v", doc["mutation_intent"], err)
	}
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := runner.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w.br.modifyCalls != 1 {
		t.Fatalf("protective stop was blindly resent after target readback: calls=%d", w.br.modifyCalls)
	}
	doc, err = w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["mutation_intent"] != nil {
		t.Fatalf("observed stop target did not clear intent: %v err=%v", doc["mutation_intent"], err)
	}
}

func TestLifecycleWaitsForRevisionIntent(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("BT-123456789abc")
	trade := w.trade(domain.TradeOpen, nil, &position)
	trade.ProfileSnapshot.BreakEven = domain.BreakEvenConfig{Enabled: true, Trigger: "price_distance", TriggerValue: 10}
	trade.RevisionIntent = &domain.RevisionIntent{Entry: domain.SignalRevision{EventID: "still-revising"}, TargetKind: "position", TargetSL: 1995, TargetTP: 2020}
	w.seedTrade(trade)
	w.br.tradeID, w.br.checkIntent = trade.TradeSetID, true
	if err := w.sim.SetQuote(context.Background(), "XAUUSD", 2015, 2015.2, w.now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err := w.runner().Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w.br.modifyCalls != 0 {
		t.Fatalf("lifecycle modified a position while a revision intent was unresolved: calls=%d", w.br.modifyCalls)
	}
}

func TestCloseAllRunningCommandRecoversAfterCrashWithoutResend(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("BT-123456789abc")
	trade := w.trade(domain.TradeOpen, nil, &position)
	w.seedTrade(trade)
	if err := w.db.Put(context.Background(), "settings", "default", store.Document{"execution": map[string]any{"mode": "paper"}, "trading": map[string]any{"kill_switch": false}}); err != nil {
		t.Fatal(err)
	}
	requestedAt := store.ISO(w.now)
	if err := w.db.Put(context.Background(), "admin_commands", "close-1", store.Document{"type": "close_all", "confirm": closeAllConfirmation, "requested_at": requestedAt, "status": "pending"}); err != nil {
		t.Fatal(err)
	}
	w.br.tradeID, w.br.checkIntent, w.br.crashClose = trade.TradeSetID, true, true
	func() {
		defer func() {
			if value := recover(); value != "crash_after_close_handoff" {
				t.Fatalf("expected crash after broker close, got %v", value)
			}
		}()
		_ = w.runner().ProcessAdminCommands(context.Background())
	}()
	if w.br.closeCalls != 1 {
		t.Fatalf("expected one external close before crash, calls=%d", w.br.closeCalls)
	}
	w.reopen()
	w.br.tradeID = trade.TradeSetID
	runner := w.runner()
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := runner.ProcessAdminCommands(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w.br.closeCalls != 0 {
		t.Fatalf("recovered close-all sent a duplicate close: calls=%d", w.br.closeCalls)
	}
	command, err := w.db.Get(context.Background(), "admin_commands", "close-1")
	if err != nil || command["status"] == "running" {
		t.Fatalf("running close-all command was not recovered: status=%v err=%v", command["status"], err)
	}
	updated, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || updated["state"] != string(domain.TradeClosed) || updated["mutation_intent"] != nil {
		t.Fatalf("close-all trade not settled: state=%v intent=%v err=%v", updated["state"], updated["mutation_intent"], err)
	}
	positions, err := w.sim.GetPositions(context.Background(), "")
	if err != nil || len(positions) != 0 {
		t.Fatalf("broker position remains after recovered close-all: %+v err=%v", positions, err)
	}
}

func TestCloseAllPersistsClosedTradeBeforeCommandCompletes(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("BT-123456789abc")
	trade := w.trade(domain.TradeOpen, nil, &position)
	w.seedTrade(trade)
	if err := w.db.Put(context.Background(), "settings", "default", store.Document{"execution": map[string]any{"mode": "paper"}, "trading": map[string]any{"kill_switch": false}}); err != nil {
		t.Fatal(err)
	}
	if err := w.db.Put(context.Background(), "admin_commands", "close-complete", store.Document{"type": "close_all", "confirm": closeAllConfirmation, "requested_at": store.ISO(w.now), "status": "pending"}); err != nil {
		t.Fatal(err)
	}
	w.br.tradeID, w.br.checkIntent = trade.TradeSetID, true
	if err := w.runner().ProcessAdminCommands(context.Background()); err != nil {
		t.Fatal(err)
	}
	command, err := w.db.Get(context.Background(), "admin_commands", "close-complete")
	if err != nil || command["status"] != "done" {
		t.Fatalf("close-all command did not complete: status=%v err=%v", command["status"], err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeClosed) || doc["result"] == nil || object(doc["lifecycle"])["current_volume"] != float64(0) {
		t.Fatalf("command completed with stale open-trade snapshot: state=%v result=%v lifecycle=%v err=%v", doc["state"], doc["result"], doc["lifecycle"], err)
	}
}

func TestCloseAllStaysRunningWhileLinkedMutationIsUnresolved(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("BT-123456789abc")
	trade := w.trade(domain.TradeOpen, nil, &position)
	trade.CloseRequestedBy, trade.CloseRequestStatus = "close_all", "ambiguous"
	trade.MutationIntent = &domain.MutationIntent{Action: "CLOSE_POSITION", Ticket: position.Ticket, At: store.ISO(w.now), ExpiresAt: w.now.Unix() + 30,
		PriorSL: position.SL, PriorTP: position.TP, PriorVolume: position.Volume, TargetRemainingVolume: 0, Reason: "close_all"}
	w.seedTrade(trade)
	if err := w.db.Put(context.Background(), "admin_commands", "close-wait", store.Document{"type": "close_all", "confirm": closeAllConfirmation, "requested_at": store.ISO(w.now), "status": "running"}); err != nil {
		t.Fatal(err)
	}
	runner := w.runner()
	if err := runner.ProcessAdminCommands(context.Background()); err != nil {
		t.Fatal(err)
	}
	command, err := w.db.Get(context.Background(), "admin_commands", "close-wait")
	if err != nil || command["status"] != "running" || object(command["result"])["awaiting_reconciliation"] != true {
		t.Fatalf("close-all was marked complete with unresolved trade mutation: status=%v result=%v err=%v", command["status"], command["result"], err)
	}
	if w.br.closeCalls != 0 {
		t.Fatalf("recovered running command repeated unresolved close: calls=%d", w.br.closeCalls)
	}
	positions, err := w.sim.GetPositions(context.Background(), "")
	if err != nil || len(positions) != 1 {
		t.Fatalf("position changed while close intent was unresolved: %+v err=%v", positions, err)
	}
}

func TestCloseAllAdminLedgerRemainsFencedAfterExpiryAndFreshPriorRead(t *testing.T) {
	w := newIntentTestWorld(t)
	w.marketPosition("unlinked-position")
	if err := w.db.Put(context.Background(), "settings", "default", store.Document{"execution": map[string]any{"mode": "paper"}, "trading": map[string]any{"kill_switch": false}}); err != nil {
		t.Fatal(err)
	}
	if err := w.db.Put(context.Background(), "admin_commands", "close-ledger", store.Document{"type": "close_all", "confirm": closeAllConfirmation, "requested_at": store.ISO(w.now), "status": "pending"}); err != nil {
		t.Fatal(err)
	}
	w.br.noOpClose = true
	runner := w.runner()
	if err := runner.ProcessAdminCommands(context.Background()); err != nil {
		t.Fatal(err)
	}
	command, err := w.db.Get(context.Background(), "admin_commands", "close-ledger")
	if err != nil || command["status"] != "running" || object(command["result"])["awaiting_reconciliation"] != true {
		t.Fatalf("uncertain close-all ledger was declared complete: status=%v result=%v err=%v", command["status"], command["result"], err)
	}
	if w.br.closeCalls != 1 {
		t.Fatalf("second sweep repeated close before expiry: calls=%d", w.br.closeCalls)
	}
	w.now = w.now.Add(20 * time.Second)
	if err := runner.ProcessAdminCommands(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w.br.closeCalls != 1 {
		t.Fatalf("ambiguous close-all action was resent after expiry: calls=%d", w.br.closeCalls)
	}
	command, err = w.db.Get(context.Background(), "admin_commands", "close-ledger")
	if err != nil || command["status"] != "running" {
		t.Fatalf("unresolved admin ledger did not remain running: status=%v err=%v", command["status"], err)
	}
	positions, err := w.sim.GetPositions(context.Background(), "")
	if err != nil || len(positions) != 1 {
		t.Fatalf("ambiguous close-all changed the position after TTL: %+v err=%v", positions, err)
	}
}

func TestCloseAllOrphanAmbiguityFencesLaterCommandsAcrossRestart(t *testing.T) {
	w := newIntentTestWorld(t)
	ctx := context.Background()
	position := w.marketPosition("orphan-close-target")
	if err := w.db.Put(ctx, "settings", "default", store.Document{"execution": map[string]any{"mode": "paper"}, "trading": map[string]any{"kill_switch": false}}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a-close", "b-close"} {
		if err := w.db.Put(ctx, "admin_commands", id, store.Document{"type": "close_all", "confirm": closeAllConfirmation, "requested_at": store.ISO(w.now), "created_at": store.ISO(w.now), "status": "pending"}); err != nil {
			t.Fatal(err)
		}
	}
	w.br.noOpClose = true
	runner := w.runner()
	if err := runner.ProcessAdminCommands(ctx); err != nil {
		t.Fatal(err)
	}
	first, err := w.db.Get(ctx, "admin_commands", "a-close")
	if err != nil || first["status"] != "running" || w.br.closeCalls != 1 {
		t.Fatalf("first close-all did not retain its ambiguous handoff: status=%v calls=%d err=%v", first["status"], w.br.closeCalls, err)
	}
	second, err := w.db.Get(ctx, "admin_commands", "b-close")
	if err != nil || second["status"] != "pending" {
		t.Fatalf("later close-all bypassed running ambiguous command: status=%v err=%v", second["status"], err)
	}
	if err := runner.ProcessAdminCommands(ctx); err != nil {
		t.Fatal(err)
	}
	if w.br.closeCalls != 1 {
		t.Fatalf("running command repeated its ambiguous close: calls=%d", w.br.closeCalls)
	}

	if err := runner.finishAdminCommand(ctx, "a-close", "failed", map[string]any{"reason": "injected terminalization"}); err != nil {
		t.Fatal(err)
	}
	first, err = w.db.Get(ctx, "admin_commands", "a-close")
	if err != nil || first["status"] != "running" {
		t.Fatalf("unresolved mutation ledger was terminalized: status=%v err=%v", first["status"], err)
	}
	// Model a previously restored record that was incorrectly marked terminal.
	first["status"], first["finished_at"] = "failed", store.ISO(w.now)
	if err := w.db.Put(ctx, "admin_commands", "a-close", first); err != nil {
		t.Fatal(err)
	}
	if err := runner.ProcessAdminCommands(ctx); err != nil {
		t.Fatal(err)
	}
	first, err = w.db.Get(ctx, "admin_commands", "a-close")
	second, _ = w.db.Get(ctx, "admin_commands", "b-close")
	if err != nil || first["status"] != "running" || first["recovery_only"] != true || second["status"] != "pending" || w.br.closeCalls != 1 {
		t.Fatalf("terminal ledger recovery bypassed the original target fence: first=%v second=%v calls=%d err=%v", first, second["status"], w.br.closeCalls, err)
	}

	w.reopen()
	runner = w.runner()
	if err := runner.ProcessAdminCommands(ctx); err != nil {
		t.Fatal(err)
	}
	second, err = w.db.Get(ctx, "admin_commands", "b-close")
	if err != nil || second["status"] != "pending" || w.br.closeCalls != 0 {
		t.Fatalf("restart recovery sent again or consumed later command: status=%v calls=%d err=%v", second["status"], w.br.closeCalls, err)
	}
	if _, err := w.sim.ClosePosition(ctx, position.Ticket, nil); err != nil {
		t.Fatal(err)
	}
	if err := runner.ProcessAdminCommands(ctx); err != nil {
		t.Fatal(err)
	}
	first, err = w.db.Get(ctx, "admin_commands", "a-close")
	second, _ = w.db.Get(ctx, "admin_commands", "b-close")
	if err != nil || first["status"] != "failed" || object(first["result"])["awaiting_reconciliation"] == true || second["status"] != "pending" {
		t.Fatalf("target resolution did not release only the first command: first=%v second=%v err=%v", first["status"], second["status"], err)
	}
	if err := runner.ProcessAdminCommands(ctx); err != nil {
		t.Fatal(err)
	}
	second, err = w.db.Get(ctx, "admin_commands", "b-close")
	if err != nil || second["status"] != "done" || w.br.closeCalls != 0 {
		t.Fatalf("later command did not wait for resolution or sent a duplicate: status=%v calls=%d err=%v", second["status"], w.br.closeCalls, err)
	}
}

func TestTerminalOrphanLedgerUsesStoredPositionIdentifier(t *testing.T) {
	w := newIntentTestWorld(t)
	ctx := context.Background()
	position := w.marketPosition("orphan-identifier-target")
	identifier := position.Ticket + 10000
	placed, err := w.sim.PlaceOrder(ctx, broker.PlaceOrderRequest{Symbol: "XAUUSD", OrderType: broker.MarketBuy, Volume: .03, SL: 1990, TP: 2020, Comment: "BT-333333333333"})
	if err != nil {
		t.Fatal(err)
	}
	positions, err := w.sim.GetPositions(ctx, "XAUUSD")
	if err != nil {
		t.Fatal(err)
	}
	unrelatedPosition := findPosition(positions, placed.PositionTicket, w.sim.Magic())
	if unrelatedPosition == nil {
		t.Fatal("unrelated position was not created")
	}
	unrelated := w.trade(domain.TradeOpen, nil, unrelatedPosition)
	unrelated.TradeSetID = "-100900_unrelated"
	unrelated.MutationIntent = &domain.MutationIntent{Action: "POSITION_MODIFY", Ticket: unrelatedPosition.Ticket, At: store.ISO(w.now), ExpiresAt: w.now.Unix() + 8,
		PriorSL: unrelatedPosition.SL, PriorTP: unrelatedPosition.TP, TargetSL: unrelatedPosition.SL + 1, TargetTP: unrelatedPosition.TP}
	w.seedTrade(unrelated)
	firstClose := .02
	if _, err := w.sim.ClosePosition(ctx, position.Ticket, &firstClose); err != nil {
		t.Fatal(err)
	}
	remainingVolume := .01
	if _, err := w.sim.ClosePosition(ctx, position.Ticket, &remainingVolume); err != nil {
		t.Fatal(err)
	}
	key := adminMutationKey("paper", "position", position.Ticket)
	state := adminMutationState{Mode: "paper", Kind: "position", Ticket: position.Ticket, PositionIdentifier: identifier, Status: "ambiguous", At: store.ISO(w.now), PriorVolume: remainingVolume}
	if err := w.db.Put(ctx, "admin_commands", "restored-close", store.Document{
		"type": "close_all", "confirm": closeAllConfirmation, "requested_at": store.ISO(w.now), "created_at": store.ISO(w.now), "status": "done",
		"mutation_intents": map[string]any{key: state},
	}); err != nil {
		t.Fatal(err)
	}
	adapter := &mismatchedPositionIdentifierBroker{Broker: w.br, ticket: position.Ticket, id: identifier}
	runner := NewRunner(w.db, Config{Now: func() time.Time { return w.now }, BrokerForMode: func(context.Context, string) (broker.Broker, error) { return adapter, nil }})
	if err := runner.ProcessAdminCommands(ctx); err != nil {
		t.Fatal(err)
	}
	command, err := w.db.Get(ctx, "admin_commands", "restored-close")
	if err != nil || command["status"] != "done" || object(command["mutation_intents"])[key] == nil {
		t.Fatalf("terminal orphan close was not recovered: status=%v ledger=%v err=%v", command["status"], command["mutation_intents"], err)
	}
	var recovered adminMutationState
	if err := decodeJSON(object(command["mutation_intents"])[key], &recovered); err != nil || recovered.Status != "done" || recovered.PositionIdentifier != identifier {
		t.Fatalf("orphan exit proof did not use the stored position identifier: state=%+v err=%v", recovered, err)
	}
	if w.br.closeCalls != 0 {
		t.Fatalf("terminal readback recovery sent a new close: calls=%d", w.br.closeCalls)
	}
	unrelatedDoc, err := w.db.Get(ctx, "trade_sets", unrelated.TradeSetID)
	if err != nil || unrelatedDoc["state"] != string(domain.TradeOpen) || unrelatedDoc["mutation_intent"] == nil {
		t.Fatalf("terminal recovery was blocked or changed by an unrelated trade intent: state=%v intent=%v err=%v", unrelatedDoc["state"], unrelatedDoc["mutation_intent"], err)
	}
}

func TestTerminalOrphanLedgerKeepsRotatedLivePositionUnresolved(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("rotated-admin-position")
	key := adminMutationKey("paper", "position", position.Ticket)
	state := adminMutationState{Mode: "paper", Kind: "position", Ticket: position.Ticket, PositionIdentifier: position.Identifier, Status: "ambiguous", At: store.ISO(w.now), PriorVolume: position.Volume}
	if err := w.db.Put(context.Background(), "admin_commands", "rotated-close", store.Document{
		"type": "close_all", "confirm": closeAllConfirmation, "requested_at": store.ISO(w.now), "created_at": store.ISO(w.now), "status": "done",
		"mutation_intents": map[string]any{key: state},
	}); err != nil {
		t.Fatal(err)
	}
	adapter := &rotatedPositionWithFailingDealsBroker{Broker: w.br, ticket: position.Ticket, rotatedTicket: position.Ticket + 50000, identifier: position.Identifier}
	runner := NewRunner(w.db, Config{Now: func() time.Time { return w.now }, BrokerForMode: func(context.Context, string) (broker.Broker, error) { return adapter, nil }})
	if err := runner.ProcessAdminCommands(context.Background()); err != nil {
		t.Fatal(err)
	}
	command, err := w.db.Get(context.Background(), "admin_commands", "rotated-close")
	if err != nil || command["status"] != "running" || adapter.dealCalls != 0 {
		t.Fatalf("live identifier-matched position was treated as absent: status=%v deal_reads=%d err=%v", command["status"], adapter.dealCalls, err)
	}
	var recovered adminMutationState
	if err := decodeJSON(object(command["mutation_intents"])[key], &recovered); err != nil || recovered.Status != "ambiguous" {
		t.Fatalf("rotated live position lost its unresolved ledger: state=%+v err=%v", recovered, err)
	}
}

func TestTerminalOrphanLedgerDoesNotCountSameSecondPriorPartialAsFullClose(t *testing.T) {
	w := newIntentTestWorld(t)
	ctx := context.Background()
	position := w.marketPosition("prior-partial-admin-position")
	intentTime := w.now
	partialVolume := .02
	if _, err := w.sim.ClosePosition(ctx, position.Ticket, &partialVolume); err != nil {
		t.Fatal(err)
	}
	key := adminMutationKey("paper", "position", position.Ticket)
	state := adminMutationState{Mode: "paper", Kind: "position", Ticket: position.Ticket, PositionIdentifier: position.Identifier, Status: "ambiguous", At: store.ISO(intentTime), PriorVolume: .01}
	if err := w.db.Put(ctx, "admin_commands", "prior-partial-close", store.Document{
		"type": "close_all", "confirm": closeAllConfirmation, "requested_at": store.ISO(w.now), "created_at": store.ISO(w.now), "status": "done",
		"mutation_intents": map[string]any{key: state},
	}); err != nil {
		t.Fatal(err)
	}
	adapter := &hiddenPositionViewBroker{Broker: w.br, ticket: position.Ticket}
	runner := NewRunner(w.db, Config{Now: func() time.Time { return w.now }, BrokerForMode: func(context.Context, string) (broker.Broker, error) { return adapter, nil }})
	if err := runner.ProcessAdminCommands(ctx); err != nil {
		t.Fatal(err)
	}
	command, err := w.db.Get(ctx, "admin_commands", "prior-partial-close")
	if err != nil || command["status"] != "running" {
		t.Fatalf("same-second partial exit incorrectly settled an ambiguous close: status=%v err=%v", command["status"], err)
	}
	var recovered adminMutationState
	if err := decodeJSON(object(command["mutation_intents"])[key], &recovered); err != nil || recovered.Status != "ambiguous" {
		t.Fatalf("same-second partial volume cleared the close ledger: state=%+v err=%v", recovered, err)
	}
	positions, err := w.sim.GetPositions(ctx, "XAUUSD")
	if err != nil || len(positions) != 1 || math.Abs(positions[0].Volume-.01) > 1e-9 {
		t.Fatalf("lagging view fixture did not retain its residual position: positions=%+v err=%v", positions, err)
	}
}

func TestCloseAllTradeListAndIntentGatePaginatePastStoreLimit(t *testing.T) {
	w := newIntentTestWorld(t)
	const total = 5001
	const seedBatch = 250
	for start := 0; start < total; start += seedBatch {
		end := min(start+seedBatch, total)
		err := w.db.WithTx(context.Background(), func(tx *store.Tx) error {
			for i := start; i < end; i++ {
				id := fmt.Sprintf("page-trade-%05d", i)
				doc := store.Document{"schema": 2, "trade_set_id": id, "state": "OPEN", "mode": "paper", "created_at": store.ISO(w.now), "signal_revisions": []any{}}
				if i == total-1 {
					doc["mutation_intent"] = map[string]any{"action": "POSITION_MODIFY", "ticket": 91, "at": store.ISO(w.now), "expires_at": w.now.Unix() + 8}
				}
				if _, err := tx.Create("trade_sets", id, doc); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	var results []closeAllEntry
	trades, err := w.runner().listCloseAllTrades(context.Background(), &results, 1)
	if err != nil || len(trades) != total {
		t.Fatalf("close-all list stopped at a store page boundary: count=%d want=%d err=%v", len(trades), total, err)
	}
	unsettled, err := w.runner().hasUnsettledCloseAllTradeIntents(context.Background())
	if err != nil || !unsettled {
		t.Fatalf("close-all intent gate missed an unresolved trade beyond page one: unsettled=%v err=%v", unsettled, err)
	}
}

func TestCheckpointPartialAcknowledgmentReplansToTargetAndKeepsProtectiveStopsRunning(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPositionVolume("BT-123456789abc", .10)
	trade := w.trade(domain.TradeOpen, nil, &position)
	trade.Plan.Volume = .10
	profile := validMutationTestProfile(t)
	profile.BreakEven = domain.BreakEvenConfig{Enabled: true, Trigger: "price_distance", TriggerValue: 1, BufferPrice: .1}
	profile.Trailing.Enabled = false
	profile.StopLoss.AfterCheckpoint = nil
	trade.ProfileSnapshot = &profile
	trade.Lifecycle.Checkpoints = []domain.CheckpointState{{TPIndex: 1, Price: 2010, CloseVolume: .04, TargetRemainingVolume: .06, Status: "pending"}}
	w.seedTrade(trade)
	w.br.tradeID, w.br.checkIntent = trade.TradeSetID, true
	w.br.partialCloseVolumes = []float64{.02}
	if err := w.sim.SetQuote(context.Background(), "XAUUSD", 2011, 2011.2, w.now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	runner := w.runner()
	if err := runner.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil {
		t.Fatal(err)
	}
	var lifecycle domain.TradeLifecycle
	if err := decodeJSON(doc["lifecycle"], &lifecycle); err != nil {
		t.Fatal(err)
	}
	if lifecycle.Checkpoints[0].Status == "done" || !lifecycle.Checkpoints[0].PartialConfirmed || math.Abs(lifecycle.CurrentVolume-.08) > 1e-9 {
		t.Fatalf("partial acknowledgment falsely completed checkpoint: checkpoint=%+v current_volume=%v", lifecycle.Checkpoints[0], lifecycle.CurrentVolume)
	}
	if w.br.modifyCalls != 1 {
		t.Fatalf("confirmed partial close starved protective stop management: modify calls=%d", w.br.modifyCalls)
	}
	if err := runner.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err = w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil {
		t.Fatal(err)
	}
	if err := decodeJSON(doc["lifecycle"], &lifecycle); err != nil {
		t.Fatal(err)
	}
	if lifecycle.Checkpoints[0].Status != "done" || math.Abs(lifecycle.CurrentVolume-.06) > 1e-9 {
		t.Fatalf("checkpoint did not complete at target remaining volume: checkpoint=%+v current_volume=%v", lifecycle.Checkpoints[0], lifecycle.CurrentVolume)
	}
	if len(w.br.requestedCloseVolumes) != 2 || math.Abs(w.br.requestedCloseVolumes[0]-.04) > 1e-9 || math.Abs(w.br.requestedCloseVolumes[1]-.02) > 1e-9 {
		t.Fatalf("checkpoint did not recompute remaining delta from fresh volume: close requests=%v", w.br.requestedCloseVolumes)
	}
}

func TestFinalCheckpointPartialAcknowledgmentKeepsZeroTargetOpenUntilAbsent(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("BT-123456789abc")
	trade := w.trade(domain.TradeOpen, nil, &position)
	profile := validMutationTestProfile(t)
	profile.BreakEven.Enabled, profile.Trailing.Enabled = false, false
	profile.StopLoss.AfterCheckpoint = nil
	trade.ProfileSnapshot = &profile
	trade.Lifecycle.Checkpoints = []domain.CheckpointState{{TPIndex: 1, Price: 2010, CloseVolume: .03, TargetRemainingVolume: 0, Status: "pending"}}
	w.seedTrade(trade)
	w.br.partialCloseVolumes = []float64{.01}
	if err := w.sim.SetQuote(context.Background(), "XAUUSD", 2011, 2011.2, w.now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	runner := w.runner()
	if err := runner.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil {
		t.Fatal(err)
	}
	var lifecycle domain.TradeLifecycle
	if err := decodeJSON(doc["lifecycle"], &lifecycle); err != nil {
		t.Fatal(err)
	}
	if lifecycle.Checkpoints[0].Status == "done" || lifecycle.CurrentVolume != .02 {
		t.Fatalf("final zero-target checkpoint marked done with live volume: %+v", lifecycle)
	}
	if err := runner.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err = w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil {
		t.Fatal(err)
	}
	if err := decodeJSON(doc["lifecycle"], &lifecycle); err != nil {
		t.Fatal(err)
	}
	if lifecycle.Checkpoints[0].Status != "done" || lifecycle.CurrentVolume != 0 {
		t.Fatalf("zero-target checkpoint not confirmed after exact ticket disappeared: %+v", lifecycle)
	}
	if err := runner.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err = w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeClosed) {
		t.Fatalf("final close was not settled from exact exit deal: state=%v err=%v", doc["state"], err)
	}
	if len(w.br.requestedCloseVolumes) != 2 || math.Abs(w.br.requestedCloseVolumes[1]-.02) > 1e-9 {
		t.Fatalf("final close did not send fresh target delta: %v", w.br.requestedCloseVolumes)
	}
}

func TestCheckpointResidualAfterDoneRetcodeDoesNotContinueAsConfirmedPartial(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("BT-123456789abc")
	trade := w.trade(domain.TradeOpen, nil, &position)
	profile := validMutationTestProfile(t)
	profile.BreakEven.Enabled, profile.Trailing.Enabled = false, false
	profile.StopLoss.AfterCheckpoint = nil
	trade.ProfileSnapshot = &profile
	trade.Lifecycle.Checkpoints = []domain.CheckpointState{{TPIndex: 1, Price: 2010, CloseVolume: .03, TargetRemainingVolume: 0, Status: "pending"}}
	w.seedTrade(trade)
	w.br.partialCloseVolumes = []float64{.01}
	w.br.closeRetcodeOverride = 10009
	if err := w.sim.SetQuote(context.Background(), "XAUUSD", 2011, 2011.2, w.now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	runner := w.runner()
	if err := runner.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	w.now = w.now.Add(20 * time.Second)
	if err := runner.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil {
		t.Fatal(err)
	}
	var lifecycle domain.TradeLifecycle
	if err := decodeJSON(doc["lifecycle"], &lifecycle); err != nil {
		t.Fatal(err)
	}
	if lifecycle.Checkpoints[0].Status != "closing" || lifecycle.Checkpoints[0].PartialConfirmed || lifecycle.CurrentVolume != .02 {
		t.Fatalf("DONE response with residual was treated as confirmed partial: checkpoint=%+v lifecycle=%+v", lifecycle.Checkpoints[0], lifecycle)
	}
	if w.br.closeCalls != 1 {
		t.Fatalf("DONE response residual was resent after TTL: calls=%d", w.br.closeCalls)
	}
}

func TestDirectCancelPartialCloseStaysOpenAndReconcilesFreshRemainder(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("BT-123456789abc")
	trade := w.trade(domain.TradeOpen, nil, &position)
	w.seedTrade(trade)
	w.br.tradeID, w.br.checkIntent = trade.TradeSetID, true
	w.br.partialCloseVolumes = []float64{.01}
	runner := w.runner()
	event := domain.SignalEvent{EventID: "direct-cancel", ChatID: trade.ChatID, MessageID: trade.MessageID, CancelReason: "explicit_cancel"}
	result := runner.handleCancel(context.Background(), event)
	if result.Reason != "cancel_close_partial_pending" || result.State != domain.TradeOpen {
		t.Fatalf("partial close was reported terminal: %+v", result)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeOpen) || doc["mutation_intent"] == nil {
		t.Fatalf("partial cancellation hid live volume: state=%v intent=%v err=%v", doc["state"], doc["mutation_intent"], err)
	}
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err = w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeClosed) || doc["mutation_intent"] != nil {
		t.Fatalf("reconciler did not finish the confirmed remainder: state=%v intent=%v err=%v", doc["state"], doc["mutation_intent"], err)
	}
	if len(w.br.requestedCloseVolumes) != 2 || math.Abs(w.br.requestedCloseVolumes[1]-.02) > 1e-9 {
		t.Fatalf("cancel retry did not use freshly observed remaining volume: %v", w.br.requestedCloseVolumes)
	}
}

func TestCancelDoneRetcodeWithResidualStaysFencedWithoutContinuation(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("BT-123456789abc")
	trade := w.trade(domain.TradeOpen, nil, &position)
	w.seedTrade(trade)
	w.br.partialCloseVolumes = []float64{.01}
	w.br.closeRetcodeOverride = 10009
	runner := w.runner()
	event := domain.SignalEvent{EventID: "cancel-done-residual", ChatID: trade.ChatID, MessageID: trade.MessageID, CancelReason: "explicit_cancel"}
	result := runner.handleCancel(context.Background(), event)
	if result.State == domain.TradeClosed {
		t.Fatalf("DONE response with residual was terminalized: %+v", result)
	}
	w.now = w.now.Add(20 * time.Second)
	if err := runner.Reconcile(context.Background()); err == nil {
		t.Fatal("residual after non-partial DONE response was not held for reconciliation")
	}
	if w.br.closeCalls != 1 {
		t.Fatalf("residual after DONE response was sent again: calls=%d", w.br.closeCalls)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeOpen) || doc["mutation_intent"] == nil {
		t.Fatalf("unconfirmed residual did not retain its intent: state=%v intent=%v err=%v", doc["state"], doc["mutation_intent"], err)
	}
}

func TestConfirmedPartialCloseRetriesAfterDefiniteRejection(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("BT-123456789abc")
	trade := w.trade(domain.TradeOpen, nil, &position)
	w.seedTrade(trade)
	w.br.partialCloseVolumes = []float64{.01}
	runner := w.runner()
	event := domain.SignalEvent{EventID: "partial-reject-retry", ChatID: trade.ChatID, MessageID: trade.MessageID, CancelReason: "explicit_cancel"}
	if got := runner.handleCancel(context.Background(), event); got.Reason != "cancel_close_partial_pending" {
		t.Fatalf("first partial close did not remain pending: %+v", got)
	}
	w.br.closeError = &broker.RejectedError{Retcode: 10018, Message: "market closed"}
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil {
		t.Fatal(err)
	}
	var intent domain.MutationIntent
	if err := decodeJSON(doc["mutation_intent"], &intent); err != nil || !intent.PartialConfirmed {
		t.Fatalf("definite rejection discarded confirmed-partial retry permission: intent=%+v err=%v", intent, err)
	}
	if w.br.closeCalls != 2 {
		t.Fatalf("unexpected close count after definite rejection: %d", w.br.closeCalls)
	}
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err = w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeClosed) || doc["mutation_intent"] != nil {
		t.Fatalf("confirmed partial close did not recover after definite rejection: state=%v intent=%v err=%v", doc["state"], doc["mutation_intent"], err)
	}
	if w.br.closeCalls != 3 || len(w.br.requestedCloseVolumes) != 2 || math.Abs(w.br.requestedCloseVolumes[1]-.02) > 1e-9 {
		t.Fatalf("retry did not use exact freshly observed remainder: calls=%d requests=%v", w.br.closeCalls, w.br.requestedCloseVolumes)
	}
}

func TestDefiniteCancelRejectionClearsIntentAndReconcilerRetries(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("BT-123456789abc")
	trade := w.trade(domain.TradeOpen, nil, &position)
	w.seedTrade(trade)
	w.br.closeError = &broker.RejectedError{Retcode: 10018, Message: "market closed"}
	runner := w.runner()
	event := domain.SignalEvent{EventID: "cancel-rejected-retry", ChatID: trade.ChatID, MessageID: trade.MessageID, CancelReason: "explicit_cancel"}
	result := runner.handleCancel(context.Background(), event)
	if result.Reason != "close_rejected" || result.State != domain.TradeOpen {
		t.Fatalf("definite close rejection changed trade state: %+v", result)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["mutation_intent"] != nil {
		t.Fatalf("definite rejection remained ambiguously fenced: intent=%v err=%v", doc["mutation_intent"], err)
	}
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err = w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeClosed) {
		t.Fatalf("persisted cancel request was not retried after definite rejection: state=%v err=%v", doc["state"], err)
	}
	if w.br.closeCalls != 2 {
		t.Fatalf("expected one rejected and one successful close attempt, got %d", w.br.closeCalls)
	}
}

func TestPendingCancelRejectionClearsIntentAndReconcilerRetries(t *testing.T) {
	w := newIntentTestWorld(t)
	order := w.pendingOrder("BT-123456789abc")
	trade := w.trade(domain.TradePendingOrder, &order, nil)
	w.seedTrade(trade)
	w.br.cancelError = &broker.RejectedError{Retcode: 10018, Message: "market closed"}
	runner := w.runner()
	event := domain.SignalEvent{EventID: "pending-cancel-rejected-retry", ChatID: trade.ChatID, MessageID: trade.MessageID, CancelReason: "explicit_cancel"}
	result := runner.handleCancel(context.Background(), event)
	if result.Reason != "cancel_rejected" {
		t.Fatalf("unexpected pending cancel result: %+v", result)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["mutation_intent"] != nil || doc["state"] != string(domain.TradePendingOrder) {
		t.Fatalf("definite pending cancel rejection remained fenced: state=%v intent=%v err=%v", doc["state"], doc["mutation_intent"], err)
	}
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err = w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeCancelled) || doc["mutation_intent"] != nil {
		t.Fatalf("pending cancel request was not retried after definite rejection: state=%v intent=%v err=%v", doc["state"], doc["mutation_intent"], err)
	}
	if w.br.cancelCalls != 2 {
		t.Fatalf("expected one rejected and one successful cancel attempt, got %d", w.br.cancelCalls)
	}
}

func TestMarketPlacedResultStaysUnknownUntilExactCorrelatedFillAppears(t *testing.T) {
	w := newIntentTestWorld(t)
	trade, corr, p := w.claimedMarketSubmission()
	placed := broker.PlaceOrderResult{Retcode: 10008, OrderTicket: 70001}
	w.br.placeResultOverride, w.br.suppressPlace = &placed, true
	runner := w.runner()
	result := runner.persistAndSend(context.Background(), trade.TradeSetID, corr, p)
	if result.State != domain.TradeSubmitUnknown || result.Reason != "broker_placed_not_completed" {
		t.Fatalf("market PLACED was reported as a fill: %+v", result)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeSubmitUnknown) {
		t.Fatalf("market PLACED did not remain unknown: state=%v err=%v", doc["state"], err)
	}
	var lifecycle domain.TradeLifecycle
	if err := decodeJSON(doc["lifecycle"], &lifecycle); err != nil || lifecycle.CurrentVolume != 0 {
		t.Fatalf("market PLACED fabricated open volume: current_volume=%v err=%v", lifecycle.CurrentVolume, err)
	}
	if w.br.placeCalls != 1 {
		t.Fatalf("market request was not single-send: calls=%d", w.br.placeCalls)
	}
	w.now = w.now.Add(30 * time.Second)
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err = w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeSubmitUnknown) || w.br.placeCalls != 1 {
		t.Fatalf("absent correlation after expiry was rejected or resent: state=%v calls=%d err=%v", doc["state"], w.br.placeCalls, err)
	}
	actual, err := w.sim.PlaceOrder(context.Background(), broker.PlaceOrderRequest{Symbol: "XAUUSD", OrderType: broker.MarketBuy, Volume: .02, SL: 1990, TP: 2020, Comment: corr})
	if err != nil {
		t.Fatal(err)
	}
	w.br.positionIdentifierGap = 9000
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err = w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeOpen) || w.br.placeCalls != 1 {
		t.Fatalf("late exact fill was not adopted without resend: state=%v calls=%d err=%v", doc["state"], w.br.placeCalls, err)
	}
	var refs domain.BrokerRefs
	if err := decodeJSON(doc["broker_refs"], &refs); err != nil {
		t.Fatal(err)
	}
	if refs.PositionTicket != actual.PositionTicket || refs.PositionIdentifier != actual.PositionTicket+9000 || refs.FilledVolume != .02 {
		t.Fatalf("late fill references did not distinguish ticket/id and use broker volume: %+v; actual=%+v", refs, actual)
	}
}

func TestMarketFillUsesExactPositionVolumeWhenReplyVolumeIsZeroAndIDIsNotTicket(t *testing.T) {
	w := newIntentTestWorld(t)
	trade, corr, p := w.claimedMarketSubmission()
	w.br.placeVolumeOverride, w.br.positionIdentifierGap = .02, 9000
	runner := w.runner()
	result := runner.persistAndSend(context.Background(), trade.TradeSetID, corr, p)
	if result.State != domain.TradeOpen {
		t.Fatalf("exact correlated live position was not recorded: %+v", result)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeOpen) {
		t.Fatalf("confirmed partial fill did not open: state=%v err=%v", doc["state"], err)
	}
	var refs domain.BrokerRefs
	if err := decodeJSON(doc["broker_refs"], &refs); err != nil {
		t.Fatal(err)
	}
	var lifecycle domain.TradeLifecycle
	if err := decodeJSON(doc["lifecycle"], &lifecycle); err != nil {
		t.Fatal(err)
	}
	positions, err := w.br.GetPositions(context.Background(), "XAUUSD")
	if err != nil || len(positions) != 1 {
		t.Fatalf("expected exact live position: positions=%+v err=%v", positions, err)
	}
	position := positions[0]
	if refs.PositionTicket != position.Ticket || refs.PositionIdentifier != position.Identifier || refs.FilledVolume != position.Volume || lifecycle.CurrentVolume != position.Volume || position.Volume == p.sizing.Volume {
		t.Fatalf("fill used reply/request assumptions instead of authoritative ticket, identifier, and volume: refs=%+v lifecycle=%+v position=%+v requested=%v", refs, lifecycle, position, p.sizing.Volume)
	}
}

func TestCloseAllReconcileRetriesDefiniteRejection(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("BT-123456789abc")
	trade := w.trade(domain.TradeOpen, nil, &position)
	trade.CloseRequestedBy, trade.CloseRequestStatus = "close_all", "pending"
	w.seedTrade(trade)
	w.br.closeError = &broker.RejectedError{Retcode: 10018, Message: "market closed"}
	runner := w.runner()
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["mutation_intent"] != nil || doc["close_request_status"] != "pending" {
		t.Fatalf("definite close-all rejection was not returned to retryable state: intent=%v status=%v err=%v", doc["mutation_intent"], doc["close_request_status"], err)
	}
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err = w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeClosed) || doc["mutation_intent"] != nil {
		t.Fatalf("close-all was not retried after definite rejection: state=%v intent=%v err=%v", doc["state"], doc["mutation_intent"], err)
	}
	if w.br.closeCalls != 2 {
		t.Fatalf("expected one rejected and one successful close-all attempt, got %d", w.br.closeCalls)
	}
}

func TestReconcileCancelPartialCloseKeepsIntentUntilRemainderGone(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("BT-123456789abc")
	trade := w.trade(domain.TradeOpen, nil, &position)
	trade.CancelRequested = &domain.CancelRequest{Reason: "explicit_cancel", EventID: "reconcile-cancel"}
	w.seedTrade(trade)
	w.br.tradeID, w.br.checkIntent = trade.TradeSetID, true
	w.br.partialCloseVolumes = []float64{.01}
	runner := w.runner()
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeOpen) || doc["mutation_intent"] == nil {
		t.Fatalf("reconcile marked partial cancel closed: state=%v intent=%v err=%v", doc["state"], doc["mutation_intent"], err)
	}
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err = w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeClosed) || doc["mutation_intent"] != nil {
		t.Fatalf("reconcile did not close after fresh remainder read: state=%v intent=%v err=%v", doc["state"], doc["mutation_intent"], err)
	}
}

func TestCloseAllPartialClosesRemainUnsettledForLinkedAndOrphanPositions(t *testing.T) {
	t.Run("linked", func(t *testing.T) {
		w := newIntentTestWorld(t)
		position := w.marketPosition("BT-123456789abc")
		trade := w.trade(domain.TradeOpen, nil, &position)
		w.seedTrade(trade)
		if err := w.db.Put(context.Background(), "settings", "default", store.Document{"execution": map[string]any{"mode": "paper"}, "trading": map[string]any{"kill_switch": false}}); err != nil {
			t.Fatal(err)
		}
		if err := w.db.Put(context.Background(), "admin_commands", "partial-linked", store.Document{"type": "close_all", "confirm": closeAllConfirmation, "requested_at": store.ISO(w.now), "status": "pending"}); err != nil {
			t.Fatal(err)
		}
		w.br.tradeID, w.br.checkIntent = trade.TradeSetID, true
		w.br.partialCloseVolumes = []float64{.01}
		runner := w.runner()
		if err := runner.ProcessAdminCommands(context.Background()); err != nil {
			t.Fatal(err)
		}
		command, err := w.db.Get(context.Background(), "admin_commands", "partial-linked")
		if err != nil || command["status"] != "running" || object(command["result"])["awaiting_reconciliation"] != true {
			t.Fatalf("linked partial close allowed close-all to finish: status=%v result=%v err=%v", command["status"], command["result"], err)
		}
		if w.br.closeCalls != 1 {
			t.Fatalf("second close-all sweep bypassed linked partial intent: calls=%d", w.br.closeCalls)
		}
		if err := runner.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
		if err := runner.ProcessAdminCommands(context.Background()); err != nil {
			t.Fatal(err)
		}
		command, err = w.db.Get(context.Background(), "admin_commands", "partial-linked")
		if err != nil || command["status"] != "done" {
			t.Fatalf("linked close-all did not complete after exact reconciliation: status=%v err=%v", command["status"], err)
		}
		if len(w.br.requestedCloseVolumes) != 2 || math.Abs(w.br.requestedCloseVolumes[1]-.02) > 1e-9 {
			t.Fatalf("linked continuation did not use fresh remainder: %v", w.br.requestedCloseVolumes)
		}
	})
	t.Run("orphan", func(t *testing.T) {
		w := newIntentTestWorld(t)
		w.marketPosition("unlinked-position")
		if err := w.db.Put(context.Background(), "settings", "default", store.Document{"execution": map[string]any{"mode": "paper"}, "trading": map[string]any{"kill_switch": false}}); err != nil {
			t.Fatal(err)
		}
		if err := w.db.Put(context.Background(), "admin_commands", "partial-orphan", store.Document{"type": "close_all", "confirm": closeAllConfirmation, "requested_at": store.ISO(w.now), "status": "pending"}); err != nil {
			t.Fatal(err)
		}
		w.br.partialCloseVolumes = []float64{.01}
		if err := w.runner().ProcessAdminCommands(context.Background()); err != nil {
			t.Fatal(err)
		}
		command, err := w.db.Get(context.Background(), "admin_commands", "partial-orphan")
		if err != nil || command["status"] != "done" {
			t.Fatalf("orphan partial close was not safely continued: status=%v err=%v", command["status"], err)
		}
		positions, err := w.sim.GetPositions(context.Background(), "XAUUSD")
		if err != nil || len(positions) != 0 {
			t.Fatalf("close-all finished with orphan volume still live: positions=%+v err=%v", positions, err)
		}
		if len(w.br.requestedCloseVolumes) != 2 || math.Abs(w.br.requestedCloseVolumes[1]-.02) > 1e-9 {
			t.Fatalf("orphan continuation did not use freshly observed volume: %v", w.br.requestedCloseVolumes)
		}
	})
}

func TestCloseAllOrphanDoneRetcodeWithResidualRemainsFenced(t *testing.T) {
	w := newIntentTestWorld(t)
	w.marketPosition("unlinked-position")
	if err := w.db.Put(context.Background(), "settings", "default", store.Document{"execution": map[string]any{"mode": "paper"}, "trading": map[string]any{"kill_switch": false}}); err != nil {
		t.Fatal(err)
	}
	if err := w.db.Put(context.Background(), "admin_commands", "partial-done-retcode", store.Document{"type": "close_all", "confirm": closeAllConfirmation, "requested_at": store.ISO(w.now), "status": "pending"}); err != nil {
		t.Fatal(err)
	}
	w.br.partialCloseVolumes = []float64{.01}
	w.br.closeRetcodeOverride = 10009
	if err := w.runner().ProcessAdminCommands(context.Background()); err != nil {
		t.Fatal(err)
	}
	command, err := w.db.Get(context.Background(), "admin_commands", "partial-done-retcode")
	if err != nil || command["status"] != "running" {
		t.Fatalf("orphan DONE response with residual completed close-all: status=%v err=%v", command["status"], err)
	}
	if w.br.closeCalls != 1 {
		t.Fatalf("orphan DONE response residual was resent: calls=%d", w.br.closeCalls)
	}
	positions, err := w.sim.GetPositions(context.Background(), "XAUUSD")
	if err != nil || len(positions) != 1 || positions[0].Volume != .02 {
		t.Fatalf("orphan residual was not held for operator reconciliation: positions=%+v err=%v", positions, err)
	}
}

type mismatchedPositionIdentifierBroker struct {
	broker.Broker
	ticket int64
	id     int64
}

type rotatedPositionWithFailingDealsBroker struct {
	broker.Broker
	ticket        int64
	rotatedTicket int64
	identifier    int64
	dealCalls     int
}

func (b *rotatedPositionWithFailingDealsBroker) GetPositions(ctx context.Context, symbol string) ([]broker.Position, error) {
	positions, err := b.Broker.GetPositions(ctx, symbol)
	if err != nil {
		return nil, err
	}
	for i := range positions {
		if positions[i].Ticket == b.ticket {
			positions[i].Ticket, positions[i].Identifier = b.rotatedTicket, b.identifier
		}
	}
	return positions, nil
}

func (b *rotatedPositionWithFailingDealsBroker) GetDeals(context.Context, broker.DealQuery) ([]broker.Deal, error) {
	b.dealCalls++
	return nil, errors.New("unexpected exit-deal lookup for live position identifier")
}

type hiddenPositionViewBroker struct {
	broker.Broker
	ticket int64
}

func (b *hiddenPositionViewBroker) GetPositions(ctx context.Context, symbol string) ([]broker.Position, error) {
	positions, err := b.Broker.GetPositions(ctx, symbol)
	if err != nil {
		return nil, err
	}
	visible := make([]broker.Position, 0, len(positions))
	for _, position := range positions {
		if position.Ticket != b.ticket {
			visible = append(visible, position)
		}
	}
	return visible, nil
}

func (b *mismatchedPositionIdentifierBroker) GetPositions(ctx context.Context, symbol string) ([]broker.Position, error) {
	positions, err := b.Broker.GetPositions(ctx, symbol)
	if err != nil {
		return nil, err
	}
	for i := range positions {
		if positions[i].Ticket == b.ticket {
			positions[i].Identifier = b.id
		}
	}
	return positions, nil
}

func (b *mismatchedPositionIdentifierBroker) GetDeals(ctx context.Context, query broker.DealQuery) ([]broker.Deal, error) {
	if query.PositionID != nil && *query.PositionID == b.id {
		ticket := b.ticket
		query.PositionID = &ticket
	}
	deals, err := b.Broker.GetDeals(ctx, query)
	if err != nil {
		return nil, err
	}
	for i := range deals {
		if deals[i].PositionID == b.ticket {
			deals[i].PositionID = b.id
		}
	}
	return deals, nil
}

func TestCloseReconciliationUsesPositionIdentifierDistinctFromTicket(t *testing.T) {
	w := newIntentTestWorld(t)
	position := w.marketPosition("BT-123456789abc")
	identifier := position.Ticket + 10000
	trade := w.trade(domain.TradeOpen, nil, &position)
	trade.BrokerRefs.PositionIdentifier = identifier
	trade.MutationIntent = &domain.MutationIntent{Action: "CLOSE_POSITION", Ticket: position.Ticket, At: store.ISO(w.now), ExpiresAt: w.now.Unix() + 8,
		PriorVolume: position.Volume, TargetRemainingVolume: 0, Reason: "cancel"}
	w.seedTrade(trade)
	if _, err := w.sim.ClosePosition(context.Background(), position.Ticket, nil); err != nil {
		t.Fatal(err)
	}
	adapter := &mismatchedPositionIdentifierBroker{Broker: w.br, ticket: position.Ticket, id: identifier}
	runner := NewRunner(w.db, Config{Now: func() time.Time { return w.now }, Controls: func(context.Context) (Control, error) { return Control{Mode: "paper"}, nil }, BrokerForMode: func(context.Context, string) (broker.Broker, error) { return adapter, nil }})
	if err := runner.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	doc, err := w.db.Get(context.Background(), "trade_sets", trade.TradeSetID)
	if err != nil || doc["state"] != string(domain.TradeClosed) || doc["mutation_intent"] != nil {
		t.Fatalf("exit-deal recovery assumed position ticket equals identifier: state=%v intent=%v err=%v", doc["state"], doc["mutation_intent"], err)
	}
}

func stringPointer(value string) *string { return &value }

func decodeJSON(value any, out any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

func asArray(value any) []any {
	if values, ok := value.([]any); ok {
		return values
	}
	return nil
}
