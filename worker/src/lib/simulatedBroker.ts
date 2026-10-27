/**
 * simulatedBroker.ts
 *
 * Deterministic in-memory broker for paper mode and tests. It implements
 * BrokerAdapter and runs the same pre-checks as VantageBridgeEA, in the same
 * order (mql5/PROTOCOL.md): field validation, trading gate, symbol, duplicate
 * comment guard, trade mode, volume, stops, freeze level.
 *
 * Pricing follows MT5: market orders fill at Ask (BUY) or Bid (SELL). A
 * position is valued at Bid (BUY) or Ask (SELL), like POSITION_PRICE_CURRENT.
 * Profit is (price difference / tickSize) * tickValue * volume. Commission and
 * swap are 0. Position tickets equal their opening order ticket.
 *
 * Symbol specs are resolved lazily. `opts.symbols` seeds the cache. An unknown
 * symbol is fetched through `opts.symbolProvider` and cached in the persisted
 * state with its fetch time. With `specTtlMs`, a cached spec older than the TTL
 * is fetched again before use (changed fields are logged as
 * `paper_spec_changed`); if that refresh fails the call fails closed
 * (BrokerUnavailableError), so a spec is never used indefinitely. Without a
 * provider, or when the provider reports 5007, the symbol is unknown.
 *
 * Quotes: with `maxQuoteAgeMs`, a quote whose tick time is older than that is
 * treated like a closed market: entries, closes and modifications are refused
 * with 10018, pending orders do not fill and SL/TP do not trigger. Positions
 * keep their last valuation.
 *
 * Simplifications: pending orders fill at their order price, and SL/TP close at
 * the level, not at a gapped market price. Times are GMT unix seconds with no
 * server offset.
 *
 * Extras beyond BrokerAdapter: setQuote, evaluate (fills, expiries, SL/TP),
 * failNext (injected faults), getState/snapshot. In paper mode quoteProvider
 * supplies live quotes before every operation.
 */

import {
  BrokerAmbiguousError,
  BrokerRejectedError,
  BrokerUnavailableError,
  type AccountInfo,
  type BrokerAdapter,
  type BrokerDeal,
  type BrokerOrder,
  type BrokerOrderType,
  type BrokerPosition,
  type CloseResult,
  type OrderCheckResult,
  type OrderSide,
  type PlaceOrderRequest,
  type PlaceOrderResult,
  type SymbolInfo,
} from './brokerTypes';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimQuote {
  bid: number;
  ask: number;
  /** Tick time, GMT epoch ms. Absent for quotes set by tests (always fresh). */
  timeMsc?: number;
}

export type SimPendingType = Exclude<BrokerOrderType, 'BUY' | 'SELL'>;

export interface SimPosition {
  ticket: number;
  symbol: string;
  type: OrderSide;
  volume: number;
  openPrice: number;
  sl: number;
  tp: number;
  magic: number;
  comment: string;
  timeOpen: number;
  openOrderTicket: number;
  openDealTicket: number;
}

export interface SimOrder {
  ticket: number;
  symbol: string;
  type: SimPendingType;
  volume: number;
  priceOpen: number;
  sl: number;
  tp: number;
  magic: number;
  comment: string;
  timeSetup: number;
  /** 0 = good till cancel */
  timeExpiration: number;
}

export interface SimDeal {
  ticket: number;
  order: number;
  positionId: number;
  symbol: string;
  type: 'BUY' | 'SELL';
  entry: 'IN' | 'OUT';
  volume: number;
  price: number;
  profit: number;
  magic: number;
  comment: string;
  time: number;
  reason: 'EXPERT' | 'CLIENT' | 'SL' | 'TP';
}

export interface SimState {
  version: 1;
  balance: number;
  /** Cached symbol specs, keyed by the requested symbol name. */
  specs: Record<string, SymbolInfo>;
  /** When each cached spec was fetched (epoch ms). Seeded specs count as fetched at load. */
  spec_fetched_at?: Record<string, number>;
  quotes: Record<string, SimQuote>;
  nextOrderTicket: number;
  nextDealTicket: number;
  orders: SimOrder[];
  positions: SimPosition[];
  deals: SimDeal[];
}

export type SimMethod =
  | 'ping'
  | 'getAccountInfo'
  | 'getSymbolInfo'
  | 'getPositions'
  | 'getOrders'
  | 'getDeals'
  | 'checkOrder'
  | 'placeOrder'
  | 'modifyPosition'
  | 'modifyPendingOrder'
  | 'closePosition'
  | 'cancelOrder';

export type SimFailureKind = 'reject' | 'ambiguous' | 'unavailable';

export interface SimulatedBrokerOptions {
  magic: number;
  account?: Partial<AccountInfo>;
  /** Seed specs. Entries here override cached specs on load. */
  symbols: Record<string, SymbolInfo>;
  /** Fetches a spec for a symbol not in the cache. Rejects 5007 when unknown. */
  symbolProvider?: (symbol: string) => Promise<SymbolInfo>;
  quoteProvider?: (symbol: string) => Promise<SimQuote>;
  persistence?: {
    load(): Promise<SimState | null>;
    save(state: SimState): Promise<void>;
  };
  /** Epoch milliseconds. Defaults to Date.now. */
  now?: () => number;
  /** Re-fetch a cached spec through symbolProvider once it is older than this. Unset: never. */
  specTtlMs?: number;
  /** A quote older than this (by its timeMsc) counts as a closed market. Unset: never stale. */
  maxQuoteAgeMs?: number;
  /** Whether pending expirations are honoured (ORDER_TIME_SPECIFIED). Default true. */
  supportsExpiration?: boolean;
  /** Comment the broker stores instead of the requested one (simulates a broker that rewrites comments). */
  rewriteComment?: (comment: string) => string;
}

export interface EvaluateReport {
  filled: number[];
  expired: number[];
  closed: { ticket: number; reason: 'SL' | 'TP'; price: number; profit: number }[];
}

export interface SimulatedBroker extends BrokerAdapter {
  /** Sets a quote; `timeMsc` (GMT ms) makes it subject to maxQuoteAgeMs. */
  setQuote(symbol: string, bid: number, ask: number, timeMsc?: number): Promise<void>;
  evaluate(): Promise<EvaluateReport>;
  failNext(method: SimMethod, kind: SimFailureKind, retcode?: number): void;
  getState(): Promise<SimState>;
  snapshot(): Promise<SimState>;
}

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const VOLUME_EPS = 1e-9;
const PRICE_EPS = 1e-9;
const DUP_LOOKBACK_SEC = 7 * 86400;
const DEAL_RETENTION_SEC = 30 * 86400;
/** Spec fields compared on refresh (quotes and tick time excluded). */
const SPEC_FIELDS = [
  'digits',
  'point',
  'tickSize',
  'tickValue',
  'tickValueProfit',
  'tickValueLoss',
  'contractSize',
  'volumeMin',
  'volumeMax',
  'volumeStep',
  'volumeLimit',
  'stopsLevelPoints',
  'freezeLevelPoints',
  'tradeMode',
  'currencyProfit',
  'currencyMargin',
] as const;

const RETCODE_DONE = 10009;
const RETCODE_PLACED = 10008;
const RETCODE_REJECTED = 10006;
const RETCODE_INVALID_PRICE = 10015;
const RETCODE_NO_QUOTE = 10018;
const DEFAULT_BALANCE = 10000;
const DEFAULT_LEVERAGE = 100;
const ORDER_TICKET_START = 100001;
const DEAL_TICKET_START = 500001;
const ORDER_TYPES: ReadonlySet<string> = new Set(['BUY', 'SELL', 'BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP']);
const PENDING_TYPES: ReadonlySet<string> = new Set(['BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP']);

const DEFAULT_ACCOUNT: AccountInfo = {
  login: 0,
  tradeMode: 'DEMO',
  marginMode: 'HEDGING',
  currency: 'USD',
  balance: DEFAULT_BALANCE,
  equity: DEFAULT_BALANCE,
  margin: 0,
  marginFree: DEFAULT_BALANCE,
  marginLevel: 0,
  leverage: DEFAULT_LEVERAGE,
  tradeAllowed: true,
  tradeExpert: true,
  terminalTradeAllowed: true,
  server: 'SIMULATED',
  company: 'ByTrader simulated broker',
};

function isBuy(type: string): boolean {
  return type === 'BUY' || type === 'BUY_LIMIT' || type === 'BUY_STOP';
}

function roundTo(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function reject(retcode: number, message: string): BrokerRejectedError {
  return new BrokerRejectedError(retcode, message);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function byTicket<T extends { ticket: number }>(a: T, b: T): number {
  return a.ticket - b.ticket;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Bid for BUY, Ask for SELL: the price a position closes at, and the stop reference. */
function stopRefFor(q: SimQuote, buy: boolean): number {
  return buy ? q.bid : q.ask;
}

/** Ask for BUY, Bid for SELL: the market fill price. */
function fillPriceFor(q: SimQuote, buy: boolean): number {
  return buy ? q.ask : q.bid;
}

function pnl(sp: SymbolInfo, side: OrderSide, openPrice: number, closePrice: number, volume: number): number {
  if (sp.tickSize <= 0) return 0;
  const diff = side === 'BUY' ? closePrice - openPrice : openPrice - closePrice;
  return roundTo((diff / sp.tickSize) * sp.tickValue * volume, 2);
}

function checkMode(sp: SymbolInfo, isEntry: boolean, buySide: boolean): void {
  const m = sp.tradeMode;
  const blocked =
    m === 'DISABLED' ||
    (isEntry && (m === 'CLOSEONLY' || (m === 'LONGONLY' && !buySide) || (m === 'SHORTONLY' && buySide)));
  if (blocked) throw reject(5003, `symbol ${sp.symbol} trade mode ${m} forbids this operation`);
}

function checkVolume(sp: SymbolInfo, vol: number): void {
  if (vol <= 0) throw reject(5004, 'volume must be > 0');
  if (sp.volumeMin > 0 && vol < sp.volumeMin - VOLUME_EPS) {
    throw reject(5004, `volume ${vol} below min ${sp.volumeMin}`);
  }
  if (sp.volumeMax > 0 && vol > sp.volumeMax + VOLUME_EPS) {
    throw reject(5004, `volume ${vol} above max ${sp.volumeMax}`);
  }
  if (sp.volumeStep > 0) {
    const q = vol / sp.volumeStep;
    if (Math.abs(q - Math.round(q)) >= 1e-6) {
      throw reject(5004, `volume ${vol} is not a multiple of step ${sp.volumeStep}`);
    }
  }
}

function checkStops(
  sp: SymbolInfo,
  buySide: boolean,
  ref: number,
  sl: number,
  tp: number,
  checkSl: boolean,
  checkTp: boolean,
): void {
  const minDist = sp.stopsLevelPoints * sp.point;
  if (checkSl && sl > 0) {
    if (!(buySide ? sl < ref : sl > ref)) throw reject(5005, `SL ${sl} on wrong side of reference ${ref}`);
    if (Math.abs(ref - sl) < minDist - PRICE_EPS) throw reject(5005, `SL inside stops level (${minDist})`);
  }
  if (checkTp && tp > 0) {
    if (!(buySide ? tp > ref : tp < ref)) throw reject(5005, `TP ${tp} on wrong side of reference ${ref}`);
    if (Math.abs(ref - tp) < minDist - PRICE_EPS) throw reject(5005, `TP inside stops level (${minDist})`);
  }
}

function checkFreeze(sp: SymbolInfo, market: number, currentLevel: number): void {
  if (currentLevel <= 0) return;
  const minDist = sp.freezeLevelPoints * sp.point;
  if (minDist > 0 && Math.abs(market - currentLevel) < minDist - PRICE_EPS) {
    throw reject(5005, `modification denied: ${currentLevel} is inside freeze level (${minDist})`);
  }
}

function checkPendingPrice(type: string, price: number, q: SimQuote): void {
  const invalid =
    type === 'BUY_LIMIT'
      ? price >= q.ask
      : type === 'SELL_LIMIT'
        ? price <= q.bid
        : type === 'BUY_STOP'
          ? price <= q.ask
          : price >= q.bid;
  if (invalid) throw reject(RETCODE_INVALID_PRICE, `invalid price ${price} for ${type}`);
}

function validateFields(req: PlaceOrderRequest, nowSecs: number): void {
  if (!ORDER_TYPES.has(req.orderType)) throw reject(4001, `unknown order_type: ${String(req.orderType)}`);
  if (!Number.isFinite(req.volume)) throw reject(4001, 'volume required');
  const pending = PENDING_TYPES.has(req.orderType);
  if (pending && !(req.price > 0)) throw reject(4001, `price required for ${req.orderType}`);
  const exp = req.expiration ?? 0;
  if (exp < 0) throw reject(4001, 'expiration must be >= 0');
  if (pending && exp > 0 && exp <= nowSecs) throw reject(4001, 'expiration is not in the future');
}

function shouldFill(o: SimOrder, q: SimQuote): boolean {
  switch (o.type) {
    case 'BUY_LIMIT':
      return q.ask <= o.priceOpen;
    case 'SELL_LIMIT':
      return q.bid >= o.priceOpen;
    case 'BUY_STOP':
      return q.ask >= o.priceOpen;
    case 'SELL_STOP':
      return q.bid <= o.priceOpen;
  }
}

function triggerFor(p: SimPosition, q: SimQuote): { reason: 'SL' | 'TP'; level: number } | null {
  if (p.type === 'BUY') {
    if (p.sl > 0 && q.bid <= p.sl) return { reason: 'SL', level: p.sl };
    if (p.tp > 0 && q.bid >= p.tp) return { reason: 'TP', level: p.tp };
  } else {
    if (p.sl > 0 && q.ask >= p.sl) return { reason: 'SL', level: p.sl };
    if (p.tp > 0 && q.ask <= p.tp) return { reason: 'TP', level: p.tp };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSimulatedBroker(opts: SimulatedBrokerOptions): SimulatedBroker {
  const magic = opts.magic;
  const seedSpecs = opts.symbols;
  const persistence = opts.persistence;
  const quoteProvider = opts.quoteProvider;
  const symbolProvider = opts.symbolProvider;
  const now = opts.now ?? (() => Date.now());
  const specTtlMs = opts.specTtlMs !== undefined && opts.specTtlMs > 0 ? opts.specTtlMs : null;
  const maxQuoteAgeMs = opts.maxQuoteAgeMs !== undefined && opts.maxQuoteAgeMs > 0 ? opts.maxQuoteAgeMs : null;
  const supportsExpiration = opts.supportsExpiration ?? true;
  const storedComment = opts.rewriteComment ?? ((c: string) => c);
  const account: AccountInfo = {
    ...DEFAULT_ACCOUNT,
    ...opts.account,
    balance: opts.account?.balance ?? DEFAULT_BALANCE,
  };

  let state: SimState | null = null;
  let dirty = false;
  let chain: Promise<unknown> = Promise.resolve();
  const faults: Partial<Record<SimMethod, { kind: SimFailureKind; retcode?: number }[]>> = {};

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function nowSec(): number {
    return Math.floor(now() / 1000);
  }

  function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
  }

  function freshState(): SimState {
    const specs: Record<string, SymbolInfo> = { ...seedSpecs };
    const quotes: Record<string, SimQuote> = {};
    for (const [sym, sp] of Object.entries(specs)) quotes[sym] = { bid: sp.bid, ask: sp.ask };
    return {
      version: 1,
      balance: account.balance,
      specs,
      spec_fetched_at: Object.fromEntries(Object.keys(specs).map((sym) => [sym, now()])),
      quotes,
      nextOrderTicket: ORDER_TICKET_START,
      nextDealTicket: DEAL_TICKET_START,
      orders: [],
      positions: [],
      deals: [],
    };
  }

  async function ensureLoaded(): Promise<SimState> {
    if (state) return state;
    let loaded: SimState | null = null;
    if (persistence) {
      try {
        loaded = await persistence.load();
      } catch (err) {
        throw new BrokerUnavailableError(`simulated broker state load failed: ${errorMessage(err)}`);
      }
      if (loaded && (loaded.version !== 1 || !Array.isArray(loaded.positions) || !Array.isArray(loaded.orders))) {
        throw new BrokerUnavailableError('simulated broker state has an unrecognised shape');
      }
    }
    if (loaded) {
      // States saved before lazy symbol resolution have no specs cache.
      const cached = (loaded as Partial<SimState>).specs ?? {};
      const fetchedAt: Record<string, number> = { ...((loaded as Partial<SimState>).spec_fetched_at ?? {}) };
      // A spec without a fetch time (state saved before spec refresh existed) is due for refresh.
      for (const sym of Object.keys(cached)) if (typeof fetchedAt[sym] !== 'number') fetchedAt[sym] = 0;
      for (const sym of Object.keys(seedSpecs)) fetchedAt[sym] = now();
      state = { ...loaded, specs: { ...cached, ...seedSpecs }, spec_fetched_at: fetchedAt };
    } else {
      state = freshState();
    }
    return state;
  }

  async function persist(): Promise<void> {
    dirty = false;
    if (!persistence || !state) return;
    try {
      await persistence.save(clone(state));
    } catch (err) {
      logger.warn('simulated_broker_save_failed', { error: errorMessage(err) });
    }
  }

  async function refreshQuotes(s: SimState): Promise<void> {
    if (!quoteProvider) return;
    for (const sym of Object.keys(s.specs)) {
      try {
        const q = await quoteProvider(sym);
        s.quotes[sym] = { bid: q.bid, ask: q.ask, ...(q.timeMsc !== undefined ? { timeMsc: q.timeMsc } : {}) };
      } catch (err) {
        throw new BrokerUnavailableError(`quote unavailable for ${sym}: ${errorMessage(err)}`);
      }
    }
  }

  /** Returns the cached spec, fetching it on first use and again once older than specTtlMs. */
  async function resolveSpec(s: SimState, symbol: string): Promise<SymbolInfo> {
    const cached = hasOwn(s.specs, symbol) ? s.specs[symbol] : undefined;
    const fetchedAt = s.spec_fetched_at?.[symbol] ?? 0;
    const fresh = cached !== undefined && (specTtlMs === null || !symbolProvider || now() - fetchedAt < specTtlMs);
    if (cached && fresh) return cached;
    if (!symbolProvider) throw reject(5007, `unknown symbol: ${symbol}`);
    let sp: SymbolInfo;
    try {
      sp = await symbolProvider(symbol);
    } catch (err) {
      if (err instanceof BrokerRejectedError && err.retcode === 5007) {
        throw reject(5007, `unknown symbol: ${symbol}`);
      }
      // Fail closed: an expired spec is not used when it cannot be confirmed.
      throw new BrokerUnavailableError(
        `symbol ${symbol} ${cached ? 'spec refresh' : 'spec'} unavailable: ${errorMessage(err)}`,
      );
    }
    if (cached) {
      const changed = SPEC_FIELDS.filter((k) => cached[k] !== sp[k]);
      if (changed.length > 0) {
        logger.warn('paper_spec_changed', {
          symbol,
          changed: Object.fromEntries(changed.map((k) => [k, { from: cached[k], to: sp[k] }])),
        });
      }
    }
    s.specs[symbol] = sp;
    s.spec_fetched_at = { ...(s.spec_fetched_at ?? {}), [symbol]: now() };
    if (!hasOwn(s.quotes, symbol)) {
      s.quotes[symbol] = { bid: sp.bid, ask: sp.ask, ...(sp.tickTimeMsc > 0 ? { timeMsc: sp.tickTimeMsc } : {}) };
    }
    dirty = true;
    return sp;
  }

  function takeFault(method: SimMethod): { kind: SimFailureKind; retcode?: number } | undefined {
    const queue = faults[method];
    return queue && queue.length > 0 ? queue.shift() : undefined;
  }

  function run<T>(method: SimMethod, mutating: boolean, body: (s: SimState) => T | Promise<T>): Promise<T> {
    return serialize(async () => {
      const s = await ensureLoaded();
      const fault = takeFault(method);
      if (fault?.kind === 'unavailable') {
        throw new BrokerUnavailableError(`simulated ${method} unavailable (injected)`);
      }
      if (fault?.kind === 'reject') {
        throw reject(fault.retcode ?? RETCODE_REJECTED, `simulated ${method} rejected (injected)`);
      }
      await refreshQuotes(s);
      const result = await body(s);
      if (mutating || dirty) await persist();
      if (fault?.kind === 'ambiguous') {
        if (mutating) {
          throw new BrokerAmbiguousError(method, `simulated ${method}: reply lost after the operation ran (injected)`, {
            expiresAt: nowSec() + 8,
          });
        }
        throw new BrokerUnavailableError(`simulated ${method}: reply lost (injected)`);
      }
      return result;
    });
  }

  /** Sync lookup in the cache only. Used for valuation of already-known positions. */
  function specFor(s: SimState, symbol: string): SymbolInfo | undefined {
    return hasOwn(s.specs, symbol) ? s.specs[symbol] : undefined;
  }

  /** Last known quote. Used for valuation; trading paths use tradableQuote. */
  function quoteOf(s: SimState, symbol: string): SimQuote {
    return hasOwn(s.quotes, symbol) ? s.quotes[symbol] : { bid: 0, ask: 0 };
  }

  function isStale(q: SimQuote): boolean {
    return maxQuoteAgeMs !== null && typeof q.timeMsc === 'number' && now() - q.timeMsc > maxQuoteAgeMs;
  }

  /** The quote for a trade operation. A stale quote is no quote: the market is treated as closed. */
  function tradableQuote(s: SimState, symbol: string): SimQuote {
    const q = quoteOf(s, symbol);
    return isStale(q) ? { bid: 0, ask: 0 } : q;
  }

  function gateAccount(): void {
    if (!account.tradeAllowed || !account.tradeExpert || !account.terminalTradeAllowed) {
      throw reject(5002, 'trading is not allowed on this account');
    }
  }

  function findPosition(s: SimState, ticket: number): SimPosition {
    const p = s.positions.find((x) => x.ticket === ticket);
    if (!p) throw reject(5008, `position not found: ${ticket}`);
    return p;
  }

  function findOrder(s: SimState, ticket: number): SimOrder {
    const o = s.orders.find((x) => x.ticket === ticket);
    if (!o) throw reject(5008, `order not found: ${ticket}`);
    return o;
  }

  function findDuplicate(s: SimState, comment: string): PlaceOrderResult | null {
    if (!comment) return null;
    const p = [...s.positions].reverse().find((x) => x.magic === magic && x.comment === comment);
    if (p) {
      return {
        retcode: 0,
        orderTicket: p.openOrderTicket,
        dealTicket: p.openDealTicket,
        positionTicket: p.ticket,
        price: p.openPrice,
        volume: p.volume,
        duplicate: true,
      };
    }
    const o = [...s.orders].reverse().find((x) => x.magic === magic && x.comment === comment);
    if (o) {
      return {
        retcode: 0,
        orderTicket: o.ticket,
        dealTicket: 0,
        positionTicket: 0,
        price: o.priceOpen,
        volume: o.volume,
        duplicate: true,
      };
    }
    const t = nowSec();
    const d = [...s.deals]
      .reverse()
      .find(
        (x) =>
          x.magic === magic &&
          x.comment === comment &&
          x.time >= t - DUP_LOOKBACK_SEC &&
          x.time <= t + 60,
      );
    if (d) {
      return {
        retcode: 0,
        orderTicket: d.order,
        dealTicket: d.ticket,
        positionTicket: d.positionId,
        price: d.price,
        volume: d.volume,
        duplicate: true,
      };
    }
    return null;
  }

  function floatingProfit(s: SimState): number {
    let total = 0;
    for (const p of s.positions) {
      const sp = specFor(s, p.symbol);
      if (!sp) continue;
      total += pnl(sp, p.type, p.openPrice, stopRefFor(quoteOf(s, p.symbol), p.type === 'BUY'), p.volume);
    }
    return total;
  }

  function marginUsed(s: SimState): number {
    let total = 0;
    for (const p of s.positions) {
      const sp = specFor(s, p.symbol);
      if (!sp) continue;
      total += (p.volume * sp.contractSize * p.openPrice) / account.leverage;
    }
    return total;
  }

  function accountView(s: SimState): AccountInfo {
    const equity = roundTo(s.balance + floatingProfit(s), 2);
    const margin = roundTo(marginUsed(s), 2);
    return {
      ...account,
      balance: roundTo(s.balance, 2),
      equity,
      margin,
      marginFree: roundTo(equity - margin, 2),
      marginLevel: margin > 0 ? roundTo((equity / margin) * 100, 2) : 0,
    };
  }

  function positionView(s: SimState, p: SimPosition): BrokerPosition {
    const sp = specFor(s, p.symbol);
    const current = stopRefFor(quoteOf(s, p.symbol), p.type === 'BUY');
    return {
      ticket: p.ticket,
      identifier: p.ticket,
      symbol: p.symbol,
      type: p.type,
      volume: p.volume,
      openPrice: p.openPrice,
      priceCurrent: current,
      sl: p.sl,
      tp: p.tp,
      profit: sp ? pnl(sp, p.type, p.openPrice, current, p.volume) : 0,
      swap: 0,
      magic: p.magic,
      comment: p.comment,
      timeOpen: p.timeOpen,
    };
  }

  function orderView(o: SimOrder): BrokerOrder {
    return {
      ticket: o.ticket,
      symbol: o.symbol,
      type: o.type,
      volumeInitial: o.volume,
      volumeCurrent: o.volume,
      priceOpen: o.priceOpen,
      sl: o.sl,
      tp: o.tp,
      magic: o.magic,
      comment: o.comment,
      timeSetup: o.timeSetup,
      timeExpiration: o.timeExpiration,
    };
  }

  function dealView(d: SimDeal): BrokerDeal {
    return {
      ticket: d.ticket,
      order: d.order,
      positionId: d.positionId,
      symbol: d.symbol,
      type: d.type,
      entry: d.entry,
      volume: d.volume,
      price: d.price,
      profit: d.profit,
      commission: 0,
      swap: 0,
      fee: 0,
      magic: d.magic,
      comment: d.comment,
      time: d.time,
      reason: d.reason,
    };
  }

  // Shared entry/stop checks for checkOrder and placeOrder. Returns the price to use.
  function prepareEntry(s: SimState, req: PlaceOrderRequest, sp: SymbolInfo): { price: number; sl: number; tp: number } {
    const buy = isBuy(req.orderType);
    checkMode(sp, true, buy);
    checkVolume(sp, req.volume);
    const q = tradableQuote(s, sp.symbol);
    const sl = roundTo(req.sl, sp.digits);
    const tp = roundTo(req.tp, sp.digits);
    if (!PENDING_TYPES.has(req.orderType)) {
      const ref = stopRefFor(q, buy);
      if (ref <= 0 || fillPriceFor(q, buy) <= 0) throw reject(RETCODE_NO_QUOTE, `market closed: no quote for ${sp.symbol}`);
      checkStops(sp, buy, ref, sl, tp, true, true);
      return { price: roundTo(fillPriceFor(q, buy), sp.digits), sl, tp };
    }
    const price = roundTo(req.price, sp.digits);
    if (isStale(quoteOf(s, sp.symbol))) throw reject(RETCODE_NO_QUOTE, `market closed: stale quote for ${sp.symbol}`);
    if (q.bid > 0 && q.ask > 0) checkPendingPrice(req.orderType, price, q);
    checkStops(sp, buy, price, sl, tp, true, true);
    return { price, sl, tp };
  }

  const broker: SimulatedBroker = {
    kind: 'simulated',
    magic,

    ping() {
      return run('ping', false, () => ({
        eaVersion: 'simulated',
        terminalConnected: true,
        tradeAllowed: account.terminalTradeAllowed,
        gmtTime: nowSec(),
      }));
    },

    getAccountInfo() {
      return run('getAccountInfo', false, (s) => accountView(s));
    },

    getSymbolInfo(symbol: string) {
      return run('getSymbolInfo', false, async (s) => {
        const sp = await resolveSpec(s, symbol);
        const q = quoteOf(s, symbol);
        return {
          ...sp,
          bid: q.bid,
          ask: q.ask,
          spreadPoints: sp.point > 0 ? Math.round((q.ask - q.bid) / sp.point) : 0,
          // The real tick time when the quote carries one, so callers can see a stale market.
          tickTimeMsc: typeof q.timeMsc === 'number' ? q.timeMsc : now(),
        };
      });
    },

    getPositions(symbol?: string) {
      return run('getPositions', false, (s) =>
        s.positions
          .filter((p) => p.magic === magic && (!symbol || p.symbol === symbol))
          .sort(byTicket)
          .map((p) => positionView(s, p)),
      );
    },

    getOrders(symbol?: string) {
      return run('getOrders', false, (s) =>
        s.orders
          .filter((o) => o.magic === magic && (!symbol || o.symbol === symbol))
          .sort(byTicket)
          .map(orderView),
      );
    },

    getDeals(q: { fromSec: number; toSec?: number; positionId?: number }) {
      return run('getDeals', false, (s) =>
        s.deals
          .filter(
            (d) =>
              d.magic === magic &&
              d.time >= q.fromSec &&
              (q.toSec === undefined ? d.time <= nowSec() + 60 : d.time <= q.toSec) &&
              (q.positionId === undefined || d.positionId === q.positionId),
          )
          .sort(byTicket)
          .map(dealView),
      );
    },

    checkOrder(req: PlaceOrderRequest) {
      return run('checkOrder', false, async (s): Promise<OrderCheckResult> => {
        validateFields(req, nowSec());
        const sp = await resolveSpec(s, req.symbol);
        try {
          const entry = prepareEntry(s, req, sp);
          const margin = (req.volume * sp.contractSize * entry.price) / account.leverage;
          const info = accountView(s);
          return {
            ok: true,
            retcode: 0,
            margin: roundTo(margin, 2),
            marginFree: roundTo(info.marginFree - margin, 2),
            comment: 'Done',
          };
        } catch (err) {
          if (err instanceof BrokerRejectedError) {
            return { ok: false, retcode: err.retcode, margin: 0, marginFree: accountView(s).marginFree, comment: err.message };
          }
          throw err;
        }
      });
    },

    placeOrder(req: PlaceOrderRequest) {
      return run('placeOrder', true, async (s): Promise<PlaceOrderResult> => {
        const t = nowSec();
        validateFields(req, t);
        gateAccount();
        const sp = await resolveSpec(s, req.symbol);
        const dup = findDuplicate(s, req.comment);
        if (dup) return dup;

        const buy = isBuy(req.orderType);
        const entry = prepareEntry(s, req, sp);
        const side: OrderSide = buy ? 'BUY' : 'SELL';

        if (!PENDING_TYPES.has(req.orderType)) {
          const orderTicket = s.nextOrderTicket++;
          const dealTicket = s.nextDealTicket++;
          s.positions.push({
            ticket: orderTicket,
            symbol: sp.symbol,
            type: side,
            volume: req.volume,
            openPrice: entry.price,
            sl: entry.sl,
            tp: entry.tp,
            magic,
            comment: storedComment(req.comment),
            timeOpen: t,
            openOrderTicket: orderTicket,
            openDealTicket: dealTicket,
          });
          s.deals.push({
            ticket: dealTicket,
            order: orderTicket,
            positionId: orderTicket,
            symbol: sp.symbol,
            type: side,
            entry: 'IN',
            volume: req.volume,
            price: entry.price,
            profit: 0,
            magic,
            comment: storedComment(req.comment),
            time: t,
            reason: 'EXPERT',
          });
          return {
            retcode: RETCODE_DONE,
            orderTicket,
            dealTicket,
            positionTicket: orderTicket,
            price: entry.price,
            volume: req.volume,
            duplicate: false,
          };
        }

        const orderTicket = s.nextOrderTicket++;
        // Like the EA: without ORDER_TIME_SPECIFIED support the order falls back to GTC.
        const expirationApplied = req.expiration !== undefined && req.expiration > 0 ? supportsExpiration : undefined;
        s.orders.push({
          ticket: orderTicket,
          symbol: sp.symbol,
          type: req.orderType as SimPendingType,
          volume: req.volume,
          priceOpen: entry.price,
          sl: entry.sl,
          tp: entry.tp,
          magic,
          comment: storedComment(req.comment),
          timeSetup: t,
          timeExpiration: expirationApplied ? (req.expiration ?? 0) : 0,
        });
        return {
          retcode: RETCODE_PLACED,
          orderTicket,
          dealTicket: 0,
          positionTicket: 0,
          price: entry.price,
          volume: req.volume,
          duplicate: false,
          ...(expirationApplied !== undefined ? { expirationApplied } : {}),
        };
      });
    },

    modifyPosition(ticket: number, sl: number, tp: number) {
      return run('modifyPosition', true, async (s): Promise<{ retcode: number; unchanged: boolean }> => {
        const p = findPosition(s, ticket);
        if (p.magic !== magic) throw reject(5006, 'position not owned by this EA');
        const sp = await resolveSpec(s, p.symbol);
        const buy = p.type === 'BUY';
        checkMode(sp, false, buy);
        const nsl = roundTo(sl, sp.digits);
        const ntp = roundTo(tp, sp.digits);
        const slChanged = nsl !== p.sl;
        const tpChanged = ntp !== p.tp;
        if (!slChanged && !tpChanged) return { retcode: 0, unchanged: true };
        const ref = stopRefFor(tradableQuote(s, p.symbol), buy);
        if (ref <= 0) throw reject(RETCODE_NO_QUOTE, `market closed: no quote for ${p.symbol}`);
        checkStops(sp, buy, ref, nsl, ntp, slChanged, tpChanged);
        if (slChanged) checkFreeze(sp, ref, p.sl);
        if (tpChanged) checkFreeze(sp, ref, p.tp);
        p.sl = nsl;
        p.tp = ntp;
        return { retcode: RETCODE_DONE, unchanged: false };
      });
    },

    modifyPendingOrder(ticket: number, price: number, sl: number, tp: number) {
      return run('modifyPendingOrder', true, async (s): Promise<{ retcode: number }> => {
        const o = findOrder(s, ticket);
        if (o.magic !== magic) throw reject(5006, 'order not owned by this EA');
        const sp = await resolveSpec(s, o.symbol);
        const buy = isBuy(o.type);
        checkMode(sp, false, buy);
        const np = price > 0 ? roundTo(price, sp.digits) : o.priceOpen;
        const nsl = roundTo(sl, sp.digits);
        const ntp = roundTo(tp, sp.digits);
        const priceChanged = np !== o.priceOpen;
        const slChanged = nsl !== o.sl;
        const tpChanged = ntp !== o.tp;
        if (!priceChanged && !slChanged && !tpChanged) return { retcode: 0 };
        const q = tradableQuote(s, o.symbol);
        const market = fillPriceFor(q, buy);
        if (market <= 0) throw reject(RETCODE_NO_QUOTE, `market closed: no quote for ${o.symbol}`);
        checkStops(sp, buy, np, nsl, ntp, slChanged, tpChanged);
        if (priceChanged) checkFreeze(sp, market, o.priceOpen);
        o.priceOpen = np;
        o.sl = nsl;
        o.tp = ntp;
        return { retcode: RETCODE_DONE };
      });
    },

    closePosition(ticket: number, volume?: number) {
      return run('closePosition', true, async (s): Promise<CloseResult> => {
        const p = findPosition(s, ticket);
        if (p.magic !== magic) throw reject(5006, 'position not owned by this EA');
        const sp = await resolveSpec(s, p.symbol);
        const buy = p.type === 'BUY';
        checkMode(sp, false, buy);
        const want = volume ?? 0;
        if (want < 0) throw reject(4001, 'volume must be >= 0');
        const posVol = p.volume;
        const full = want <= 0 || Math.abs(want - posVol) < VOLUME_EPS;
        if (!full) {
          if (want > posVol + VOLUME_EPS) {
            throw reject(5004, `volume ${want} exceeds position volume ${posVol}`);
          }
          checkVolume(sp, want);
          if (posVol - want < sp.volumeMin - VOLUME_EPS) {
            throw reject(5004, `remaining volume ${roundTo(posVol - want, 8)} would be below min ${sp.volumeMin}`);
          }
        }
        const closePx = stopRefFor(tradableQuote(s, p.symbol), buy);
        if (closePx <= 0) throw reject(RETCODE_NO_QUOTE, `market closed: no quote for ${p.symbol}`);
        const closedVolume = full ? posVol : roundTo(want, 8);
        const price = roundTo(closePx, sp.digits);
        const profit = pnl(sp, p.type, p.openPrice, price, closedVolume);
        const dealTicket = s.nextDealTicket++;
        s.deals.push({
          ticket: dealTicket,
          order: s.nextOrderTicket++,
          positionId: p.ticket,
          symbol: sp.symbol,
          type: buy ? 'SELL' : 'BUY',
          entry: 'OUT',
          volume: closedVolume,
          price,
          profit,
          magic,
          comment: p.comment,
          time: nowSec(),
          reason: 'CLIENT',
        });
        s.balance = roundTo(s.balance + profit, 2);
        if (full) {
          s.positions = s.positions.filter((x) => x.ticket !== p.ticket);
        } else {
          p.volume = roundTo(posVol - closedVolume, 8);
        }
        return {
          retcode: RETCODE_DONE,
          dealTicket,
          closedVolume,
          price,
          remainingVolume: full ? 0 : p.volume,
        };
      });
    },

    cancelOrder(ticket: number) {
      return run('cancelOrder', true, async (s): Promise<{ retcode: number }> => {
        const o = findOrder(s, ticket);
        if (o.magic !== magic) throw reject(5006, 'order not owned by this EA');
        const sp = await resolveSpec(s, o.symbol);
        checkMode(sp, false, isBuy(o.type));
        s.orders = s.orders.filter((x) => x.ticket !== ticket);
        return { retcode: RETCODE_DONE };
      });
    },

    setQuote(symbol: string, bid: number, ask: number, timeMsc?: number) {
      return serialize(async () => {
        const s = await ensureLoaded();
        s.quotes[symbol] = { bid, ask, ...(timeMsc !== undefined ? { timeMsc } : {}) };
      });
    },

    evaluate() {
      return serialize(async (): Promise<EvaluateReport> => {
        const s = await ensureLoaded();
        await refreshQuotes(s);
        const t = nowSec();
        const report: EvaluateReport = { filled: [], expired: [], closed: [] };

        s.orders = s.orders.filter((o) => {
          if (o.timeExpiration > 0 && t >= o.timeExpiration) {
            report.expired.push(o.ticket);
            return false;
          }
          return true;
        });

        for (const o of [...s.orders].sort(byTicket)) {
          const q = tradableQuote(s, o.symbol);
          if (!(q.bid > 0 && q.ask > 0) || !shouldFill(o, q)) continue;
          s.orders = s.orders.filter((x) => x.ticket !== o.ticket);
          const side: OrderSide = isBuy(o.type) ? 'BUY' : 'SELL';
          const dealTicket = s.nextDealTicket++;
          s.positions.push({
            ticket: o.ticket,
            symbol: o.symbol,
            type: side,
            volume: o.volume,
            openPrice: o.priceOpen,
            sl: o.sl,
            tp: o.tp,
            magic: o.magic,
            comment: o.comment,
            timeOpen: t,
            openOrderTicket: o.ticket,
            openDealTicket: dealTicket,
          });
          s.deals.push({
            ticket: dealTicket,
            order: o.ticket,
            positionId: o.ticket,
            symbol: o.symbol,
            type: side,
            entry: 'IN',
            volume: o.volume,
            price: o.priceOpen,
            profit: 0,
            magic: o.magic,
            comment: o.comment,
            time: t,
            reason: 'EXPERT',
          });
          report.filled.push(o.ticket);
        }

        for (const p of [...s.positions].sort(byTicket)) {
          const q = tradableQuote(s, p.symbol);
          const sp = specFor(s, p.symbol);
          if (!sp || !(q.bid > 0 && q.ask > 0)) continue;
          const trigger = triggerFor(p, q);
          if (!trigger) continue;
          const profit = pnl(sp, p.type, p.openPrice, trigger.level, p.volume);
          s.deals.push({
            ticket: s.nextDealTicket++,
            order: s.nextOrderTicket++,
            positionId: p.ticket,
            symbol: p.symbol,
            type: p.type === 'BUY' ? 'SELL' : 'BUY',
            entry: 'OUT',
            volume: p.volume,
            price: trigger.level,
            profit,
            magic: p.magic,
            comment: p.comment,
            time: t,
            reason: trigger.reason,
          });
          s.balance = roundTo(s.balance + profit, 2);
          s.positions = s.positions.filter((x) => x.ticket !== p.ticket);
          report.closed.push({ ticket: p.ticket, reason: trigger.reason, price: trigger.level, profit });
        }

        s.deals = s.deals.filter((d) => d.time >= t - DEAL_RETENTION_SEC);
        await persist();
        return report;
      });
    },

    failNext(method: SimMethod, kind: SimFailureKind, retcode?: number) {
      (faults[method] ??= []).push({ kind, retcode });
    },

    getState() {
      return serialize(async () => clone(await ensureLoaded()));
    },

    snapshot() {
      return broker.getState();
    },
  };

  return broker;
}
