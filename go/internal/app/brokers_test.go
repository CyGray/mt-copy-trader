package app

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/bytrader/bytrader/internal/broker"
	"github.com/bytrader/bytrader/internal/store"
)

func TestOfflineBrokerIsDurableAndCannotSelectLive(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Initialize(ctx, db, time.Now()); err != nil {
		t.Fatal(err)
	}
	factory := &BrokerFactory{DB: db, OfflineSimulator: true}
	if _, err := factory.ForMode(ctx, "live"); err == nil {
		t.Fatal("offline simulator selected live mode")
	}
	if _, err := factory.ForMode(ctx, "demo"); err == nil {
		t.Fatal("offline simulator selected demo mode")
	}
	first, err := factory.ForMode(ctx, "paper")
	if err != nil {
		t.Fatal(err)
	}
	fill, err := first.PlaceOrder(ctx, broker.PlaceOrderRequest{Symbol: "XAUUSD", OrderType: broker.MarketBuy, Volume: .02, SL: 1990, TP: 2020, Comment: "BT-0123456789ab"})
	if err != nil {
		t.Fatal(err)
	}
	secondFactory := &BrokerFactory{DB: db, OfflineSimulator: true}
	restored, err := secondFactory.ForMode(ctx, "paper")
	if err != nil {
		t.Fatal(err)
	}
	positions, err := restored.GetPositions(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(positions) != 1 || positions[0].Ticket != fill.PositionTicket {
		t.Fatalf("simulated broker state lost on restart: %v", positions)
	}
	duplicate, err := restored.PlaceOrder(ctx, broker.PlaceOrderRequest{Symbol: "XAUUSD", OrderType: broker.MarketBuy, Volume: .02, SL: 1990, TP: 2020, Comment: "BT-0123456789ab"})
	if err != nil {
		t.Fatal(err)
	}
	if !duplicate.Duplicate {
		t.Fatal("restored broker lost correlation deduplication")
	}
}
