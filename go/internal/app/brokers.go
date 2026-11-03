package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/bytrader/bytrader/internal/bridge"
	"github.com/bytrader/bytrader/internal/broker"
	"github.com/bytrader/bytrader/internal/store"
)

type BrokerFactory struct {
	DB               store.Store
	Client           *bridge.Client
	OfflineSimulator bool
	mu               sync.Mutex
	mt5              map[int64]*bridge.MT5Broker
	paper            map[int64]*broker.SimulatedBroker
}

func (f *BrokerFactory) ForMode(ctx context.Context, mode string) (broker.Broker, error) {
	if mode != "paper" && mode != "demo" && mode != "live" {
		return nil, fmt.Errorf("invalid broker mode %q", mode)
	}
	if f.OfflineSimulator && mode != "paper" {
		return nil, errors.New("offline simulator only supports paper mode")
	}
	settings, err := f.DB.Get(ctx, "settings", "default")
	if err != nil {
		return nil, err
	}
	magic := int64(98801)
	if raw, ok := object(settings["mt5"])["magic"].(float64); ok {
		if raw <= 0 || raw != float64(int64(raw)) {
			return nil, errors.New("invalid MT5 magic")
		}
		magic = int64(raw)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.mt5 == nil {
		f.mt5 = map[int64]*bridge.MT5Broker{}
		f.paper = map[int64]*broker.SimulatedBroker{}
	}
	if f.mt5[magic] == nil {
		client := f.Client
		if client == nil && !f.OfflineSimulator {
			return nil, errors.New("MT5 transport not configured")
		}
		if !f.OfflineSimulator {
			adapter, err := bridge.NewMT5Broker(bridge.MT5BrokerOptions{Magic: magic, Client: client})
			if err != nil {
				return nil, err
			}
			f.mt5[magic] = adapter
		}
	}
	if mode != "paper" {
		return f.mt5[magic], nil
	}
	if f.paper[magic] != nil {
		return f.paper[magic], nil
	}
	options := broker.SimulatedOptions{Magic: magic, Persistence: paperPersistence{f.DB}, MaxQuoteAge: time.Minute, SpecTTL: 15 * time.Minute}
	if f.OfflineSimulator {
		options.SymbolProvider = offlineGoldSpec
		options.QuoteProvider = func(ctx context.Context, symbol string) (broker.Quote, error) {
			spec, err := offlineGoldSpec(ctx, symbol)
			return broker.Quote{Bid: spec.Bid, Ask: spec.Ask, TimeMsc: spec.TickTimeMsc}, err
		}
	} else {
		adapter := f.mt5[magic]
		options.SymbolProvider = adapter.GetSymbolInfo
		options.QuoteProvider = func(ctx context.Context, symbol string) (broker.Quote, error) {
			spec, err := adapter.GetSymbolInfo(ctx, symbol)
			return broker.Quote{Bid: spec.Bid, Ask: spec.Ask, TimeMsc: spec.TickTimeMsc}, err
		}
	}
	instance, err := broker.NewSimulated(ctx, options)
	if err != nil {
		return nil, err
	}
	f.paper[magic] = instance
	return instance, nil
}

type paperPersistence struct{ db store.Store }

func (p paperPersistence) Load(ctx context.Context) (*broker.SimState, error) {
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
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

func (p paperPersistence) Save(ctx context.Context, state broker.SimState) error {
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

func offlineGoldSpec(_ context.Context, symbol string) (broker.SymbolInfo, error) {
	// shortcut: synthetic gold quotes only, add a recorded fixture for other symbols.
	if symbol != "XAUUSD" && symbol != "XAUUSD+" {
		return broker.SymbolInfo{}, &broker.RejectedError{Retcode: 5007, Message: "symbol absent from offline fixture"}
	}
	return broker.SymbolInfo{Symbol: symbol, Digits: 2, Point: .01, TickSize: .01, TickValue: 1, TickValueProfit: 1, TickValueLoss: 1, ContractSize: 100, VolumeMin: .01, VolumeMax: 100, VolumeStep: .01, StopsLevelPoints: 20, TradeMode: "FULL", Bid: 2000, Ask: 2000.2, SpreadPoints: 20, TickTimeMsc: time.Now().UnixMilli(), CurrencyProfit: "USD", CurrencyMargin: "USD"}, nil
}
