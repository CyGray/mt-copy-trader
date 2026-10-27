/**
 * mt5Broker.ts
 *
 * BrokerAdapter over the VantageBridgeEA (mt5Client, protocol v2).
 *
 * - Maps snake_case EA replies to the camelCase contract types (contracts §2).
 * - Every read is sent with `magic` and filtered again client-side.
 * - Time: EA times (deal/position/order times, `expiration`, GET_DEALS window)
 *   are broker server time. This adapter accepts and returns GMT unix seconds,
 *   using serverTime = gmtTime + offset, where offset = server_time - gmt_time
 *   from PING (refreshed every 60 s).
 * - Errors: Mt5BridgeError -> BrokerRejectedError; a timeout on a mutation ->
 *   BrokerAmbiguousError; anything else on a read, or a failure before send ->
 *   BrokerUnavailableError. A non-timeout failure on a mutation is treated as
 *   ambiguous, because the request may have been sent.
 * - Input is validated locally before anything is sent.
 */

import {
  BrokerAmbiguousError,
  BrokerRejectedError,
  BrokerUnavailableError,
  type AccountInfo,
  type AccountTradeMode,
  type BrokerAdapter,
  type BrokerDeal,
  type BrokerOrder,
  type BrokerPosition,
  type CloseResult,
  type OrderCheckResult,
  type PlaceOrderRequest,
  type PlaceOrderResult,
  type SymbolInfo,
} from './brokerTypes';
import {
  isMutatingAction,
  Mt5BridgeError,
  Mt5TimeoutError,
  Mt5UnavailableError,
  mt5Request,
  type Mt5Data,
  type Mt5RequestOptions,
} from './mt5Client';

export type Mt5RequestFn = (action: string, params?: Record<string, unknown>, opts?: Mt5RequestOptions) => Promise<Mt5Data>;

export interface CreateMt5BrokerOptions {
  magic: number;
  /** Injected transport for tests. Defaults to mt5Request. */
  request?: Mt5RequestFn;
}

const MUTATION_TTL_SEC = 8;
const OFFSET_TTL_MS = 60_000;
const MAX_COMMENT_LENGTH = 31;
const SUCCESS_RETCODES: ReadonlySet<number> = new Set([10008, 10009, 10010]);
const PENDING_TYPES: ReadonlySet<string> = new Set(['BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP']);
const ORDER_TYPES: ReadonlySet<string> = new Set(['BUY', 'SELL', ...PENDING_TYPES]);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function num(v: unknown, fallback = 0): number {
  return isFiniteNumber(v) ? v : fallback;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function bool(v: unknown): boolean {
  return v === true;
}

function rows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function invalidRequest(reason: string): never {
  throw new BrokerRejectedError(4001, `invalid order request: ${reason}`);
}

function validateOrderRequest(req: PlaceOrderRequest): void {
  if (typeof req.symbol !== 'string' || req.symbol.length === 0) invalidRequest('symbol required');
  if (!ORDER_TYPES.has(req.orderType)) invalidRequest(`unknown order type ${String(req.orderType)}`);
  if (!isFiniteNumber(req.volume) || req.volume <= 0) invalidRequest('volume must be a finite number > 0');
  if (!isFiniteNumber(req.price) || req.price < 0) invalidRequest('price must be a finite number >= 0');
  if (PENDING_TYPES.has(req.orderType) && req.price <= 0) invalidRequest('pending order needs price > 0');
  if (!isFiniteNumber(req.sl) || req.sl < 0) invalidRequest('sl must be a finite number >= 0');
  if (!isFiniteNumber(req.tp) || req.tp < 0) invalidRequest('tp must be a finite number >= 0');
  if (!isFiniteNumber(req.deviationPoints) || req.deviationPoints < 0) {
    invalidRequest('deviationPoints must be a finite number >= 0');
  }
  if (typeof req.comment !== 'string' || req.comment.length > MAX_COMMENT_LENGTH) {
    invalidRequest(`comment must be a string of at most ${MAX_COMMENT_LENGTH} characters`);
  }
  if (req.expiration !== undefined && (!isFiniteNumber(req.expiration) || req.expiration <= 0)) {
    invalidRequest('expiration must be a finite number > 0');
  }
}

function toBrokerError(err: unknown, action: string, mutating: boolean): Error {
  if (
    err instanceof BrokerRejectedError ||
    err instanceof BrokerAmbiguousError ||
    err instanceof BrokerUnavailableError
  ) {
    return err;
  }
  if (err instanceof Mt5BridgeError) return new BrokerRejectedError(err.retcode, err.message);
  if (err instanceof Mt5UnavailableError) return new BrokerUnavailableError(err.message);
  if (err instanceof Mt5TimeoutError) {
    if (mutating && err.ambiguous) {
      return new BrokerAmbiguousError(action, err.message, {
        requestId: err.requestId ?? undefined,
        expiresAt: err.expiresAt ?? undefined,
      });
    }
    return new BrokerUnavailableError(err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return mutating ? new BrokerAmbiguousError(action, message) : new BrokerUnavailableError(message);
}

export function createMt5Broker(opts: CreateMt5BrokerOptions): BrokerAdapter {
  const { magic } = opts;
  if (!Number.isInteger(magic) || magic <= 0) throw new Error(`invalid MT5 magic: ${String(magic)}`);
  const request: Mt5RequestFn = opts.request ?? ((action, params, o) => mt5Request(action, params, o));

  let offsetSec: number | null = null;
  let offsetAt = 0;

  async function call(action: string, params: Record<string, unknown> = {}, o?: Mt5RequestOptions): Promise<Mt5Data> {
    try {
      return await request(action, params, o);
    } catch (err) {
      throw toBrokerError(err, action, isMutatingAction(action));
    }
  }

  function mutationOpts(): Mt5RequestOptions {
    return { expiresAt: nowSec() + MUTATION_TTL_SEC };
  }

  function applyPing(data: Mt5Data): void {
    const server = data.server_time;
    const gmt = data.gmt_time;
    if (isFiniteNumber(server) && isFiniteNumber(gmt)) {
      offsetSec = server - gmt;
      offsetAt = Date.now();
    }
  }

  async function ensureOffset(): Promise<number> {
    if (offsetSec !== null && Date.now() - offsetAt < OFFSET_TTL_MS) return offsetSec;
    const data = await call('PING');
    applyPing(data);
    if (offsetSec === null) throw new BrokerUnavailableError('PING reply lacks server_time or gmt_time');
    return offsetSec;
  }

  function toServer(gmtSec: number, offset: number): number {
    return gmtSec + offset;
  }

  function toGmt(serverSec: number, offset: number): number {
    return serverSec ? serverSec - offset : 0;
  }

  const broker: BrokerAdapter = {
    kind: 'mt5',
    magic,

    async ping() {
      const data = await call('PING');
      applyPing(data);
      return {
        eaVersion: str(data.ea_version),
        terminalConnected: bool(data.terminal_connected),
        tradeAllowed: bool(data.terminal_trade_allowed) && bool(data.mql_trade_allowed),
        gmtTime: num(data.gmt_time),
      };
    },

    async getAccountInfo(): Promise<AccountInfo> {
      const d = await call('ACCOUNT_INFO');
      return {
        login: num(d.login),
        tradeMode: str(d.trade_mode, 'REAL') as AccountTradeMode,
        marginMode: str(d.margin_mode, 'UNKNOWN') as AccountInfo['marginMode'],
        currency: str(d.currency),
        balance: num(d.balance),
        equity: num(d.equity),
        margin: num(d.margin),
        marginFree: num(d.margin_free),
        marginLevel: num(d.margin_level),
        leverage: num(d.leverage),
        tradeAllowed: bool(d.trade_allowed),
        tradeExpert: bool(d.trade_expert),
        terminalTradeAllowed: bool(d.terminal_trade_allowed),
        server: str(d.server),
        company: str(d.company),
      };
    },

    async getSymbolInfo(symbol: string): Promise<SymbolInfo> {
      const d = await call('SYMBOL_INFO', { symbol });
      // SYMBOL_TIME_MSC is server time. Without a known offset the tick time is reported as 0 (unknown).
      const offset = offsetSec !== null && Date.now() - offsetAt < OFFSET_TTL_MS ? offsetSec : await ensureOffset().catch(() => null);
      const rawTickMsc = num(d.tick_time_msc);
      return {
        symbol: str(d.symbol, symbol),
        digits: num(d.digits),
        point: num(d.point),
        tickSize: num(d.tick_size),
        tickValue: num(d.tick_value),
        tickValueProfit: num(d.tick_value_profit),
        tickValueLoss: num(d.tick_value_loss),
        contractSize: num(d.contract_size),
        volumeMin: num(d.volume_min),
        volumeMax: num(d.volume_max),
        volumeStep: num(d.volume_step),
        volumeLimit: num(d.volume_limit),
        stopsLevelPoints: num(d.stops_level),
        freezeLevelPoints: num(d.freeze_level),
        tradeMode: str(d.trade_mode, 'DISABLED') as SymbolInfo['tradeMode'],
        bid: num(d.bid),
        ask: num(d.ask),
        spreadPoints: num(d.spread_points),
        tickTimeMsc: rawTickMsc > 0 && offset !== null ? rawTickMsc - offset * 1000 : 0,
        currencyProfit: str(d.currency_profit),
        currencyMargin: str(d.currency_margin),
      };
    },

    async getPositions(symbol?: string): Promise<BrokerPosition[]> {
      const offset = await ensureOffset();
      const d = await call('GET_POSITIONS', { ...(symbol ? { symbol } : {}), magic });
      return rows(d.positions)
        .filter((p) => num(p.magic) === magic)
        .map((p) => ({
          ticket: num(p.ticket),
          identifier: num(p.identifier),
          symbol: str(p.symbol),
          type: str(p.type) as BrokerPosition['type'],
          volume: num(p.volume),
          openPrice: num(p.open_price),
          priceCurrent: num(p.price_current),
          sl: num(p.sl),
          tp: num(p.tp),
          profit: num(p.profit),
          swap: num(p.swap),
          magic: num(p.magic),
          comment: str(p.comment),
          timeOpen: toGmt(num(p.time_open), offset),
        }));
    },

    async getOrders(symbol?: string): Promise<BrokerOrder[]> {
      const offset = await ensureOffset();
      const d = await call('GET_ORDERS', { ...(symbol ? { symbol } : {}), magic });
      return rows(d.orders)
        .filter((o) => num(o.magic) === magic && PENDING_TYPES.has(str(o.type)))
        .map((o) => ({
          ticket: num(o.ticket),
          symbol: str(o.symbol),
          type: str(o.type) as BrokerOrder['type'],
          volumeInitial: num(o.volume_initial),
          volumeCurrent: num(o.volume_current),
          priceOpen: num(o.price_open),
          sl: num(o.sl),
          tp: num(o.tp),
          magic: num(o.magic),
          comment: str(o.comment),
          timeSetup: toGmt(num(o.time_setup), offset),
          timeExpiration: toGmt(num(o.time_expiration), offset),
        }));
    },

    async getDeals(q: { fromSec: number; toSec?: number; positionId?: number }): Promise<BrokerDeal[]> {
      if (!isFiniteNumber(q.fromSec)) throw new BrokerRejectedError(4001, 'getDeals: fromSec must be a finite number');
      const offset = await ensureOffset();
      const d = await call('GET_DEALS', {
        from: toServer(q.fromSec, offset),
        ...(isFiniteNumber(q.toSec) ? { to: toServer(q.toSec, offset) } : {}),
        ...(isFiniteNumber(q.positionId) ? { position_id: q.positionId } : {}),
        magic,
      });
      return rows(d.deals)
        .filter(
          (x) =>
            num(x.magic) === magic &&
            (!isFiniteNumber(q.positionId) || num(x.position_id) === q.positionId),
        )
        .map((x) => ({
          ticket: num(x.ticket),
          order: num(x.order),
          positionId: num(x.position_id),
          symbol: str(x.symbol),
          type: str(x.type, 'OTHER') as BrokerDeal['type'],
          entry: str(x.entry, 'OUT') as BrokerDeal['entry'],
          volume: num(x.volume),
          price: num(x.price),
          profit: num(x.profit),
          commission: num(x.commission),
          swap: num(x.swap),
          fee: num(x.fee),
          magic: num(x.magic),
          comment: str(x.comment),
          time: toGmt(num(x.time), offset),
          reason: str(x.reason, 'OTHER') as BrokerDeal['reason'],
        }));
    },

    async checkOrder(req: PlaceOrderRequest): Promise<OrderCheckResult> {
      validateOrderRequest(req);
      const isMarket = !PENDING_TYPES.has(req.orderType);
      const params = {
        symbol: req.symbol,
        order_type: req.orderType,
        volume: req.volume,
        price: isMarket ? 0 : req.price,
        sl: req.sl,
        tp: req.tp,
        deviation: req.deviationPoints,
      };
      let d: Mt5Data;
      try {
        d = await request('ORDER_CHECK', params);
      } catch (err) {
        // A failed OrderCheck comes back as ok:false carrying the check result.
        if (err instanceof Mt5BridgeError && isFiniteNumber(err.data.retcode)) {
          return {
            ok: false,
            retcode: err.data.retcode,
            margin: num(err.data.margin),
            marginFree: num(err.data.margin_free),
            comment: str(err.data.comment, err.error),
          };
        }
        throw toBrokerError(err, 'ORDER_CHECK', false);
      }
      const retcode = num(d.retcode);
      return {
        ok: retcode === 0,
        retcode,
        margin: num(d.margin),
        marginFree: num(d.margin_free),
        comment: str(d.comment),
      };
    },

    async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
      validateOrderRequest(req);
      const offset = await ensureOffset();
      const isMarket = !PENDING_TYPES.has(req.orderType);
      const d = await call(
        'ORDER_SEND',
        {
          symbol: req.symbol,
          order_type: req.orderType,
          volume: req.volume,
          price: isMarket ? 0 : req.price,
          sl: req.sl,
          tp: req.tp,
          deviation: req.deviationPoints,
          comment: req.comment,
          magic,
          ...(req.expiration !== undefined ? { expiration: toServer(req.expiration, offset) } : {}),
        },
        mutationOpts(),
      );
      const retcode = num(d.retcode);
      const duplicate = bool(d.duplicate);
      if (!duplicate && !SUCCESS_RETCODES.has(retcode)) {
        throw new BrokerRejectedError(retcode, `ORDER_SEND returned unexpected retcode ${retcode}`);
      }
      return {
        retcode,
        orderTicket: num(d.order),
        dealTicket: num(d.deal),
        positionTicket: num(d.position),
        price: num(d.price),
        volume: num(d.volume),
        duplicate,
        ...(typeof d.expiration_applied === 'boolean' ? { expirationApplied: d.expiration_applied } : {}),
      };
    },

    async modifyPosition(ticket: number, sl: number, tp: number): Promise<{ retcode: number; unchanged: boolean }> {
      const d = await call('POSITION_MODIFY', { ticket, sl, tp }, mutationOpts());
      return { retcode: num(d.retcode), unchanged: bool(d.unchanged) };
    },

    async modifyPendingOrder(ticket: number, price: number, sl: number, tp: number): Promise<{ retcode: number }> {
      const d = await call('PENDING_MODIFY', { ticket, price, sl, tp }, mutationOpts());
      return { retcode: num(d.retcode) };
    },

    async closePosition(ticket: number, volume?: number): Promise<CloseResult> {
      if (volume !== undefined && (!isFiniteNumber(volume) || volume <= 0)) {
        throw new BrokerRejectedError(4001, 'closePosition: volume must be a finite number > 0 when given');
      }
      const d = await call(
        'CLOSE_POSITION',
        { ticket, ...(volume !== undefined ? { volume } : {}) },
        mutationOpts(),
      );
      return {
        retcode: num(d.retcode),
        dealTicket: num(d.deal),
        closedVolume: num(d.closed_volume),
        price: num(d.price),
        remainingVolume: num(d.remaining_volume),
      };
    },

    async cancelOrder(ticket: number): Promise<{ retcode: number }> {
      const d = await call('CANCEL_ORDER', { ticket }, mutationOpts());
      return { retcode: num(d.retcode) };
    },
  };

  return broker;
}
