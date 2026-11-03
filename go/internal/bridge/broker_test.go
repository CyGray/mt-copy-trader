package bridge

import (
	"errors"
	"testing"
	"time"

	"github.com/bytrader/bytrader/internal/broker"
)

func TestMT5OffsetRequiresAdvancingServerClockAndValidatedTimezoneOffset(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		server float64
		gmt    float64
		source string
		want   int64
		valid  bool
	}{
		{name: "valid full-hour offset", server: 1_800_003_600, gmt: 1_800_000_000, source: "TimeTradeServer", want: 3600, valid: true},
		{name: "valid quarter-hour offset", server: 1_800_020_700, gmt: 1_800_000_000, source: "TimeTradeServer", want: 20700, valid: true},
		{name: "wrong quote-clock source", server: 1_800_003_600, gmt: 1_800_000_000, source: "TimeCurrent"},
		{name: "non-quarter-hour skew", server: 1_800_003_606, gmt: 1_800_000_000, source: "TimeTradeServer"},
		{name: "outside supported timezone range", server: 1_800_054_001, gmt: 1_800_000_000, source: "TimeTradeServer"},
		{name: "unknown GMT", server: 1_800_000_000, gmt: 0, source: "TimeTradeServer"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			adapter := &MT5Broker{now: func() time.Time { return now }}
			adapter.applyPing(map[string]any{"server_time": test.server, "gmt_time": test.gmt, "server_time_source": test.source})
			if test.valid {
				if adapter.offset != test.want || !adapter.offsetAt.Equal(now) {
					t.Fatalf("accepted offset=%d at=%v; want %d at %v", adapter.offset, adapter.offsetAt, test.want, now)
				}
				got, err := adapter.ensureOffset(t.Context())
				if err != nil || got != test.want {
					t.Fatalf("cached offset=%d err=%v; want %d", got, err, test.want)
				}
				return
			}
			if !adapter.offsetAt.IsZero() {
				t.Fatalf("invalid PING accepted offset %d", adapter.offset)
			}
		})
	}
}

func TestMT5Retcode10010IsAcceptedOnlyForEntryAndClose(t *testing.T) {
	if err := mutationRetcodeError("ORDER_SEND", 10010); err != nil {
		t.Fatalf("partial entry should be accepted and reconciled by actual fill: %v", err)
	}
	if err := closeRetcodeError(10010); err != nil {
		t.Fatalf("partial close should be accepted and reconciled by remaining volume: %v", err)
	}
	for _, action := range []string{"POSITION_MODIFY", "PENDING_MODIFY", "CANCEL_ORDER"} {
		for _, retcode := range []int{10008, 10010} {
			err := mutationRetcodeError(action, retcode)
			var ambiguous *broker.AmbiguousError
			if !errors.As(err, &ambiguous) || ambiguous.Action != action {
				t.Fatalf("%s retcode %d was treated as full success: err=%v", action, retcode, err)
			}
		}
	}
	var ambiguous *broker.AmbiguousError
	if err := closeRetcodeError(10008); !errors.As(err, &ambiguous) || ambiguous.Action != "CLOSE_POSITION" {
		t.Fatalf("PLACED close was treated as a completed close: err=%v", err)
	}
	if err := closeRetcodeError(10009); err != nil {
		t.Fatalf("DONE close rejected: %v", err)
	}
}

func TestMT5CloseRequiresImmediateOrCancelFilling(t *testing.T) {
	for _, test := range []struct {
		name string
		spec broker.SymbolInfo
		ok   bool
	}{
		{name: "fok", spec: broker.SymbolInfo{Symbol: "XAUUSD", FillingFOK: true}, ok: true},
		{name: "ioc", spec: broker.SymbolInfo{Symbol: "XAUUSD", FillingIOC: true}, ok: true},
		{name: "return-only", spec: broker.SymbolInfo{Symbol: "XAUUSD"}, ok: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := validateCloseFilling(test.spec)
			if test.ok && err != nil {
				t.Fatalf("safe fill policy rejected: %v", err)
			}
			if !test.ok {
				var rejected *broker.RejectedError
				if !errors.As(err, &rejected) {
					t.Fatalf("RETURN-only close was not blocked before handoff: err=%v", err)
				}
			}
		})
	}
}

func TestMT5MarketEntryRequiresImmediateOrCancelFilling(t *testing.T) {
	for _, test := range []struct {
		name string
		spec broker.SymbolInfo
		ok   bool
	}{
		{name: "fok", spec: broker.SymbolInfo{Symbol: "XAUUSD", FillingFOK: true}, ok: true},
		{name: "ioc", spec: broker.SymbolInfo{Symbol: "XAUUSD", FillingIOC: true}, ok: true},
		{name: "return-only", spec: broker.SymbolInfo{Symbol: "XAUUSD"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := validateMarketEntryFilling(test.spec)
			if test.ok && err != nil {
				t.Fatalf("safe market fill policy rejected: %v", err)
			}
			if !test.ok {
				var rejected *broker.RejectedError
				if !errors.As(err, &rejected) {
					t.Fatalf("RETURN-only market entry was not rejected: err=%v", err)
				}
			}
		})
	}
}
