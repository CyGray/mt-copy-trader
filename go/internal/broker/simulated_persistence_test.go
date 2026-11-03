package broker

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

var errSimulatedSave = errors.New("simulated persistence failure")

type simulatedTestPersistence struct {
	state    *SimState
	failNext bool
}

func (p *simulatedTestPersistence) Load(context.Context) (*SimState, error) {
	if p.state == nil {
		return nil, nil
	}
	return cloneState(*p.state), nil
}

func (p *simulatedTestPersistence) Save(_ context.Context, state SimState) error {
	if p.failNext {
		p.failNext = false
		return errSimulatedSave
	}
	p.state = cloneState(state)
	return nil
}

func TestSimulatedBrokerSaveFailureRestoresLastDurableState(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name  string
		state SimState
		act   func(context.Context, *SimulatedBroker) error
	}{
		{
			name:  "entry",
			state: simulatedPersistenceState(now),
			act: func(ctx context.Context, b *SimulatedBroker) error {
				_, err := b.PlaceOrder(ctx, PlaceOrderRequest{Symbol: "XAUUSD", OrderType: MarketBuy, Volume: .02, SL: 1990, TP: 2020, Comment: "BT-0123456789ab"})
				return err
			},
		},
		{
			name: "close",
			state: func() SimState {
				state := simulatedPersistenceState(now)
				state.Positions = []SimPosition{{Ticket: 41, Symbol: "XAUUSD", Type: Buy, Volume: .05, OpenPrice: 1990, Magic: 98801, Comment: "BT-0123456789ab", TimeOpen: now.Unix(), OpenOrderTicket: 40, OpenDealTicket: 50}}
				state.NextOrderTicket = 42
				state.NextDealTicket = 51
				return state
			}(),
			act: func(ctx context.Context, b *SimulatedBroker) error {
				_, err := b.ClosePosition(ctx, 41, nil)
				return err
			},
		},
		{
			name: "evaluate",
			state: func() SimState {
				state := simulatedPersistenceState(now)
				state.Positions = []SimPosition{{Ticket: 41, Symbol: "XAUUSD", Type: Buy, Volume: .05, OpenPrice: 1990, TP: 2001, Magic: 98801, Comment: "BT-0123456789ab", TimeOpen: now.Unix(), OpenOrderTicket: 40, OpenDealTicket: 50}}
				state.Quotes["XAUUSD"] = Quote{Bid: 2001.5, Ask: 2001.7, TimeMsc: now.UnixMilli()}
				state.NextOrderTicket = 42
				state.NextDealTicket = 51
				return state
			}(),
			act: func(ctx context.Context, b *SimulatedBroker) error {
				_, err := b.Evaluate(ctx)
				return err
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			persistence := &simulatedTestPersistence{state: cloneState(tt.state)}
			broker, err := NewSimulated(ctx, simulatedPersistenceOptions(now, persistence))
			if err != nil {
				t.Fatal(err)
			}
			before, err := broker.Snapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			persistence.failNext = true
			if err := tt.act(ctx, broker); !errors.Is(err, errSimulatedSave) {
				t.Fatalf("mutation error = %v, want persistence failure", err)
			}

			after, err := broker.Snapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(after, before) {
				t.Fatalf("in-memory simulator advanced after failed save:\nbefore: %#v\nafter:  %#v", before, after)
			}
			if !reflect.DeepEqual(persistence.state, &before) {
				t.Fatalf("durable simulator state changed after failed save:\nwant: %#v\ngot:  %#v", before, persistence.state)
			}

			restarted, err := NewSimulated(ctx, simulatedPersistenceOptions(now, persistence))
			if err != nil {
				t.Fatal(err)
			}
			restartedState, err := restarted.Snapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(restartedState, before) {
				t.Fatalf("restarted simulator differs from last durable state:\nwant: %#v\ngot:  %#v", before, restartedState)
			}
		})
	}
}

func TestSimulatedBrokerRejectsUnsupportedPersistedVersion(t *testing.T) {
	ctx := context.Background()
	state := simulatedPersistenceState(time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC))
	state.Version = 2
	state.Positions = []SimPosition{{Ticket: 41, Symbol: "XAUUSD", Type: Buy, Volume: .05, OpenPrice: 1990, Magic: 98801}}
	persistence := &simulatedTestPersistence{state: cloneState(state)}
	if _, err := NewSimulated(ctx, simulatedPersistenceOptions(time.Now(), persistence)); err == nil {
		t.Fatal("accepted unsupported persisted simulator version")
	}
	if !reflect.DeepEqual(persistence.state, &state) {
		t.Fatalf("unsupported state was changed:\nwant: %#v\ngot:  %#v", state, persistence.state)
	}
}

func simulatedPersistenceOptions(now time.Time, persistence SimPersistence) SimulatedOptions {
	return SimulatedOptions{Magic: 98801, Persistence: persistence, Now: func() time.Time { return now }, MaxQuoteAge: time.Minute}
}

func simulatedPersistenceState(now time.Time) SimState {
	return SimState{
		Version: 1, Balance: 10000,
		Specs:           map[string]SymbolInfo{"XAUUSD": {Symbol: "XAUUSD", Digits: 2, Point: .01, TickSize: .01, TickValue: 1, ContractSize: 100, VolumeMin: .01, VolumeMax: 100, VolumeStep: .01, StopsLevelPoints: 20, TradeMode: "FULL", Bid: 2000, Ask: 2000.2, TickTimeMsc: now.UnixMilli()}},
		SpecFetchedAt:   map[string]int64{"XAUUSD": now.UnixMilli()},
		Quotes:          map[string]Quote{"XAUUSD": {Bid: 2000, Ask: 2000.2, TimeMsc: now.UnixMilli()}},
		NextOrderTicket: 100001, NextDealTicket: 500001,
		Orders: []SimOrder{}, Positions: []SimPosition{}, Deals: []SimDeal{},
	}
}
