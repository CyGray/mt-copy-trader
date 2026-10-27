import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initFirestore: vi.fn((): unknown => null),
  getMt5Config: vi.fn(async () => ({ magic: 98801, symbol: 'XAUUSD' })),
  createMt5Broker: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('./firestoreAdmin', () => ({ initFirestore: mocks.initFirestore }));
vi.mock('./mt5Secrets', () => ({ getMt5Config: mocks.getMt5Config }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() } }));
vi.mock('./mt5Broker', () => ({ createMt5Broker: mocks.createMt5Broker }));

import { BrokerRejectedError, BrokerUnavailableError, type AccountInfo, type BrokerAdapter, type SymbolInfo } from './brokerTypes.js';
import {
  _resetBrokerRouterForTests,
  getBroker,
  setBrokerForTests,
  verifyAccountForMode,
} from './brokerRouter.js';

const SPEC: SymbolInfo = {
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
  stopsLevelPoints: 50,
  freezeLevelPoints: 0,
  tradeMode: 'FULL',
  bid: 2650,
  ask: 2650.3,
  spreadPoints: 30,
  tickTimeMsc: 0,
  currencyProfit: 'USD',
  currencyMargin: 'USD',
};

function account(patch: Partial<AccountInfo> = {}): AccountInfo {
  return {
    login: 1,
    tradeMode: 'DEMO',
    marginMode: 'HEDGING',
    currency: 'USD',
    balance: 10000,
    equity: 10000,
    margin: 0,
    marginFree: 10000,
    marginLevel: 0,
    leverage: 100,
    tradeAllowed: true,
    tradeExpert: true,
    terminalTradeAllowed: true,
    server: 'srv',
    company: 'co',
    ...patch,
  };
}

function fakeBroker(result: AccountInfo | Error): BrokerAdapter & { getAccountInfo: ReturnType<typeof vi.fn> } {
  return {
    kind: 'mt5',
    magic: 98801,
    getAccountInfo: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  } as unknown as BrokerAdapter & { getAccountInfo: ReturnType<typeof vi.fn> };
}

const quote = { bid: 2650, ask: 2650.3 };
const bridge = {
  kind: 'mt5',
  magic: 98801,
  getSymbolInfo: vi.fn(async (symbol: string) => ({ ...SPEC, symbol, bid: quote.bid, ask: quote.ask })),
  getAccountInfo: vi.fn(async () => account({ tradeMode: 'DEMO' })),
};

describe('verifyAccountForMode', () => {
  beforeEach(() => {
    _resetBrokerRouterForTests();
    vi.stubEnv('BYTRADER_LIVE_TRADING', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('demo: accepts a DEMO account with trading enabled', async () => {
    const result = await verifyAccountForMode('demo', fakeBroker(account()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.account?.tradeMode).toBe('DEMO');
  });

  it('demo: rejects a REAL account', async () => {
    await expect(verifyAccountForMode('demo', fakeBroker(account({ tradeMode: 'REAL' })))).resolves.toEqual({
      ok: false,
      reason: 'account_not_demo',
    });
  });

  it('demo: rejects a CONTEST account', async () => {
    await expect(verifyAccountForMode('demo', fakeBroker(account({ tradeMode: 'CONTEST' })))).resolves.toEqual({
      ok: false,
      reason: 'account_not_demo',
    });
  });

  it.each([
    ['tradeAllowed', { tradeAllowed: false }],
    ['tradeExpert', { tradeExpert: false }],
    ['terminalTradeAllowed', { terminalTradeAllowed: false }],
  ])('demo: rejects when %s is false', async (_name, patch) => {
    await expect(verifyAccountForMode('demo', fakeBroker(account(patch)))).resolves.toEqual({
      ok: false,
      reason: 'trading_not_allowed',
    });
  });

  it('live: rejects a DEMO account', async () => {
    vi.stubEnv('BYTRADER_LIVE_TRADING', 'enabled');
    await expect(verifyAccountForMode('live', fakeBroker(account({ tradeMode: 'DEMO' })))).resolves.toEqual({
      ok: false,
      reason: 'account_not_real',
    });
  });

  it('live: a REAL account needs BYTRADER_LIVE_TRADING=enabled', async () => {
    const broker = fakeBroker(account({ tradeMode: 'REAL' }));
    await expect(verifyAccountForMode('live', broker)).resolves.toEqual({ ok: false, reason: 'live_env_not_enabled' });

    vi.stubEnv('BYTRADER_LIVE_TRADING', 'yes');
    await expect(verifyAccountForMode('live', broker)).resolves.toEqual({ ok: false, reason: 'live_env_not_enabled' });

    vi.stubEnv('BYTRADER_LIVE_TRADING', 'enabled');
    const ok = await verifyAccountForMode('live', broker);
    expect(ok.ok).toBe(true);
  });

  it('live: REAL with the env flag but trading switched off is trading_not_allowed', async () => {
    vi.stubEnv('BYTRADER_LIVE_TRADING', 'enabled');
    await expect(
      verifyAccountForMode('live', fakeBroker(account({ tradeMode: 'REAL', terminalTradeAllowed: false }))),
    ).resolves.toEqual({ ok: false, reason: 'trading_not_allowed' });
  });

  it('live: the env flag is read on every call, not cached with the account', async () => {
    const broker = fakeBroker(account({ tradeMode: 'REAL' }));
    vi.stubEnv('BYTRADER_LIVE_TRADING', 'enabled');
    expect((await verifyAccountForMode('live', broker)).ok).toBe(true);

    vi.stubEnv('BYTRADER_LIVE_TRADING', '');
    await expect(verifyAccountForMode('live', broker)).resolves.toEqual({ ok: false, reason: 'live_env_not_enabled' });
  });

  it('demo and live: an account read failure is account_unavailable', async () => {
    const broker = fakeBroker(new Error('bridge down'));
    await expect(verifyAccountForMode('demo', broker)).resolves.toEqual({ ok: false, reason: 'account_unavailable' });
    await expect(verifyAccountForMode('live', broker)).resolves.toEqual({ ok: false, reason: 'account_unavailable' });
  });

  it('caches the account read for 30 s', async () => {
    const broker = fakeBroker(account());
    const start = 1_760_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);

    await verifyAccountForMode('demo', broker);
    now.mockReturnValue(start + 29_000);
    await verifyAccountForMode('demo', broker);
    expect(broker.getAccountInfo).toHaveBeenCalledTimes(1);

    now.mockReturnValue(start + 31_000);
    await verifyAccountForMode('demo', broker);
    expect(broker.getAccountInfo).toHaveBeenCalledTimes(2);
  });

  it('paper: always ok, even when the account read fails, and never blocks on the account', async () => {
    await expect(verifyAccountForMode('paper', fakeBroker(account({ tradeMode: 'REAL' })))).resolves.toMatchObject({
      ok: true,
    });
    const failing = await verifyAccountForMode('paper', fakeBroker(new Error('down')));
    expect(failing).toEqual({ ok: true, account: null });
  });
});

describe('getBroker', () => {
  beforeEach(() => {
    _resetBrokerRouterForTests();
    vi.clearAllMocks();
    mocks.initFirestore.mockReturnValue(null);
    mocks.createMt5Broker.mockImplementation(() => bridge);
    quote.bid = 2650;
    quote.ask = 2650.3;
  });

  it('demo and live share one MT5 broker built with the configured magic', async () => {
    const demo = await getBroker('demo');
    const live = await getBroker('live');
    expect(demo).toBe(live);
    expect(mocks.createMt5Broker).toHaveBeenCalledTimes(1);
    expect(mocks.createMt5Broker).toHaveBeenCalledWith({ magic: 98801 });
  });

  it('setBrokerForTests injects a broker and null restores the default', async () => {
    const injected = fakeBroker(account());
    setBrokerForTests('demo', injected);
    await expect(getBroker('demo')).resolves.toBe(injected);

    setBrokerForTests('demo', null);
    await expect(getBroker('demo')).resolves.toBe(bridge);
  });

  it('paper is a simulated broker that reads quotes from the bridge, and is a singleton', async () => {
    const paper = await getBroker('paper');
    expect(paper.kind).toBe('simulated');
    expect(paper.magic).toBe(98801);
    expect(await getBroker('paper')).toBe(paper);
    expect(bridge.getSymbolInfo).not.toHaveBeenCalled(); // creation does not touch the bridge

    const fill = await paper.placeOrder({
      symbol: 'XAUUSD',
      orderType: 'BUY',
      volume: 0.02,
      price: 0,
      sl: 2649,
      tp: 2655,
      deviationPoints: 20,
      comment: 'paper-1',
    });
    expect(fill.price).toBe(2650.3);
    expect(bridge.getSymbolInfo).toHaveBeenCalledWith('XAUUSD');
  });

  it('paper starts with 10000 USD when no state exists, and in memory without Firestore (warned once)', async () => {
    const paper = await getBroker('paper');
    expect((await paper.getAccountInfo()).balance).toBe(10000);
    await paper.getPositions();
    await getBroker('paper');
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith('paper_broker_in_memory', expect.any(Object));
  });

  it('paper persists to paper_broker/state and resumes the stored balance', async () => {
    const stored = {
      version: 1,
      balance: 12345,
      quotes: { XAUUSD: { bid: 2650, ask: 2650.3 } },
      nextOrderTicket: 100001,
      nextDealTicket: 500001,
      orders: [],
      positions: [],
      deals: [],
    };
    const set = vi.fn(async (state: unknown) => {
      void state;
    });
    const get = vi.fn(async () => ({ exists: true, data: () => stored }));
    const doc = vi.fn(() => ({ get, set }));
    const collection = vi.fn(() => ({ doc }));
    mocks.initFirestore.mockReturnValue({ collection } as never);

    const paper = await getBroker('paper');
    expect(collection).toHaveBeenCalledWith('paper_broker');
    expect(doc).toHaveBeenCalledWith('state');
    expect((await paper.getAccountInfo()).balance).toBe(12345);

    await paper.placeOrder({
      symbol: 'XAUUSD',
      orderType: 'BUY',
      volume: 0.02,
      price: 0,
      sl: 2649,
      tp: 2655,
      deviationPoints: 20,
      comment: 'persist',
    });
    expect(set).toHaveBeenCalledTimes(1);
    const [saved] = set.mock.calls[0] as unknown as [{ positions: unknown[]; specs: Record<string, unknown> }];
    expect(saved.positions).toHaveLength(1);
    expect(saved.specs).toHaveProperty('XAUUSD');
    expect(mocks.warn).not.toHaveBeenCalledWith('paper_broker_in_memory', expect.any(Object));
  });

  it('paper creation works without the bridge; an outage surfaces on the first symbol call, then recovers', async () => {
    bridge.getSymbolInfo.mockRejectedValueOnce(new Error('bridge down'));
    const paper = await getBroker('paper');
    expect(paper.kind).toBe('simulated');
    await expect(paper.getAccountInfo()).resolves.toMatchObject({ balance: 10000 });

    const order = {
      symbol: 'XAUUSD',
      orderType: 'BUY' as const,
      volume: 0.02,
      price: 0,
      sl: 2649,
      tp: 2655,
      deviationPoints: 20,
      comment: 'outage',
    };
    await expect(paper.placeOrder(order)).rejects.toBeInstanceOf(BrokerUnavailableError);
    await expect(paper.placeOrder(order)).resolves.toMatchObject({ retcode: 10009 });
  });

  it('paper trades a second symbol fetched from the bridge on demand', async () => {
    const paper = await getBroker('paper');
    const fill = await paper.placeOrder({
      symbol: 'XAUUSD+',
      orderType: 'BUY',
      volume: 0.02,
      price: 0,
      sl: 2649,
      tp: 2655,
      deviationPoints: 20,
      comment: 'second-symbol',
    });
    expect(fill.price).toBe(2650.3);
    expect(bridge.getSymbolInfo).toHaveBeenCalledWith('XAUUSD+');
    expect((await paper.getPositions())[0].symbol).toBe('XAUUSD+');
  });

  it('a bridge answer of unknown symbol (5007) reaches the caller as BrokerRejectedError 5007', async () => {
    bridge.getSymbolInfo.mockRejectedValueOnce(new BrokerRejectedError(5007, 'unknown symbol: NOPE'));
    const paper = await getBroker('paper');
    await expect(
      paper.placeOrder({
        symbol: 'NOPE',
        orderType: 'BUY',
        volume: 0.02,
        price: 0,
        sl: 2649,
        tp: 2655,
        deviationPoints: 20,
        comment: 'unknown',
      }),
    ).rejects.toMatchObject({ name: 'BrokerRejectedError', retcode: 5007 });
  });
  it('paper mode only ever reads SYMBOL_INFO from the bridge: no order, close, modify or cancel is sent', async () => {
    const called: string[] = [];
    const recording = new Proxy(bridge, {
      get(target, prop) {
        if (typeof prop === 'string' && prop !== 'kind' && prop !== 'magic' && prop !== 'then') called.push(prop);
        if (prop in target) return Reflect.get(target, prop);
        return async () => {
          throw new Error(`paper must not call bridge.${String(prop)}`);
        };
      },
    });
    mocks.createMt5Broker.mockImplementation(() => recording);
    const paper = await getBroker('paper');
    const base = { symbol: 'XAUUSD', volume: 0.04, sl: 2645, tp: 2660, deviationPoints: 20 };
    const market = await paper.placeOrder({ ...base, orderType: 'BUY', price: 0, comment: 'p-market' });
    const pending = await paper.placeOrder({ ...base, orderType: 'BUY_LIMIT', price: 2648, comment: 'p-limit' });
    await paper.modifyPosition(market.positionTicket, 2646, 2660);
    await paper.modifyPendingOrder(pending.orderTicket, 2647, 2644, 2660);
    await paper.closePosition(market.positionTicket, 0.02);
    await paper.cancelOrder(pending.orderTicket);
    await paper.closePosition(market.positionTicket);
    await paper.getPositions();
    await paper.getOrders();
    await paper.getDeals({ fromSec: 0 });
    await paper.getAccountInfo();

    expect(new Set(called)).toEqual(new Set(['getSymbolInfo']));
  });
});
