import { describe, expect, it, vi } from 'vitest';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./systemLog', () => ({ writeSystemLog: vi.fn(async () => true) }));

import {
  BrokerAmbiguousError,
  BrokerRejectedError,
  BrokerUnavailableError,
  type PlaceOrderRequest,
} from './brokerTypes.js';
import { createMt5Broker, type Mt5RequestFn } from './mt5Broker.js';
import { Mt5BridgeError, Mt5TimeoutError, Mt5UnavailableError, type Mt5Data, type Mt5RequestOptions } from './mt5Client.js';

const GMT = 1_760_000_000;
const OFFSET = 10_800; // broker server is UTC+3
const MAGIC = 98801;

const PING_DATA: Mt5Data = {
  server_time: GMT + OFFSET,
  gmt_time: GMT,
  ea_version: '2.0.0',
  magic: MAGIC,
  terminal_connected: true,
  terminal_trade_allowed: true,
  mql_trade_allowed: true,
};

type Handler = Mt5Data | Error | ((params: Record<string, unknown>, opts?: Mt5RequestOptions) => Mt5Data);

interface Call {
  action: string;
  params: Record<string, unknown>;
  opts?: Mt5RequestOptions;
}

function fakeRequest(handlers: Record<string, Handler> = {}): { request: Mt5RequestFn; calls: Call[] } {
  const calls: Call[] = [];
  const all: Record<string, Handler> = { PING: PING_DATA, ...handlers };
  const request: Mt5RequestFn = async (action, params = {}, opts) => {
    calls.push({ action, params, opts });
    const h = all[action];
    if (h === undefined) throw new Error(`no fake handler for ${action}`);
    if (h instanceof Error) throw h;
    if (typeof h === 'function') return h(params, opts);
    return h;
  };
  return { request, calls };
}

const ORDER: PlaceOrderRequest = {
  symbol: 'XAUUSD+',
  orderType: 'SELL',
  volume: 0.02,
  price: 0,
  sl: 2660,
  tp: 2640,
  deviationPoints: 20,
  comment: 'BT-0123456789ab',
};

describe('createMt5Broker: reads', () => {
  it('ping maps the EA fields', async () => {
    const { request } = fakeRequest();
    const broker = createMt5Broker({ magic: MAGIC, request });
    await expect(broker.ping()).resolves.toEqual({
      eaVersion: '2.0.0',
      terminalConnected: true,
      tradeAllowed: true,
      gmtTime: GMT,
    });
  });

  it('getAccountInfo maps snake_case to camelCase', async () => {
    const { request } = fakeRequest({
      ACCOUNT_INFO: {
        login: 5001,
        trade_mode: 'DEMO',
        margin_mode: 'HEDGING',
        currency: 'USD',
        balance: 10000,
        equity: 9950,
        margin: 120,
        margin_free: 9830,
        margin_level: 8291.67,
        leverage: 500,
        trade_allowed: true,
        trade_expert: true,
        terminal_trade_allowed: true,
        server: 'VantageInternational-Demo',
        company: 'Vantage',
      },
    });
    const broker = createMt5Broker({ magic: MAGIC, request });
    const account = await broker.getAccountInfo();
    expect(account).toEqual({
      login: 5001,
      tradeMode: 'DEMO',
      marginMode: 'HEDGING',
      currency: 'USD',
      balance: 10000,
      equity: 9950,
      margin: 120,
      marginFree: 9830,
      marginLevel: 8291.67,
      leverage: 500,
      tradeAllowed: true,
      tradeExpert: true,
      terminalTradeAllowed: true,
      server: 'VantageInternational-Demo',
      company: 'Vantage',
    });
  });

  it('getSymbolInfo maps every SYMBOL_INFO field', async () => {
    const { request, calls } = fakeRequest({
      SYMBOL_INFO: {
        symbol: 'XAUUSD+',
        digits: 2,
        point: 0.01,
        tick_size: 0.01,
        tick_value: 1,
        tick_value_profit: 1,
        tick_value_loss: 1,
        contract_size: 100,
        volume_min: 0.01,
        volume_max: 200,
        volume_step: 0.01,
        volume_limit: 0,
        stops_level: 20,
        freeze_level: 0,
        trade_mode: 'FULL',
        bid: 2650.1,
        ask: 2650.4,
        spread_points: 30,
        tick_time_msc: 1760000000123,
        currency_profit: 'USD',
        currency_margin: 'USD',
      },
    });
    const broker = createMt5Broker({ magic: MAGIC, request });
    const info = await broker.getSymbolInfo('XAUUSD+');
    expect(calls.find((c) => c.action === 'SYMBOL_INFO')?.params).toEqual({ symbol: 'XAUUSD+' });
    expect(info).toMatchObject({
      symbol: 'XAUUSD+',
      digits: 2,
      point: 0.01,
      tickSize: 0.01,
      tickValue: 1,
      contractSize: 100,
      volumeMin: 0.01,
      volumeMax: 200,
      volumeStep: 0.01,
      stopsLevelPoints: 20,
      freezeLevelPoints: 0,
      tradeMode: 'FULL',
      bid: 2650.1,
      ask: 2650.4,
      spreadPoints: 30,
      // Server time (UTC+3) converted to GMT with the PING offset.
      tickTimeMsc: 1760000000123 - OFFSET * 1000,
      currencyProfit: 'USD',
    });
  });

  it('getSymbolInfo reports tick time 0 (unknown) when the server-time offset cannot be read', async () => {
    const { request } = fakeRequest({
      PING: new Mt5UnavailableError('PING', 'down'),
      SYMBOL_INFO: { symbol: 'XAUUSD', bid: 1, ask: 1.1, tick_time_msc: 1760000000123 },
    });
    const broker = createMt5Broker({ magic: MAGIC, request });
    const info = await broker.getSymbolInfo('XAUUSD');
    expect(info.tickTimeMsc).toBe(0);
    expect(info.bid).toBe(1);
  });

  it('getPositions sends magic, filters foreign positions and converts open time to GMT', async () => {
    const { request, calls } = fakeRequest({
      GET_POSITIONS: {
        positions: [
          {
            ticket: 11,
            identifier: 11,
            symbol: 'XAUUSD+',
            type: 'BUY',
            volume: 0.01,
            open_price: 2650,
            price_current: 2651,
            sl: 2640,
            tp: 2660,
            profit: 1,
            swap: 0,
            magic: MAGIC,
            comment: 'mine',
            time_open: GMT + OFFSET - 60,
          },
          { ticket: 12, symbol: 'XAUUSD+', type: 'SELL', volume: 0.5, magic: 1, comment: 'manual', time_open: GMT },
        ],
        count: 2,
      },
    });
    const broker = createMt5Broker({ magic: MAGIC, request });
    const positions = await broker.getPositions('XAUUSD+');

    expect(calls.find((c) => c.action === 'GET_POSITIONS')?.params).toEqual({ symbol: 'XAUUSD+', magic: MAGIC });
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      ticket: 11,
      type: 'BUY',
      openPrice: 2650,
      priceCurrent: 2651,
      magic: MAGIC,
      comment: 'mine',
      timeOpen: GMT - 60,
    });
  });

  it('getPositions pings once first, then reuses the offset', async () => {
    const { request, calls } = fakeRequest({ GET_POSITIONS: { positions: [], count: 0 } });
    const broker = createMt5Broker({ magic: MAGIC, request });
    await broker.getPositions();
    await broker.getPositions();
    expect(calls.map((c) => c.action)).toEqual(['PING', 'GET_POSITIONS', 'GET_POSITIONS']);
  });

  it('getOrders keeps only pending types, filters magic and converts times', async () => {
    const { request } = fakeRequest({
      GET_ORDERS: {
        orders: [
          {
            ticket: 21,
            symbol: 'XAUUSD+',
            type: 'SELL_LIMIT',
            volume_initial: 0.02,
            volume_current: 0.02,
            price_open: 2660,
            sl: 2670,
            tp: 2640,
            magic: MAGIC,
            comment: 'pending',
            time_setup: GMT + OFFSET,
            time_expiration: GMT + OFFSET + 3600,
          },
          { ticket: 22, symbol: 'XAUUSD+', type: 'OTHER', magic: MAGIC, comment: '', time_setup: 0, time_expiration: 0 },
          { ticket: 23, symbol: 'XAUUSD+', type: 'BUY_STOP', magic: 7, comment: 'foreign' },
        ],
        count: 3,
      },
    });
    const broker = createMt5Broker({ magic: MAGIC, request });
    const orders = await broker.getOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      ticket: 21,
      type: 'SELL_LIMIT',
      volumeInitial: 0.02,
      priceOpen: 2660,
      timeSetup: GMT,
      timeExpiration: GMT + 3600,
    });
  });

  it('getOrders keeps a zero expiration as zero (GTC)', async () => {
    const { request } = fakeRequest({
      GET_ORDERS: {
        orders: [{ ticket: 5, symbol: 'X', type: 'BUY_LIMIT', magic: MAGIC, time_setup: GMT + OFFSET, time_expiration: 0 }],
        count: 1,
      },
    });
    const orders = await createMt5Broker({ magic: MAGIC, request }).getOrders();
    expect(orders[0].timeExpiration).toBe(0);
  });

  it('getDeals converts the window to server time and deal times back to GMT', async () => {
    const { request, calls } = fakeRequest({
      GET_DEALS: {
        deals: [
          {
            ticket: 31,
            order: 30,
            position_id: 30,
            symbol: 'XAUUSD+',
            type: 'BUY',
            entry: 'OUT',
            volume: 0.01,
            price: 2660,
            profit: 10,
            commission: 0,
            swap: 0,
            fee: 0,
            magic: MAGIC,
            comment: 'x',
            time: GMT + OFFSET - 30,
            reason: 'TP',
          },
          { ticket: 32, order: 0, position_id: 99, magic: MAGIC, entry: 'IN', type: 'SELL', time: GMT },
          { ticket: 33, order: 0, position_id: 30, magic: 4, entry: 'IN', type: 'SELL', time: GMT },
        ],
        count: 3,
      },
    });
    const broker = createMt5Broker({ magic: MAGIC, request });
    const deals = await broker.getDeals({ fromSec: GMT - 3600, toSec: GMT + 60, positionId: 30 });

    expect(calls.find((c) => c.action === 'GET_DEALS')?.params).toEqual({
      from: GMT - 3600 + OFFSET,
      to: GMT + 60 + OFFSET,
      position_id: 30,
      magic: MAGIC,
    });
    expect(deals).toHaveLength(1);
    expect(deals[0]).toMatchObject({ ticket: 31, positionId: 30, time: GMT - 30, reason: 'TP', entry: 'OUT' });
  });

  it('getDeals omits to/position_id when not given', async () => {
    const { request, calls } = fakeRequest({ GET_DEALS: { deals: [], count: 0 } });
    await createMt5Broker({ magic: MAGIC, request }).getDeals({ fromSec: GMT });
    expect(calls.find((c) => c.action === 'GET_DEALS')?.params).toEqual({ from: GMT + OFFSET, magic: MAGIC });
  });
});

describe('createMt5Broker: writes', () => {
  it('placeOrder sends magic, converts expiration to server time and maps the result', async () => {
    const { request, calls } = fakeRequest({
      ORDER_SEND: {
        retcode: 10008,
        order: 555,
        deal: 0,
        position: 0,
        price: 2660,
        volume: 0.02,
        duplicate: false,
        expiration_applied: true,
      },
    });
    const broker = createMt5Broker({ magic: MAGIC, request });
    const before = Math.floor(Date.now() / 1000);
    const result = await broker.placeOrder({ ...ORDER, orderType: 'SELL_LIMIT', price: 2660, expiration: GMT + 3600 });

    const send = calls.find((c) => c.action === 'ORDER_SEND');
    expect(send?.params).toMatchObject({
      symbol: 'XAUUSD+',
      order_type: 'SELL_LIMIT',
      volume: 0.02,
      price: 2660,
      sl: 2660,
      tp: 2640,
      deviation: 20,
      comment: 'BT-0123456789ab',
      magic: MAGIC,
      expiration: GMT + 3600 + OFFSET,
    });
    expect(send?.opts?.expiresAt).toBeGreaterThanOrEqual(before + 8);
    expect(send?.opts?.expiresAt).toBeLessThanOrEqual(before + 9);
    expect(result).toEqual({
      retcode: 10008,
      orderTicket: 555,
      dealTicket: 0,
      positionTicket: 0,
      price: 2660,
      volume: 0.02,
      duplicate: false,
      expirationApplied: true,
    });
  });

  it('placeOrder sends price 0 for market orders and omits expiration when not given', async () => {
    const { request, calls } = fakeRequest({
      ORDER_SEND: { retcode: 10009, order: 1, deal: 2, position: 1, price: 2650.1, volume: 0.02, duplicate: false },
    });
    const result = await createMt5Broker({ magic: MAGIC, request }).placeOrder({ ...ORDER, price: 2650 });
    const send = calls.find((c) => c.action === 'ORDER_SEND');
    expect(send?.params.price).toBe(0);
    expect(send?.params).not.toHaveProperty('expiration');
    expect(result.positionTicket).toBe(1);
    expect(result.dealTicket).toBe(2);
  });

  it('placeOrder accepts a duplicate reply (retcode 0, duplicate true)', async () => {
    const { request } = fakeRequest({
      ORDER_SEND: { retcode: 0, order: 9, deal: 8, position: 7, price: 2650, volume: 0.02, duplicate: true, duplicate_of: 'position' },
    });
    const result = await createMt5Broker({ magic: MAGIC, request }).placeOrder(ORDER);
    expect(result).toMatchObject({ retcode: 0, duplicate: true, positionTicket: 7, orderTicket: 9 });
  });

  it('placeOrder treats a non-success broker retcode as a rejection', async () => {
    const { request } = fakeRequest({
      ORDER_SEND: { retcode: 10004, order: 0, deal: 0, position: 0, price: 0, volume: 0, duplicate: false },
    });
    await expect(createMt5Broker({ magic: MAGIC, request }).placeOrder(ORDER)).rejects.toBeInstanceOf(BrokerRejectedError);
  });

  it('modifyPosition, modifyPendingOrder, closePosition and cancelOrder map their replies and use mutation expiry', async () => {
    const { request, calls } = fakeRequest({
      POSITION_MODIFY: { ticket: 1, retcode: 10009, sl: 2645, tp: 2640, unchanged: false },
      PENDING_MODIFY: { ticket: 2, retcode: 10009, price: 2655, sl: 2665, tp: 2640, unchanged: false },
      CLOSE_POSITION: {
        ticket: 1,
        retcode: 10009,
        deal: 77,
        closed_volume: 0.01,
        price: 2651,
        remaining_volume: 0.01,
      },
      CANCEL_ORDER: { ticket: 2, retcode: 10009 },
    });
    const broker = createMt5Broker({ magic: MAGIC, request });

    await expect(broker.modifyPosition(1, 2645, 2640)).resolves.toEqual({ retcode: 10009, unchanged: false });
    await expect(broker.modifyPendingOrder(2, 2655, 2665, 2640)).resolves.toEqual({ retcode: 10009 });
    await expect(broker.closePosition(1, 0.01)).resolves.toEqual({
      retcode: 10009,
      dealTicket: 77,
      closedVolume: 0.01,
      price: 2651,
      remainingVolume: 0.01,
    });
    await expect(broker.cancelOrder(2)).resolves.toEqual({ retcode: 10009 });

    expect(calls.find((c) => c.action === 'CLOSE_POSITION')?.params).toEqual({ ticket: 1, volume: 0.01 });
    for (const c of calls.filter((x) => x.action !== 'PING')) {
      expect(c.opts?.expiresAt).toBeGreaterThan(0);
    }
  });

  it('closePosition omits volume for a full close', async () => {
    const { request, calls } = fakeRequest({
      CLOSE_POSITION: { ticket: 1, retcode: 10009, deal: 1, closed_volume: 0.02, price: 2651, remaining_volume: 0 },
    });
    await createMt5Broker({ magic: MAGIC, request }).closePosition(1);
    expect(calls.find((c) => c.action === 'CLOSE_POSITION')?.params).toEqual({ ticket: 1 });
  });

  it('checkOrder returns ok for a passing check', async () => {
    const { request } = fakeRequest({
      ORDER_CHECK: { retcode: 0, margin: 104.12, margin_free: 4000, balance: 5000, equity: 5000, comment: 'Done' },
    });
    await expect(createMt5Broker({ magic: MAGIC, request }).checkOrder(ORDER)).resolves.toEqual({
      ok: true,
      retcode: 0,
      margin: 104.12,
      marginFree: 4000,
      comment: 'Done',
    });
  });

  it('checkOrder reads the check result carried by an ok:false reply', async () => {
    const { request } = fakeRequest({
      ORDER_CHECK: new Mt5BridgeError(10019, 'No money', { retcode: 10019, margin: 9999, margin_free: 1, comment: 'No money' }),
    });
    await expect(createMt5Broker({ magic: MAGIC, request }).checkOrder(ORDER)).resolves.toEqual({
      ok: false,
      retcode: 10019,
      margin: 9999,
      marginFree: 1,
      comment: 'No money',
    });
  });

  it('checkOrder rethrows a gate error that carries no check result', async () => {
    const { request } = fakeRequest({ ORDER_CHECK: new Mt5BridgeError(5002, 'trading not allowed') });
    await expect(createMt5Broker({ magic: MAGIC, request }).checkOrder(ORDER)).rejects.toBeInstanceOf(BrokerRejectedError);
  });
});

describe('createMt5Broker: local validation sends nothing', () => {
  const bad: [string, Partial<PlaceOrderRequest>][] = [
    ['zero volume', { volume: 0 }],
    ['NaN volume', { volume: Number.NaN }],
    ['NaN price on a market order', { price: Number.NaN }],
    ['pending order without price', { orderType: 'SELL_LIMIT', price: 0 }],
    ['negative sl', { sl: -1 }],
    ['comment longer than 31 chars', { comment: 'x'.repeat(32) }],
    ['unknown order type', { orderType: 'HOLD' as never }],
    ['non-finite expiration', { expiration: Number.POSITIVE_INFINITY }],
  ];

  for (const [label, patch] of bad) {
    it(`rejects ${label} with 4001 before any request`, async () => {
      const { request, calls } = fakeRequest();
      const broker = createMt5Broker({ magic: MAGIC, request });
      await expect(broker.placeOrder({ ...ORDER, ...patch })).rejects.toMatchObject({
        name: 'BrokerRejectedError',
        retcode: 4001,
      });
      await expect(broker.checkOrder({ ...ORDER, ...patch })).rejects.toBeInstanceOf(BrokerRejectedError);
      expect(calls).toHaveLength(0);
    });
  }

  it('accepts a comment of exactly 31 characters', async () => {
    const { request } = fakeRequest({
      ORDER_SEND: { retcode: 10009, order: 1, deal: 1, position: 1, price: 1, volume: 0.02, duplicate: false },
    });
    await expect(createMt5Broker({ magic: MAGIC, request }).placeOrder({ ...ORDER, comment: 'x'.repeat(31) })).resolves.toMatchObject({
      retcode: 10009,
    });
  });
});

describe('createMt5Broker: error mapping', () => {
  it('maps an EA rejection on a mutation to BrokerRejectedError with the retcode', async () => {
    const { request } = fakeRequest({ ORDER_SEND: new Mt5BridgeError(5005, 'SL inside stops level') });
    const err = await createMt5Broker({ magic: MAGIC, request })
      .placeOrder(ORDER)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerRejectedError);
    expect((err as BrokerRejectedError).retcode).toBe(5005);
    expect((err as Error).message).toContain('SL inside stops level');
  });

  it('maps a mutation timeout to BrokerAmbiguousError carrying requestId and expiresAt', async () => {
    const timeout = new Mt5TimeoutError(5000, {
      action: 'ORDER_SEND',
      requestId: 'pid-abc-1',
      expiresAt: GMT + 8,
      ambiguous: true,
    });
    const { request } = fakeRequest({ ORDER_SEND: timeout });
    const err = await createMt5Broker({ magic: MAGIC, request })
      .placeOrder(ORDER)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerAmbiguousError);
    expect(err).toMatchObject({ action: 'ORDER_SEND', requestId: 'pid-abc-1', expiresAt: GMT + 8 });
  });

  it('maps a mutation timeout on cancel/close/modify to BrokerAmbiguousError too', async () => {
    const timeout = new Mt5TimeoutError(5000, { action: 'CANCEL_ORDER', requestId: 'r', expiresAt: 1, ambiguous: true });
    const { request } = fakeRequest({
      CANCEL_ORDER: timeout,
      POSITION_MODIFY: timeout,
      CLOSE_POSITION: timeout,
      PENDING_MODIFY: timeout,
    });
    const broker = createMt5Broker({ magic: MAGIC, request });
    await expect(broker.cancelOrder(1)).rejects.toBeInstanceOf(BrokerAmbiguousError);
    await expect(broker.modifyPosition(1, 0, 0)).rejects.toBeInstanceOf(BrokerAmbiguousError);
    await expect(broker.closePosition(1)).rejects.toBeInstanceOf(BrokerAmbiguousError);
    await expect(broker.modifyPendingOrder(1, 1, 0, 0)).rejects.toBeInstanceOf(BrokerAmbiguousError);
  });

  it('maps a read timeout to BrokerUnavailableError (not ambiguous)', async () => {
    const { request } = fakeRequest({
      GET_POSITIONS: new Mt5TimeoutError(5000, { action: 'GET_POSITIONS', requestId: 'r', expiresAt: null, ambiguous: false }),
    });
    await expect(createMt5Broker({ magic: MAGIC, request }).getPositions()).rejects.toBeInstanceOf(BrokerUnavailableError);
  });

  it('maps a read EA rejection to BrokerRejectedError', async () => {
    const { request } = fakeRequest({ SYMBOL_INFO: new Mt5BridgeError(5007, 'unknown symbol: NOPE') });
    await expect(createMt5Broker({ magic: MAGIC, request }).getSymbolInfo('NOPE')).rejects.toMatchObject({
      name: 'BrokerRejectedError',
      retcode: 5007,
    });
  });

  it('maps "bridge unavailable" to BrokerUnavailableError for reads and mutations', async () => {
    const { request } = fakeRequest({
      ACCOUNT_INFO: new Mt5UnavailableError('ACCOUNT_INFO', 'connect refused'),
      CANCEL_ORDER: new Mt5UnavailableError('CANCEL_ORDER', 'connect refused'),
    });
    const broker = createMt5Broker({ magic: MAGIC, request });
    await expect(broker.getAccountInfo()).rejects.toBeInstanceOf(BrokerUnavailableError);
    await expect(broker.cancelOrder(1)).rejects.toBeInstanceOf(BrokerUnavailableError);
  });

  it('treats an unexpected error on a mutation as ambiguous and on a read as unavailable', async () => {
    const { request } = fakeRequest({
      ORDER_SEND: new Error('socket exploded'),
      ACCOUNT_INFO: new Error('socket exploded'),
    });
    const broker = createMt5Broker({ magic: MAGIC, request });
    await expect(broker.placeOrder(ORDER)).rejects.toBeInstanceOf(BrokerAmbiguousError);
    await expect(broker.getAccountInfo()).rejects.toBeInstanceOf(BrokerUnavailableError);
  });

  it('a PING failure before placeOrder is unavailable and sends no ORDER_SEND', async () => {
    const { request, calls } = fakeRequest({
      PING: new Mt5UnavailableError('PING', 'connect refused'),
    });
    await expect(createMt5Broker({ magic: MAGIC, request }).placeOrder(ORDER)).rejects.toBeInstanceOf(BrokerUnavailableError);
    expect(calls.map((c) => c.action)).toEqual(['PING']);
  });

  it('rejects an invalid magic at construction', () => {
    expect(() => createMt5Broker({ magic: 0 })).toThrow();
  });
});
