/**
 * Paper-mode hardening of the simulated broker: bounded spec caching, spec
 * changes, quote outages, bridge disconnects, closed markets (stale quotes) and
 * partial closes. Providers are fakes; nothing touches the bridge.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { BrokerRejectedError, BrokerUnavailableError, type PlaceOrderRequest, type SymbolInfo } from './brokerTypes.js';
import { logger } from './logger.js';
import { createSimulatedBroker, type SimQuote, type SimState } from './simulatedBroker.js';

const MAGIC = 98801;
const T0 = Date.parse('2026-10-19T10:00:00.000Z');
const TTL = 15 * 60_000;
const MAX_AGE = 60_000;

function spec(over: Partial<SymbolInfo> = {}): SymbolInfo {
  return {
    symbol: 'XAUUSD',
    digits: 2,
    point: 0.01,
    tickSize: 0.01,
    tickValue: 1,
    tickValueProfit: 1,
    tickValueLoss: 1,
    contractSize: 100,
    volumeMin: 0.01,
    volumeMax: 100,
    volumeStep: 0.01,
    volumeLimit: 0,
    stopsLevelPoints: 10,
    freezeLevelPoints: 0,
    tradeMode: 'FULL',
    bid: 2000,
    ask: 2000.3,
    spreadPoints: 30,
    tickTimeMsc: T0,
    currencyProfit: 'USD',
    currencyMargin: 'USD',
    ...over,
  };
}

const BUY: PlaceOrderRequest = {
  symbol: 'XAUUSD',
  orderType: 'BUY',
  volume: 0.1,
  price: 0,
  sl: 1990,
  tp: 2030,
  deviationPoints: 20,
  comment: 'BT-aaaaaaaaaaaa',
};

interface World {
  clock: { now: number };
  bridge: { spec: SymbolInfo; quote: SimQuote; specDown: boolean; quoteDown: boolean; specCalls: number; quoteCalls: number };
  store: { data: SimState | null };
}

function world(): World {
  return {
    clock: { now: T0 },
    bridge: { spec: spec(), quote: { bid: 2000, ask: 2000.3, timeMsc: T0 }, specDown: false, quoteDown: false, specCalls: 0, quoteCalls: 0 },
    store: { data: null },
  };
}

function paper(w: World) {
  return createSimulatedBroker({
    magic: MAGIC,
    symbols: {},
    now: () => w.clock.now,
    specTtlMs: TTL,
    maxQuoteAgeMs: MAX_AGE,
    symbolProvider: async () => {
      w.bridge.specCalls += 1;
      if (w.bridge.specDown) throw new BrokerUnavailableError('bridge down');
      return { ...w.bridge.spec };
    },
    quoteProvider: async () => {
      w.bridge.quoteCalls += 1;
      if (w.bridge.quoteDown) throw new BrokerUnavailableError('no quote');
      return { ...w.bridge.quote };
    },
    persistence: {
      load: async () => (w.store.data ? (JSON.parse(JSON.stringify(w.store.data)) as SimState) : null),
      save: async (s) => {
        w.store.data = JSON.parse(JSON.stringify(s)) as SimState;
      },
    },
  });
}

/** Advances the clock and keeps the bridge quote ticking. */
function advance(w: World, ms: number): void {
  w.clock.now += ms;
  w.bridge.quote = { ...w.bridge.quote, timeMsc: w.clock.now };
}

describe('paper mode: symbol spec refresh', () => {
  let w: World;
  beforeEach(() => {
    w = world();
    vi.mocked(logger.warn).mockClear();
  });

  it('fetches a spec once and reuses it within the TTL', async () => {
    const b = paper(w);
    await b.getSymbolInfo('XAUUSD');
    advance(w, TTL - 1000);
    await b.getSymbolInfo('XAUUSD');
    expect(w.bridge.specCalls).toBe(1);
  });

  it('re-fetches an expired spec, so it can never stay stale indefinitely', async () => {
    const b = paper(w);
    await b.getSymbolInfo('XAUUSD');
    advance(w, TTL + 1);
    await b.getSymbolInfo('XAUUSD');
    advance(w, TTL + 1);
    await b.getSymbolInfo('XAUUSD');
    expect(w.bridge.specCalls).toBe(3);
  });

  it('applies and logs a changed spec (volume step and stops level) to later orders', async () => {
    const b = paper(w);
    await b.placeOrder({ ...BUY, volume: 0.05 });
    w.bridge.spec = spec({ volumeStep: 0.1, volumeMin: 0.1, stopsLevelPoints: 50 });
    advance(w, TTL + 1);

    const info = await b.getSymbolInfo('XAUUSD');
    expect(info).toMatchObject({ volumeStep: 0.1, volumeMin: 0.1, stopsLevelPoints: 50 });
    expect(logger.warn).toHaveBeenCalledWith(
      'paper_spec_changed',
      expect.objectContaining({ symbol: 'XAUUSD', changed: expect.objectContaining({ volumeStep: { from: 0.01, to: 0.1 } }) }),
    );
    // 0.05 is no longer a valid step under the refreshed spec.
    await expect(b.placeOrder({ ...BUY, volume: 0.05, comment: 'BT-bbbbbbbbbbbb' })).rejects.toBeInstanceOf(BrokerRejectedError);
    await expect(b.placeOrder({ ...BUY, volume: 0.2, comment: 'BT-cccccccccccc' })).resolves.toMatchObject({ volume: 0.2 });
  });

  it('a refresh that fails is fail-closed: no new orders on an unconfirmed spec; open positions stay visible', async () => {
    const b = paper(w);
    const opened = await b.placeOrder(BUY);
    w.bridge.specDown = true;
    advance(w, TTL + 1);

    await expect(b.getSymbolInfo('XAUUSD')).rejects.toBeInstanceOf(BrokerUnavailableError);
    await expect(b.placeOrder({ ...BUY, comment: 'BT-dddddddddddd' })).rejects.toBeInstanceOf(BrokerUnavailableError);
    const positions = await b.getPositions();
    expect(positions.map((p) => p.ticket)).toEqual([opened.positionTicket]);
    expect(positions[0].profit).toBeCloseTo(-3, 6);

    // Bridge back: the spec refreshes and trading resumes.
    w.bridge.specDown = false;
    await expect(b.getSymbolInfo('XAUUSD')).resolves.toMatchObject({ symbol: 'XAUUSD' });
  });

  it('persists fetch times, and a state saved before spec refresh existed refreshes on first use', async () => {
    const b = paper(w);
    await b.getSymbolInfo('XAUUSD');
    expect(w.store.data?.spec_fetched_at?.XAUUSD).toBe(T0);

    // Simulate an older stored state without fetch times.
    const legacy = JSON.parse(JSON.stringify(w.store.data)) as SimState;
    delete legacy.spec_fetched_at;
    w.store.data = legacy;
    const restarted = paper(w);
    await restarted.getSymbolInfo('XAUUSD');
    expect(w.bridge.specCalls).toBe(2);
  });
});

describe('paper mode: quotes, disconnects and market sessions', () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  it('a quote outage fails every operation closed and fills nothing', async () => {
    const b = paper(w);
    await b.getSymbolInfo('XAUUSD');
    w.bridge.quoteDown = true;
    await expect(b.placeOrder(BUY)).rejects.toBeInstanceOf(BrokerUnavailableError);
    await expect(b.evaluate()).rejects.toBeInstanceOf(BrokerUnavailableError);
    w.bridge.quoteDown = false;
    expect(await b.getPositions()).toEqual([]);
  });

  it('a bridge disconnect before the first spec read is unavailable, then recovers', async () => {
    w.bridge.specDown = true;
    const b = paper(w);
    await expect(b.getSymbolInfo('XAUUSD')).rejects.toBeInstanceOf(BrokerUnavailableError);
    w.bridge.specDown = false;
    await expect(b.placeOrder(BUY)).resolves.toMatchObject({ retcode: 10009 });
  });

  it('a stale quote (closed market) refuses market entries, closes and stop moves with 10018', async () => {
    const b = paper(w);
    const opened = await b.placeOrder(BUY);
    // The market closes: the clock moves on, the last tick does not.
    w.clock.now += 5 * 60_000;

    const info = await b.getSymbolInfo('XAUUSD');
    expect(info.tickTimeMsc).toBe(T0);
    const refusals = [
      b.placeOrder({ ...BUY, comment: 'BT-eeeeeeeeeeee' }),
      b.closePosition(opened.positionTicket, 0.05),
      b.modifyPosition(opened.positionTicket, 1995, 2030),
      b.placeOrder({ ...BUY, orderType: 'BUY_LIMIT', price: 1990, sl: 1980, comment: 'BT-ffffffffffff' }),
    ];
    for (const r of refusals) {
      await expect(r).rejects.toMatchObject({ retcode: 10018 });
    }
    const [pos] = await b.getPositions();
    expect(pos.volume).toBe(0.1);
    expect(pos.priceCurrent).toBe(2000);
  });

  it('a pending order does not fill and SL does not trigger on a stale quote; both happen once ticks resume', async () => {
    const b = paper(w);
    const limit = await b.placeOrder({ ...BUY, orderType: 'BUY_LIMIT', price: 1995, sl: 1985, tp: 2030, comment: 'BT-111111111111' });
    const market = await b.placeOrder({ ...BUY, sl: 1999, comment: 'BT-222222222222' });

    // Last tick crosses both levels but is 2 minutes old: nothing happens.
    w.bridge.quote = { bid: 1994.5, ask: 1994.8, timeMsc: w.clock.now };
    w.clock.now += 2 * 60_000;
    const stale = await b.evaluate();
    expect(stale).toEqual({ filled: [], expired: [], closed: [] });

    // Fresh tick at the same prices: the limit fills and the SL closes.
    advance(w, 1000);
    const live = await b.evaluate();
    expect(live.filled).toEqual([limit.orderTicket]);
    expect(live.closed.map((c) => [c.ticket, c.reason])).toEqual([[market.positionTicket, 'SL']]);
  });

  it('a symbol switched to close-only at a session boundary refuses entries but allows closes', async () => {
    const b = paper(w);
    const opened = await b.placeOrder(BUY);
    w.bridge.spec = spec({ tradeMode: 'CLOSEONLY' });
    advance(w, TTL + 1);
    await expect(b.placeOrder({ ...BUY, comment: 'BT-333333333333' })).rejects.toBeInstanceOf(BrokerRejectedError);
    await expect(b.closePosition(opened.positionTicket)).resolves.toMatchObject({ closedVolume: 0.1 });
  });
});

describe('paper mode: partial closes', () => {
  it('closes partial volumes at the current bid, books the profit and keeps the remainder', async () => {
    const w = world();
    const b = paper(w);
    const opened = await b.placeOrder(BUY);
    w.bridge.quote = { bid: 2010, ask: 2010.3, timeMsc: w.clock.now };

    const first = await b.closePosition(opened.positionTicket, 0.05);
    expect(first).toMatchObject({ closedVolume: 0.05, price: 2010 });
    const second = await b.closePosition(opened.positionTicket, 0.03);
    expect(second.closedVolume).toBe(0.03);

    const [pos] = await b.getPositions();
    expect(pos.volume).toBeCloseTo(0.02, 10);
    const state = await b.getState();
    const outs = state.deals.filter((d) => d.entry === 'OUT');
    // (2010 - 2000.3) / 0.01 * 1 * volume
    expect(outs.map((d) => d.profit)).toEqual([48.5, 29.1]);
    expect(state.balance).toBeCloseTo(10000 + 48.5 + 29.1, 6);
  });

  it('refuses a partial close that would leave less than the minimum volume', async () => {
    const w = world();
    w.bridge.spec = spec({ volumeMin: 0.05, volumeStep: 0.01 });
    const b = paper(w);
    const opened = await b.placeOrder(BUY);
    await expect(b.closePosition(opened.positionTicket, 0.07)).rejects.toMatchObject({ retcode: 5004 });
    await expect(b.closePosition(opened.positionTicket, 0.05)).resolves.toMatchObject({ closedVolume: 0.05 });
  });
});
