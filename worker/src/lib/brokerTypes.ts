/**
 * brokerTypes.ts
 *
 * Broker-agnostic types and error classes for the Vantage AutoTrader
 * (contracts §2). Implemented by mt5Broker.ts (live/demo over ZeroMQ) and
 * simulatedBroker.ts (paper mode and tests). All times in this layer are unix
 * seconds in GMT; the MT5 adapter converts to and from broker server time.
 */

export type OrderSide = 'BUY' | 'SELL';
export type BrokerOrderType = 'BUY' | 'SELL' | 'BUY_LIMIT' | 'SELL_LIMIT' | 'BUY_STOP' | 'SELL_STOP';
export type AccountTradeMode = 'DEMO' | 'CONTEST' | 'REAL';

export interface AccountInfo {
  login: number;
  tradeMode: AccountTradeMode;
  marginMode: 'NETTING' | 'EXCHANGE' | 'HEDGING';
  currency: string;
  balance: number;
  equity: number;
  margin: number;
  marginFree: number;
  marginLevel: number;
  leverage: number;
  tradeAllowed: boolean;
  tradeExpert: boolean;
  terminalTradeAllowed: boolean;
  server: string;
  company: string;
}

export interface SymbolInfo {
  symbol: string;
  digits: number;
  point: number;
  tickSize: number;
  tickValue: number;
  tickValueProfit: number;
  tickValueLoss: number;
  contractSize: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  volumeLimit: number;
  stopsLevelPoints: number;
  freezeLevelPoints: number;
  tradeMode: 'DISABLED' | 'LONGONLY' | 'SHORTONLY' | 'CLOSEONLY' | 'FULL';
  bid: number;
  ask: number;
  spreadPoints: number;
  /** Time of the last tick, GMT epoch milliseconds; 0 when unknown (for example no server-time offset yet). */
  tickTimeMsc: number;
  currencyProfit: string;
  currencyMargin: string;
}

export interface BrokerPosition {
  ticket: number;
  identifier: number;
  symbol: string;
  type: OrderSide;
  volume: number;
  openPrice: number;
  priceCurrent: number;
  sl: number;
  tp: number;
  profit: number;
  swap: number;
  magic: number;
  comment: string;
  timeOpen: number;
}

export interface BrokerOrder {
  ticket: number;
  symbol: string;
  type: Exclude<BrokerOrderType, 'BUY' | 'SELL'>;
  volumeInitial: number;
  volumeCurrent: number;
  priceOpen: number;
  sl: number;
  tp: number;
  magic: number;
  comment: string;
  timeSetup: number;
  timeExpiration: number;
}

export interface BrokerDeal {
  ticket: number;
  order: number;
  positionId: number;
  symbol: string;
  type: 'BUY' | 'SELL' | 'OTHER';
  entry: 'IN' | 'OUT' | 'INOUT' | 'OUT_BY';
  volume: number;
  price: number;
  profit: number;
  commission: number;
  swap: number;
  fee: number;
  magic: number;
  comment: string;
  time: number;
  reason: 'CLIENT' | 'EXPERT' | 'SL' | 'TP' | 'SO' | 'MOBILE' | 'WEB' | 'OTHER';
}

export interface PlaceOrderRequest {
  symbol: string;
  orderType: BrokerOrderType;
  volume: number;
  price: number;
  sl: number;
  tp: number;
  deviationPoints: number;
  comment: string;
  /** Pending orders only. Unix seconds, GMT. */
  expiration?: number;
}

export interface PlaceOrderResult {
  retcode: number;
  orderTicket: number;
  dealTicket: number;
  positionTicket: number;
  price: number;
  volume: number;
  duplicate: boolean;
  /**
   * Pending orders sent with an expiration: whether the broker accepted
   * ORDER_TIME_SPECIFIED. false means the order is good-till-cancelled and the
   * lifecycle manager must cancel it at expiry. Absent when no expiration was sent.
   */
  expirationApplied?: boolean;
}

export interface CloseResult {
  retcode: number;
  dealTicket: number;
  closedVolume: number;
  price: number;
  remainingVolume: number;
}

export interface OrderCheckResult {
  ok: boolean;
  retcode: number;
  margin: number;
  marginFree: number;
  comment: string;
}

/** Broker answered and refused: the operation definitely did not happen. */
export class BrokerRejectedError extends Error {
  readonly retcode: number;

  constructor(retcode: number, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'BrokerRejectedError';
    this.retcode = retcode;
  }
}

/**
 * Transport failure or timeout on a mutation: the operation MAY have happened.
 * `requestId` and `expiresAt` (unix s, GMT) are set when the request was sent,
 * so the caller can wait until `expiresAt` before reconciling.
 */
export class BrokerAmbiguousError extends Error {
  readonly action: string;
  readonly requestId?: string;
  readonly expiresAt?: number;

  constructor(action: string, message: string, details: { requestId?: string; expiresAt?: number } = {}) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'BrokerAmbiguousError';
    this.action = action;
    this.requestId = details.requestId;
    this.expiresAt = details.expiresAt;
  }
}

/** Bridge unreachable before the request could be sent, or read-only call failed. */
export class BrokerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'BrokerUnavailableError';
  }
}

export interface BrokerAdapter {
  readonly kind: 'mt5' | 'simulated';
  readonly magic: number;
  ping(): Promise<{ eaVersion: string; terminalConnected: boolean; tradeAllowed: boolean; gmtTime: number }>;
  getAccountInfo(): Promise<AccountInfo>;
  getSymbolInfo(symbol: string): Promise<SymbolInfo>;
  getPositions(symbol?: string): Promise<BrokerPosition[]>; // always filtered to this.magic
  getOrders(symbol?: string): Promise<BrokerOrder[]>; // always filtered to this.magic
  getDeals(q: { fromSec: number; toSec?: number; positionId?: number }): Promise<BrokerDeal[]>; // magic-filtered
  checkOrder(req: PlaceOrderRequest): Promise<OrderCheckResult>;
  placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult>;
  modifyPosition(ticket: number, sl: number, tp: number): Promise<{ retcode: number; unchanged: boolean }>;
  modifyPendingOrder(ticket: number, price: number, sl: number, tp: number): Promise<{ retcode: number }>;
  closePosition(ticket: number, volume?: number): Promise<CloseResult>;
  cancelOrder(ticket: number): Promise<{ retcode: number }>;
}
