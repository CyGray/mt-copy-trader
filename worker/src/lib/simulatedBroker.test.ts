import { describe, expect, it, vi } from 'vitest';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  BrokerAmbiguousError,
  BrokerRejectedError,
  BrokerUnavailableError,
  type PlaceOrderRequest,
  type SymbolInfo,
} from './brokerTypes.js';
import {
  createSimulatedBroker,
  type SimulatedBrokerOptions,
  type SimState,
} from './simulatedBroker.js';

const T0 = 1_760_000_000_000; // ms

const XAU: SymbolInfo = {
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
  stopsLevelPoints: 50, // 0.50 price
  freezeLevelPoints: 0,
  tradeMode: 'FULL',
  bid: 2650,
  ask: 2650.3,
  spreadPoints: 30,
  tickTimeMsc: 0,
  currencyProfit: 'USD',
  currencyMargin: 'USD',
};

function makeSim(opts: Partial<SimulatedBrokerOptions> = {}, symbol: SymbolInfo = XAU) {
  const clock = { ms: T0 };
  const sim = createSimulatedBroker({
    magic: 98801,
    symbols: { XAUUSD: symbol },
    now: () => clock.ms,
    ...opts,
  });
  return {
    sim,
    advanceSec(sec: number) {
      clock.ms += sec * 1000;
    },
  };
}

function order(patch: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest {
  return {
    symbol: 'XAUUSD',
    orderType: 'BUY',
    volume: 0.02,
    price: 0,
    sl: 2649,
    tp: 2655,
    deviationPoints: 20,
    comment: 'c-default',
    ...patch,
  };
}

async function expectRejected(p: Promise<unknown>, retcode: number): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BrokerRejectedError);
  expect((err as BrokerRejectedError).retcode).toBe(retcode);
}

function seededState(overrides: Partial<SimState> = {}): SimState {
  return {
    version: 1,
    balance: 10000,
    specs: {},
    quotes: { XAUUSD: { bid: 2650, ask: 2650.3 } },
    nextOrderTicket: 200,
    nextDealTicket: 300,
    orders: [],
    positions: [],
    deals: [],
    ...overrides,
  };
}

describe('simulatedBroker: market orders', () => {
  it('fills a BUY at Ask and values it at Bid', async () => {
    const { sim } = makeSim();
    const r = await sim.placeOrder(order());
    expect(r).toEqual({
      retcode: 10009,
      orderTicket: 100001,
      dealTicket: 500001,
      positionTicket: 100001,
      price: 2650.3,
      volume: 0.02,
      duplicate: false,
    });
    const [p] = await sim.getPositions();
    expect(p).toMatchObject({ ticket: 100001, type: 'BUY', openPrice: 2650.3, priceCurrent: 2650 });
    expect(p.identifier).toBe(p.ticket);
  });

  it('fills a SELL at Bid and values it at Ask', async () => {
    const { sim } = makeSim();
    const r = await sim.placeOrder(order({ orderType: 'SELL', sl: 2652, tp: 2645 }));
    expect(r.price).toBe(2650);
    const [p] = await sim.getPositions();
    expect(p).toMatchObject({ type: 'SELL', openPrice: 2650, priceCurrent: 2650.3 });
  });

  it('keeps order and deal ticket counters separate', async () => {
    const { sim } = makeSim();
    const a = await sim.placeOrder(order({ comment: 'a' }));
    const b = await sim.placeOrder(order({ comment: 'b' }));
    expect(b.orderTicket).toBe(a.orderTicket + 1);
    expect(b.dealTicket).toBe(a.dealTicket + 1);
    const deals = await sim.getDeals({ fromSec: T0 / 1000 - 10 });
    expect(deals.map((d) => d.entry)).toEqual(['IN', 'IN']);
    expect(deals[0]).toMatchObject({ positionId: a.positionTicket, type: 'BUY', reason: 'EXPERT', magic: 98801 });
  });

  it('reports account equity, margin and free margin', async () => {
    const { sim } = makeSim();
    await sim.placeOrder(order());
    const info = await sim.getAccountInfo();
    // BUY at 2650.30, valued at Bid 2650.00: -0.30 / 0.01 * 1 * 0.02 = -0.60
    expect(info.equity).toBeCloseTo(9999.4, 6);
    expect(info.balance).toBe(10000);
    // margin = 0.02 * 100 * 2650.30 / 100 = 53.006, rounded to 53.01
    expect(info.margin).toBeCloseTo(53.01, 6);
    expect(info.marginFree).toBeCloseTo(9999.4 - 53.01, 6);
  });

  it('getSymbolInfo reflects the current quote and spread', async () => {
    const { sim } = makeSim();
    const info = await sim.getSymbolInfo('XAUUSD');
    expect(info).toMatchObject({ bid: 2650, ask: 2650.3, spreadPoints: 30 });
    await expect(sim.getSymbolInfo('NOPE')).rejects.toMatchObject({ retcode: 5007 });
  });

  it('getSymbolInfo and placeOrder ignore inherited object keys', async () => {
    const { sim } = makeSim();
    await expectRejected(sim.getSymbolInfo('constructor'), 5007);
    await expectRejected(sim.placeOrder(order({ symbol: 'toString' })), 5007);
  });
});

describe('simulatedBroker: validation mirrors the EA', () => {
  it('rejects a BUY whose SL is on the wrong side (5005) and creates nothing', async () => {
    const { sim } = makeSim();
    await expectRejected(sim.placeOrder(order({ sl: 2650.5 })), 5005);
    expect(await sim.getPositions()).toHaveLength(0);
  });

  it('rejects a stop inside the stops level (5005)', async () => {
    const { sim } = makeSim();
    // stops level 0.50: 2649.90 is only 0.10 below Bid
    await expectRejected(sim.placeOrder(order({ sl: 2649.9 })), 5005);
  });

  it('rejects a SELL TP on the wrong side (5005)', async () => {
    const { sim } = makeSim();
    await expectRejected(sim.placeOrder(order({ orderType: 'SELL', sl: 2652, tp: 2660 })), 5005);
  });

  it('rejects a SELL SL inside the stops level (5005)', async () => {
    const { sim } = makeSim();
    await expectRejected(sim.placeOrder(order({ orderType: 'SELL', sl: 2650.5, tp: 2645 })), 5005);
  });

  it('accepts zero SL and TP (no stops)', async () => {
    const { sim } = makeSim();
    await expect(sim.placeOrder(order({ sl: 0, tp: 0 }))).resolves.toMatchObject({ retcode: 10009 });
  });

  it('rejects a volume that is not a step multiple (5004)', async () => {
    const { sim } = makeSim();
    await expectRejected(sim.placeOrder(order({ volume: 0.015 })), 5004);
  });

  it('rejects volume below min and above max (5004) and zero volume', async () => {
    const { sim } = makeSim();
    await expectRejected(sim.placeOrder(order({ volume: 0.005 })), 5004);
    await expectRejected(sim.placeOrder(order({ volume: 101 })), 5004);
    await expectRejected(sim.placeOrder(order({ volume: 0 })), 5004);
  });

  it('accepts a float-noisy step multiple (0.3 lots)', async () => {
    const { sim } = makeSim();
    await expect(sim.placeOrder(order({ volume: 0.3 }))).resolves.toMatchObject({ retcode: 10009 });
  });

  it('blocks entries when the account trade flags are off (5002), but checkOrder does not gate', async () => {
    const { sim } = makeSim({ account: { tradeAllowed: false } });
    await expectRejected(sim.placeOrder(order()), 5002);
    await expect(sim.checkOrder(order())).resolves.toMatchObject({ ok: true });
  });

  it('applies symbol trade modes (5003): LONGONLY blocks SELL, DISABLED blocks everything', async () => {
    const longOnly = makeSim({}, { ...XAU, tradeMode: 'LONGONLY' });
    await expectRejected(longOnly.sim.placeOrder(order({ orderType: 'SELL', sl: 2652, tp: 2645 })), 5003);
    await expect(longOnly.sim.placeOrder(order())).resolves.toMatchObject({ retcode: 10009 });

    const disabled = makeSim({}, { ...XAU, tradeMode: 'DISABLED' });
    await expectRejected(disabled.sim.placeOrder(order()), 5003);
  });

  it('rejects a pending BUY_LIMIT above Ask and a SELL_LIMIT below Bid (10015)', async () => {
    const { sim } = makeSim();
    await expectRejected(sim.placeOrder(order({ orderType: 'BUY_LIMIT', price: 2650.5, sl: 2649, tp: 2655 })), 10015);
    await expectRejected(sim.placeOrder(order({ orderType: 'SELL_LIMIT', price: 2649.5, sl: 2652, tp: 2645 })), 10015);
  });

  it('rejects an expiration in the past (4001)', async () => {
    const { sim } = makeSim();
    const past = Math.floor(T0 / 1000) - 10;
    await expectRejected(sim.placeOrder(order({ orderType: 'BUY_LIMIT', price: 2649.5, expiration: past })), 4001);
  });

  it('checkOrder returns ok:false with the check retcode instead of throwing', async () => {
    const { sim } = makeSim();
    const bad = await sim.checkOrder(order({ volume: 0.015 }));
    expect(bad).toMatchObject({ ok: false, retcode: 5004 });
    const good = await sim.checkOrder(order());
    expect(good).toMatchObject({ ok: true, retcode: 0, comment: 'Done' });
    expect(good.margin).toBeCloseTo(53.01, 6);
    expect(await sim.getPositions()).toHaveLength(0);
  });
});

describe('simulatedBroker: duplicate guard', () => {
  it('returns duplicate:true with the existing refs while the position is open', async () => {
    const { sim } = makeSim();
    const first = await sim.placeOrder(order({ comment: 'sig-1' }));
    const second = await sim.placeOrder(order({ comment: 'sig-1', volume: 0.05 }));
    expect(second).toMatchObject({
      retcode: 0,
      duplicate: true,
      orderTicket: first.orderTicket,
      dealTicket: first.dealTicket,
      positionTicket: first.positionTicket,
      volume: 0.02,
    });
    expect(await sim.getPositions()).toHaveLength(1);
  });

  it('detects a pending order with the same comment', async () => {
    const { sim } = makeSim();
    const pending = await sim.placeOrder(order({ orderType: 'BUY_LIMIT', price: 2649.5, comment: 'sig-p' }));
    const dup = await sim.placeOrder(order({ orderType: 'BUY_LIMIT', price: 2649.4, comment: 'sig-p' }));
    expect(dup).toMatchObject({ duplicate: true, orderTicket: pending.orderTicket, positionTicket: 0 });
    expect(await sim.getOrders()).toHaveLength(1);
  });

  it('detects a closed trade in the last 7 days, but not after that', async () => {
    const { sim, advanceSec } = makeSim();
    const first = await sim.placeOrder(order({ comment: 'sig-old' }));
    await sim.closePosition(first.positionTicket);

    const within = await sim.placeOrder(order({ comment: 'sig-old' }));
    expect(within).toMatchObject({ duplicate: true, dealTicket: expect.any(Number) });
    expect(within.dealTicket).not.toBe(0);

    advanceSec(8 * 86400);
    const after = await sim.placeOrder(order({ comment: 'sig-old' }));
    expect(after.duplicate).toBe(false);
  });

  it('does not treat an empty comment as a duplicate', async () => {
    const { sim } = makeSim();
    await sim.placeOrder(order({ comment: '' }));
    const second = await sim.placeOrder(order({ comment: '' }));
    expect(second.duplicate).toBe(false);
    expect(await sim.getPositions()).toHaveLength(2);
  });
});

describe('simulatedBroker: pending orders', () => {
  it('places, lists and fills a BUY_LIMIT on evaluate when Ask crosses the price', async () => {
    const { sim } = makeSim();
    const r = await sim.placeOrder(order({ orderType: 'BUY_LIMIT', price: 2649.5, sl: 2649, tp: 2655, comment: 'pend' }));
    expect(r).toMatchObject({ retcode: 10008, positionTicket: 0, dealTicket: 0, price: 2649.5 });

    const orders = await sim.getOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ ticket: r.orderTicket, type: 'BUY_LIMIT', priceOpen: 2649.5, volumeInitial: 0.02 });

    await sim.setQuote('XAUUSD', 2649.4, 2649.6);
    expect((await sim.evaluate()).filled).toEqual([]);

    await sim.setQuote('XAUUSD', 2649.3, 2649.5);
    const report = await sim.evaluate();
    expect(report.filled).toEqual([r.orderTicket]);
    expect(await sim.getOrders()).toHaveLength(0);
    const [p] = await sim.getPositions();
    expect(p).toMatchObject({ ticket: r.orderTicket, type: 'BUY', openPrice: 2649.5 });
  });

  it('fills a SELL_STOP when Bid falls to the price', async () => {
    const { sim } = makeSim();
    const r = await sim.placeOrder(order({ orderType: 'SELL_STOP', price: 2649.5, sl: 2651, tp: 2645 }));
    await sim.setQuote('XAUUSD', 2649.5, 2649.8);
    expect((await sim.evaluate()).filled).toEqual([r.orderTicket]);
    expect((await sim.getPositions())[0].type).toBe('SELL');
  });

  it('modifies and cancels a pending order', async () => {
    const { sim } = makeSim();
    const r = await sim.placeOrder(order({ orderType: 'BUY_LIMIT', price: 2649.5, sl: 0, tp: 0 }));
    await expect(sim.modifyPendingOrder(r.orderTicket, 2649.2, 0, 0)).resolves.toEqual({ retcode: 10009 });
    expect((await sim.getOrders())[0].priceOpen).toBe(2649.2);
    await expect(sim.modifyPendingOrder(r.orderTicket, 2649.2, 0, 0)).resolves.toEqual({ retcode: 0 });
    await expect(sim.cancelOrder(r.orderTicket)).resolves.toEqual({ retcode: 10009 });
    expect(await sim.getOrders()).toHaveLength(0);
  });

  it('expires a pending order whose expiration has passed on evaluate', async () => {
    const { sim, advanceSec } = makeSim();
    const expiration = Math.floor(T0 / 1000) + 60;
    const r = await sim.placeOrder(order({ orderType: 'BUY_LIMIT', price: 2649.5, expiration, comment: 'exp' }));
    advanceSec(61);
    const report = await sim.evaluate();
    expect(report.expired).toEqual([r.orderTicket]);
    expect(await sim.getOrders()).toHaveLength(0);
  });
});

describe('simulatedBroker: modify, close and ownership', () => {
  it('modifies SL/TP on an owned position and reports unchanged for no-op', async () => {
    const { sim } = makeSim();
    const r = await sim.placeOrder(order({ sl: 2649, tp: 2655 }));
    await expect(sim.modifyPosition(r.positionTicket, 2649.5, 2655)).resolves.toEqual({ retcode: 10009, unchanged: false });
    await expect(sim.modifyPosition(r.positionTicket, 2649.5, 2655)).resolves.toEqual({ retcode: 0, unchanged: true });
    const [p] = await sim.getPositions();
    expect(p.sl).toBe(2649.5);
  });

  it('applies the freeze level to a current SL that is too close to the market (5005)', async () => {
    const { sim } = makeSim({}, { ...XAU, freezeLevelPoints: 150 }); // 1.50 freeze
    const r = await sim.placeOrder(order({ sl: 2649, tp: 2655 }));
    // current SL 2649.00 is 1.00 from Bid 2650.00, inside the 1.50 freeze level
    await expectRejected(sim.modifyPosition(r.positionTicket, 2649.5, 2655), 5005);
  });

  it('partial close keeps remaining volume and realises profit', async () => {
    const { sim } = makeSim();
    const r = await sim.placeOrder(order({ volume: 0.1, sl: 0, tp: 0 }));
    const c = await sim.closePosition(r.positionTicket, 0.03);
    // closed at Bid 2650.00 from 2650.30: -0.30 / 0.01 * 0.03 = -0.90
    expect(c).toMatchObject({ retcode: 10009, closedVolume: 0.03, price: 2650, remainingVolume: 0.07 });
    expect((await sim.getAccountInfo()).balance).toBeCloseTo(10000 - 0.9, 6);
    const [p] = await sim.getPositions();
    expect(p.volume).toBeCloseTo(0.07, 8);
  });

  it('a full close removes the position and books an OUT deal', async () => {
    const { sim } = makeSim();
    const r = await sim.placeOrder(order({ sl: 0, tp: 0 }));
    const c = await sim.closePosition(r.positionTicket);
    expect(c).toMatchObject({ retcode: 10009, closedVolume: 0.02, remainingVolume: 0 });
    expect(await sim.getPositions()).toHaveLength(0);
    const deals = await sim.getDeals({ fromSec: T0 / 1000 - 1 });
    const out = deals.find((d) => d.entry === 'OUT');
    expect(out).toMatchObject({ type: 'SELL', reason: 'CLIENT', positionId: r.positionTicket });
    expect(out?.ticket).toBe(c.dealTicket);
  });

  it('rejects a partial close that would leave less than the minimum (5004)', async () => {
    const { sim } = makeSim({}, { ...XAU, volumeMin: 0.05 });
    const r = await sim.placeOrder(order({ volume: 0.1, sl: 0, tp: 0 }));
    await expectRejected(sim.closePosition(r.positionTicket, 0.06), 5004);
    await expect(sim.closePosition(r.positionTicket, 0.05)).resolves.toMatchObject({ remainingVolume: 0.05 });
  });

  it('rejects closing more than the position volume (5004) and unknown tickets (5008)', async () => {
    const { sim } = makeSim();
    const r = await sim.placeOrder(order({ sl: 0, tp: 0 }));
    await expectRejected(sim.closePosition(r.positionTicket, 0.5), 5004);
    await expectRejected(sim.closePosition(999999), 5008);
    await expectRejected(sim.modifyPosition(999999, 0, 0), 5008);
    await expectRejected(sim.cancelOrder(999999), 5008);
  });

  it('refuses to touch positions and orders it does not own (5006)', async () => {
    const { sim } = makeSim({
      persistence: {
        load: async () =>
          seededState({
            positions: [
              {
                ticket: 900,
                symbol: 'XAUUSD',
                type: 'BUY',
                volume: 0.01,
                openPrice: 2640,
                sl: 0,
                tp: 0,
                magic: 1,
                comment: 'foreign',
                timeOpen: T0 / 1000,
                openOrderTicket: 900,
                openDealTicket: 901,
              },
            ],
            orders: [
              {
                ticket: 150,
                symbol: 'XAUUSD',
                type: 'BUY_LIMIT',
                volume: 0.01,
                priceOpen: 2600,
                sl: 0,
                tp: 0,
                magic: 1,
                comment: '',
                timeSetup: T0 / 1000,
                timeExpiration: 0,
              },
            ],
          }),
        save: async () => undefined,
      },
    });
    await expectRejected(sim.modifyPosition(900, 2630, 0), 5006);
    await expectRejected(sim.closePosition(900), 5006);
    await expectRejected(sim.modifyPendingOrder(150, 2601, 0, 0), 5006);
    await expectRejected(sim.cancelOrder(150), 5006);
    expect(await sim.getPositions()).toHaveLength(0);
    expect(await sim.getOrders()).toHaveLength(0);
  });
});

describe('simulatedBroker: SL/TP and evaluate', () => {
  it('closes a BUY on SL at the level, books an OUT deal and updates balance', async () => {
    const { sim } = makeSim();
    await sim.placeOrder(order({ volume: 0.02, sl: 2649, tp: 2655 }));
    await sim.setQuote('XAUUSD', 2648.9, 2649.2);
    const report = await sim.evaluate();
    // (2649.00 - 2650.30) / 0.01 * 0.02 = -2.60
    expect(report.closed).toEqual([{ ticket: 100001, reason: 'SL', price: 2649, profit: -2.6 }]);
    expect((await sim.getAccountInfo()).balance).toBeCloseTo(9997.4, 6);
    expect(await sim.getPositions()).toHaveLength(0);
    const out = (await sim.getDeals({ fromSec: T0 / 1000 - 1 })).find((d) => d.entry === 'OUT');
    expect(out).toMatchObject({ reason: 'SL', price: 2649, profit: -2.6 });
  });

  it('closes a SELL on TP when Ask reaches the target', async () => {
    const { sim } = makeSim();
    await sim.placeOrder(order({ orderType: 'SELL', volume: 0.02, sl: 2652, tp: 2645 }));
    await sim.setQuote('XAUUSD', 2644.5, 2644.8);
    const report = await sim.evaluate();
    // (2650.00 - 2645.00) / 0.01 * 0.02 = 10.00
    expect(report.closed).toEqual([{ ticket: 100001, reason: 'TP', price: 2645, profit: 10 }]);
    expect((await sim.getAccountInfo()).balance).toBeCloseTo(10010, 6);
  });

  it('does not trigger while the market is inside the SL/TP band', async () => {
    const { sim } = makeSim();
    await sim.placeOrder(order({ sl: 2649, tp: 2655 }));
    await sim.setQuote('XAUUSD', 2650, 2650.3);
    expect((await sim.evaluate()).closed).toEqual([]);
    expect(await sim.getPositions()).toHaveLength(1);
  });
});

describe('simulatedBroker: injected faults', () => {
  it('failNext reject throws without performing the operation', async () => {
    const { sim } = makeSim();
    sim.failNext('placeOrder', 'reject', 10006);
    await expectRejected(sim.placeOrder(order()), 10006);
    expect(await sim.getPositions()).toHaveLength(0);
  });

  it('failNext ambiguous performs the operation, then throws BrokerAmbiguousError', async () => {
    const { sim } = makeSim();
    sim.failNext('placeOrder', 'ambiguous');
    const err = await sim.placeOrder(order({ comment: 'lost-reply' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerAmbiguousError);
    expect((err as BrokerAmbiguousError).action).toBe('placeOrder');
    expect(await sim.getPositions()).toHaveLength(1);

    // the retry is now a duplicate of the performed order
    const retry = await sim.placeOrder(order({ comment: 'lost-reply' }));
    expect(retry.duplicate).toBe(true);
  });

  it('failNext unavailable throws BrokerUnavailableError without performing', async () => {
    const { sim } = makeSim();
    sim.failNext('placeOrder', 'unavailable');
    await expect(sim.placeOrder(order())).rejects.toBeInstanceOf(BrokerUnavailableError);
    expect(await sim.getPositions()).toHaveLength(0);
  });

  it('queued faults are consumed in order, one per call', async () => {
    const { sim } = makeSim();
    sim.failNext('getPositions', 'unavailable');
    sim.failNext('getPositions', 'reject', 5002);
    await expect(sim.getPositions()).rejects.toBeInstanceOf(BrokerUnavailableError);
    await expectRejected(sim.getPositions(), 5002);
    await expect(sim.getPositions()).resolves.toEqual([]);
  });
});

describe('simulatedBroker: persistence and quotes', () => {
  it('round-trips state through persistence and reloads it lazily', async () => {
    let stored: SimState | null = null;
    const saves: SimState[] = [];
    const persistence = {
      load: async () => (stored ? (JSON.parse(JSON.stringify(stored)) as SimState) : null),
      save: async (s: SimState) => {
        saves.push(s);
        stored = JSON.parse(JSON.stringify(s)) as SimState;
      },
    };

    const first = makeSim({ persistence }).sim;
    const placed = await first.placeOrder(order({ comment: 'persist-me' }));
    expect(saves).toHaveLength(1);

    const second = makeSim({ persistence, account: { balance: 1 } }).sim;
    const positions = await second.getPositions();
    expect(positions.map((p) => p.ticket)).toEqual([placed.positionTicket]);
    expect((await second.getAccountInfo()).balance).toBe(10000);
    expect(await second.getState()).toEqual(stored);
  });

  it('refuses a persisted state with an unknown shape', async () => {
    const { sim } = makeSim({
      persistence: { load: async () => ({ version: 2 }) as unknown as SimState, save: async () => undefined },
    });
    await expect(sim.getPositions()).rejects.toBeInstanceOf(BrokerUnavailableError);
  });

  it('a failing save is logged, not thrown, and the in-memory change stands', async () => {
    const { sim } = makeSim({
      persistence: {
        load: async () => null,
        save: async () => {
          throw new Error('firestore down');
        },
      },
    });
    const r = await sim.placeOrder(order());
    expect(r.retcode).toBe(10009);
    expect(await sim.getPositions()).toHaveLength(1);
  });

  it('quoteProvider supplies the quotes used for fills and reads', async () => {
    let quote = { bid: 2650, ask: 2650.3 };
    const { sim } = makeSim({ quoteProvider: async () => quote });
    expect((await sim.getSymbolInfo('XAUUSD')).ask).toBe(2650.3);

    quote = { bid: 2700, ask: 2700.3 };
    const r = await sim.placeOrder(order({ sl: 2699, tp: 2705 }));
    expect(r.price).toBe(2700.3);
    expect((await sim.getPositions())[0].priceCurrent).toBe(2700);
  });

  it('a failing quoteProvider surfaces as BrokerUnavailableError and changes nothing', async () => {
    const { sim } = makeSim({
      quoteProvider: async () => {
        throw new Error('bridge down');
      },
    });
    await expect(sim.placeOrder(order())).rejects.toBeInstanceOf(BrokerUnavailableError);
    await expect(sim.getSymbolInfo('XAUUSD')).rejects.toBeInstanceOf(BrokerUnavailableError);
    expect((await sim.getState()).positions).toHaveLength(0);
  });

  it('getDeals filters by window, position and magic', async () => {
    const { sim } = makeSim();
    const a = await sim.placeOrder(order({ comment: 'a' }));
    await sim.placeOrder(order({ comment: 'b' }));
    expect(await sim.getDeals({ fromSec: T0 / 1000 - 1, positionId: a.positionTicket })).toHaveLength(1);
    expect(await sim.getDeals({ fromSec: T0 / 1000 + 3600 })).toHaveLength(0);
  });

  it('ping and kind identify the simulated broker', async () => {
    const { sim } = makeSim();
    expect(sim.kind).toBe('simulated');
    expect(sim.magic).toBe(98801);
    await expect(sim.ping()).resolves.toMatchObject({ eaVersion: 'simulated', terminalConnected: true, tradeAllowed: true });
  });
});

describe('simulatedBroker: lazy symbol specs', () => {
  const XAUP: SymbolInfo = { ...XAU, symbol: 'XAUUSD+', tickValue: 2, bid: 2660, ask: 2660.4 };

  function providerFor(specs: Record<string, SymbolInfo>) {
    return vi.fn(async (symbol: string) => {
      if (!Object.prototype.hasOwnProperty.call(specs, symbol)) {
        throw new BrokerRejectedError(5007, `unknown symbol: ${symbol}`);
      }
      return { ...specs[symbol] };
    });
  }

  it('trades a second symbol fetched on demand and caches its spec', async () => {
    const provider = providerFor({ 'XAUUSD+': XAUP });
    const { sim } = makeSim({ symbols: {}, symbolProvider: provider });

    const first = await sim.placeOrder(order({ symbol: 'XAUUSD+', sl: 2659, tp: 2665 }));
    expect(first.price).toBe(2660.4);
    await sim.placeOrder(order({ symbol: 'XAUUSD+', sl: 2659, tp: 2665, comment: 'second' }));
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith('XAUUSD+');

    const positions = await sim.getPositions();
    expect(positions.map((p) => p.symbol)).toEqual(['XAUUSD+', 'XAUUSD+']);
    expect(await sim.getSymbolInfo('XAUUSD+')).toMatchObject({ symbol: 'XAUUSD+', tickValue: 2, bid: 2660, ask: 2660.4 });

    // Both positions hit their SL when the second symbol's Bid drops to 2659.
    await sim.setQuote('XAUUSD+', 2658.9, 2659.2);
    const report = await sim.evaluate();
    expect(report.closed.map((c) => c.reason)).toEqual(['SL', 'SL']);
    expect((await sim.getState()).specs['XAUUSD+']).toMatchObject({ symbol: 'XAUUSD+' });
  });

  it('an unknown symbol reported by the provider is 5007 for every entry point', async () => {
    const provider = providerFor({});
    const { sim } = makeSim({ symbols: {}, symbolProvider: provider });
    await expectRejected(sim.placeOrder(order({ symbol: 'NOPE' })), 5007);
    await expectRejected(sim.checkOrder(order({ symbol: 'NOPE' })), 5007);
    await expectRejected(sim.getSymbolInfo('NOPE'), 5007);
    expect(await sim.getPositions()).toHaveLength(0);
  });

  it('without a provider, an unseeded symbol is 5007 without any fetch', async () => {
    const { sim } = makeSim({ symbols: {} });
    await expectRejected(sim.placeOrder(order({ symbol: 'XAUUSD+' })), 5007);
  });

  it('a bridge outage surfaces as BrokerUnavailableError, changes nothing, and is retried', async () => {
    let outage = true;
    const base = providerFor({ 'XAUUSD+': XAUP });
    const provider = vi.fn(async (symbol: string) => {
      if (outage) throw new Error('bridge down');
      return base(symbol);
    });
    const { sim } = makeSim({ symbols: {}, symbolProvider: provider });

    const err = await sim.placeOrder(order({ symbol: 'XAUUSD+' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerUnavailableError);
    expect(err).not.toBeInstanceOf(BrokerRejectedError);
    await expect(sim.getSymbolInfo('XAUUSD+')).rejects.toBeInstanceOf(BrokerUnavailableError);
    expect(await sim.getPositions()).toHaveLength(0);

    outage = false;
    await expect(sim.placeOrder(order({ symbol: 'XAUUSD+', sl: 2659, tp: 2665 }))).resolves.toMatchObject({
      retcode: 10009,
    });
  });

  it('a BrokerUnavailableError from the provider is also an outage, not unknown symbol', async () => {
    const provider = vi.fn(async () => {
      throw new BrokerUnavailableError('bridge down');
    });
    const { sim } = makeSim({ symbols: {}, symbolProvider: provider });
    await expect(sim.placeOrder(order({ symbol: 'XAUUSD+' }))).rejects.toBeInstanceOf(BrokerUnavailableError);
  });

  it('resolved specs persist and are not fetched again after a restart', async () => {
    const store: { state: SimState | null } = { state: null };
    const persistence = {
      load: async () => (store.state ? (JSON.parse(JSON.stringify(store.state)) as SimState) : null),
      save: async (s: SimState) => {
        store.state = JSON.parse(JSON.stringify(s)) as SimState;
      },
    };
    const provider = providerFor({ 'XAUUSD+': XAUP });

    const first = makeSim({ symbols: {}, symbolProvider: provider, persistence }).sim;
    await first.placeOrder(order({ symbol: 'XAUUSD+', sl: 2659, tp: 2665 }));
    expect(store.state?.specs['XAUUSD+']).toMatchObject({ symbol: 'XAUUSD+', tickValue: 2 });

    const second = makeSim({ symbols: {}, symbolProvider: provider, persistence }).sim;
    expect(await second.getPositions()).toHaveLength(1);
    await second.placeOrder(order({ symbol: 'XAUUSD+', sl: 2659, tp: 2665, comment: 'after-restart' }));
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('loads a state saved before specs were cached, using the seeded symbols', async () => {
    const legacy = { ...seededState() } as Partial<SimState>;
    delete legacy.specs;
    const { sim } = makeSim({
      persistence: { load: async () => legacy as SimState, save: async () => undefined },
    });
    await expect(sim.placeOrder(order())).resolves.toMatchObject({ retcode: 10009 });
  });
});
