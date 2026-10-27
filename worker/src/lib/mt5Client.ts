/**
 * mt5Client.ts
 *
 * ZeroMQ REQ client for VantageBridgeEA, protocol v2 (mql5/PROTOCOL.md,
 * contracts §1). Transport: MT5_ZMQ_ENDPOINT (default tcp://127.0.0.1:5555).
 *
 * - One REQ socket. Every request goes through a FIFO queue, so exactly one
 *   request is in flight. The socket is created lazily and destroyed after any
 *   timeout or transport error, because a REQ socket cannot recover from a
 *   missing reply.
 * - Read-only actions retry once with a fresh socket and a new request_id.
 * - Mutating actions never retry. A timeout after the request was handed to the
 *   socket throws Mt5TimeoutError with ambiguous = true.
 * - Mutating envelopes carry expires_at (TimeGMT basis). The EA refuses them
 *   after that time, which bounds how late a timed-out request can run.
 * - PING replies update the server-time offset used by mt5Broker.
 */

import type { BrokerOrderType } from './brokerTypes';
import { logger } from './logger';
import { writeSystemLog } from './systemLog';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 2;
const DEFAULT_ENDPOINT = 'tcp://127.0.0.1:5555';
const DEFAULT_TIMEOUT_MS = 5000;
const MUTATING_TTL_SEC = 8;
const OFFSET_TTL_MS = 60_000;
const RETRY_DELAY_MS = 200;
const ALERT_THROTTLE_MS = 60_000;

const MUTATING_ACTIONS: ReadonlySet<string> = new Set([
  'ORDER_SEND',
  'POSITION_MODIFY',
  'ORDER_MODIFY',
  'PENDING_MODIFY',
  'CLOSE_POSITION',
  'CANCEL_ORDER',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrderType = BrokerOrderType;
export type Mt5Data = Record<string, unknown>;
export type Mt5Params = Record<string, unknown>;

export interface Mt5RequestOptions {
  /** Mutating actions only. Unix seconds, TimeGMT basis. Defaults to now + 8 s. */
  expiresAt?: number;
}

export interface Mt5Socket {
  connect(endpoint: string): void;
  send(data: Buffer): Promise<unknown>;
  receive(): Promise<Buffer[]>;
  close(): void;
}

export type Mt5SocketFactory = (opts: { endpoint: string; timeoutMs: number }) => Mt5Socket | Promise<Mt5Socket>;

export type Mt5OrderSendPayload = {
  action: 'ORDER_SEND';
  symbol: string;
  order_type: OrderType;
  volume: number;
  price: number; // 0.0 for market orders
  sl: number;
  tp: number;
  deviation: number;
  comment: string;
  magic: number;
  expiration?: number; // pending orders only, server time
};

export type Mt5Position = {
  ticket: number;
  identifier?: number;
  symbol: string;
  type: 'BUY' | 'SELL';
  volume: number;
  open_price: number;
  price_current?: number;
  sl: number;
  tp: number;
  profit: number;
  swap?: number;
  magic: number;
  comment: string;
  time_open?: number;
};

/** Raised when the EA answers ok:false. `data` carries check details (ORDER_CHECK). */
export class Mt5BridgeError extends Error {
  readonly retcode: number;
  readonly error: string;
  readonly data: Mt5Data;

  constructor(retcode: number, error: string, data: Mt5Data = {}) {
    super(`MT5 error ${retcode}: ${error}`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'Mt5BridgeError';
    this.retcode = retcode;
    this.error = error;
    this.data = data;
  }
}

/**
 * No reply in time. For a mutation (`ambiguous` true) the request may still run,
 * so callers reconcile after `expiresAt`. Read timeouts are not ambiguous.
 */
export class Mt5TimeoutError extends Error {
  readonly timeoutMs: number;
  readonly action: string;
  readonly requestId: string | null;
  readonly expiresAt: number | null;
  readonly ambiguous: boolean;

  constructor(
    timeoutMs: number,
    details: { action: string; requestId: string | null; expiresAt: number | null; ambiguous: boolean },
  ) {
    const outcome = details.ambiguous ? ' (outcome unknown)' : '';
    super(`MT5 bridge did not respond to ${details.action} within ${timeoutMs}ms${outcome}`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'Mt5TimeoutError';
    this.timeoutMs = timeoutMs;
    this.action = details.action;
    this.requestId = details.requestId;
    this.expiresAt = details.expiresAt;
    this.ambiguous = details.ambiguous;
  }
}

/** Failed before the request was handed to the socket. The EA never saw it. */
export class Mt5UnavailableError extends Error {
  readonly action: string;

  constructor(action: string, message: string) {
    super(`MT5 bridge unavailable for ${action}: ${message}`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'Mt5UnavailableError';
    this.action = action;
  }
}

// ---------------------------------------------------------------------------
// Configuration (read at call time; empty strings mean unset)
// ---------------------------------------------------------------------------

export function getEndpoint(): string {
  return process.env.MT5_ZMQ_ENDPOINT || DEFAULT_ENDPOINT;
}

export function getTimeoutMs(): number {
  const n = Number(process.env.MT5_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

export function isMutatingAction(action: string): boolean {
  return MUTATING_ACTIONS.has(action);
}

// ---------------------------------------------------------------------------
// Socket management
// ---------------------------------------------------------------------------

let zmqModule: { Request: new () => Mt5Socket } | null = null;

async function defaultSocketFactory(opts: { endpoint: string }): Promise<Mt5Socket> {
  if (!zmqModule) {
    try {
      zmqModule = (await import('zeromq')) as unknown as { Request: new () => Mt5Socket };
    } catch {
      throw new Error('zeromq package not installed. Run: npm install zeromq --workspace worker');
    }
  }
  const sock = new zmqModule.Request();
  sock.connect(opts.endpoint);
  return sock;
}

let socket: Mt5Socket | null = null;
let socketFactory: Mt5SocketFactory | null = null;
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;
let lastAlertAt = 0;
let socketHealthy = true;
let offset: { sec: number; at: number } | null = null;
/** EA TimeGMT() minus Node's clock at the last PING reply (seconds; 1 s resolution). */
let gmtSkew: { sec: number; at: number } | null = null;

async function acquireSocket(): Promise<Mt5Socket> {
  if (socket) return socket;
  const factory = socketFactory ?? defaultSocketFactory;
  socket = await factory({ endpoint: getEndpoint(), timeoutMs: getTimeoutMs() });
  return socket;
}

function destroySocket(): void {
  const old = socket;
  socket = null;
  if (old) {
    try {
      old.close();
    } catch {
      // ignore: the socket is being discarded anyway
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class TransportTimeout extends Error {}

class TransportFailure extends Error {}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TransportTimeout('deadline exceeded')), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

function nextRequestId(): string {
  counter += 1;
  return `${process.pid}-${Date.now().toString(36)}-${counter}`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function alertUnreachable(message: string): void {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_THROTTLE_MS) return;
  lastAlertAt = now;
  const alertChatId = process.env.MT5_ALERT_CHAT_ID ?? '';
  logger.error('mt5_bridge_unreachable', { message });
  void writeSystemLog('error', 'mt5_client', 'mt5_bridge_unreachable', { message, alertChatId }).catch(
    () => undefined,
  );
}

function offsetFromPing(data: Mt5Data): number | null {
  const server = data.server_time;
  const gmt = data.gmt_time;
  if (typeof server !== 'number' || typeof gmt !== 'number') return null;
  if (!Number.isFinite(server) || !Number.isFinite(gmt)) return null;
  return server - gmt;
}

// ---------------------------------------------------------------------------
// Request execution (runs inside the FIFO queue)
// ---------------------------------------------------------------------------

type Mt5Reply = {
  ok: boolean;
  retcode: number;
  request_id?: string;
  error?: string;
  replayed?: boolean;
  data?: Mt5Data;
};

async function executeRequest(action: string, params: Mt5Params, opts: Mt5RequestOptions): Promise<Mt5Data> {
  const mutating = isMutatingAction(action);
  const timeoutMs = getTimeoutMs();
  const maxAttempts = mutating ? 1 : 2;
  let lastError: Error = new Mt5UnavailableError(action, 'no attempt made');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(RETRY_DELAY_MS);

    const requestId = nextRequestId();
    const expiresAt = mutating
      ? opts.expiresAt !== undefined && Number.isFinite(opts.expiresAt) && opts.expiresAt > 0
        ? opts.expiresAt
        : nowSec() + MUTATING_TTL_SEC
      : null;

    const envelope: Mt5Params = { ...params, v: PROTOCOL_VERSION, request_id: requestId, action };
    if (expiresAt !== null) envelope.expires_at = expiresAt;

    let sock: Mt5Socket;
    try {
      sock = await acquireSocket();
    } catch (err) {
      destroySocket();
      socketHealthy = false;
      const message = messageOf(err);
      alertUnreachable(message);
      lastError = new Mt5UnavailableError(action, message);
      continue;
    }

    let reply: Mt5Reply;
    let handedOff = false;
    try {
      const payload = Buffer.from(JSON.stringify(envelope));
      handedOff = true;
      await withDeadline(sock.send(payload), timeoutMs);

      const recv = sock.receive();
      recv.catch(() => undefined); // a closed socket rejects a pending receive; never unhandled
      const frames = await withDeadline(recv, timeoutMs);

      const frame = frames[0];
      const text = frame === undefined ? '' : Buffer.isBuffer(frame) ? frame.toString('utf8') : String(frame);
      try {
        reply = JSON.parse(text) as Mt5Reply;
      } catch {
        throw new TransportFailure('malformed reply from bridge');
      }
      if (reply.request_id !== requestId) {
        throw new TransportFailure(`reply request_id mismatch (expected ${requestId})`);
      }
    } catch (err) {
      destroySocket();
      socketHealthy = false;
      const message = messageOf(err);
      alertUnreachable(message);

      if (mutating) {
        if (!handedOff) throw new Mt5UnavailableError(action, message);
        throw new Mt5TimeoutError(timeoutMs, { action, requestId, expiresAt, ambiguous: true });
      }
      lastError = handedOff
        ? new Mt5TimeoutError(timeoutMs, { action, requestId, expiresAt: null, ambiguous: false })
        : new Mt5UnavailableError(action, message);
      continue;
    }

    socketHealthy = true;
    if (!reply.ok) {
      throw new Mt5BridgeError(reply.retcode, reply.error ?? 'unknown error', reply.data ?? {});
    }
    const data = reply.data ?? {};
    if (action === 'PING') {
      const sec = offsetFromPing(data);
      if (sec !== null) offset = { sec, at: Date.now() };
      if (typeof data.gmt_time === 'number' && Number.isFinite(data.gmt_time)) {
        gmtSkew = { sec: data.gmt_time - Math.floor(Date.now() / 1000), at: Date.now() };
      }
    }
    return data;
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Public request API
// ---------------------------------------------------------------------------

/**
 * Sends one protocol v2 request and resolves with the reply `data`.
 * Serialized: a call waits until every earlier call has settled.
 */
export async function mt5Request<T = Mt5Data>(
  action: string,
  params: Mt5Params = {},
  opts: Mt5RequestOptions = {},
): Promise<T> {
  const run = queue.then(() => executeRequest(action, params, opts));
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return (await run) as T;
}

/**
 * Server-time offset in seconds: broker server_time minus gmt_time, from the
 * last PING. Refreshed when older than 60 s. `serverTime = gmt + offset`.
 */
export async function getServerTimeOffsetSec(): Promise<number> {
  if (offset && Date.now() - offset.at < OFFSET_TTL_MS) return offset.sec;
  return refreshServerTimeOffset();
}

export function getCachedServerTimeOffsetSec(): number | null {
  return offset && Date.now() - offset.at < OFFSET_TTL_MS ? offset.sec : null;
}

/**
 * EA `TimeGMT()` minus Node's UTC clock, from the last PING (refreshed with it),
 * or null when unknown. Request expiry (`expires_at`) is judged on the EA's
 * clock, so a large skew stretches or shrinks the window in which a timed-out
 * mutation can still execute.
 */
export function getCachedGmtSkewSec(): number | null {
  return gmtSkew && Date.now() - gmtSkew.at < OFFSET_TTL_MS ? gmtSkew.sec : null;
}

export async function refreshServerTimeOffset(): Promise<number> {
  const data = await mt5Request('PING');
  const sec = offsetFromPing(data);
  if (sec === null) throw new Error('PING reply lacks server_time or gmt_time');
  return sec;
}

export function isMt5SocketHealthy(): boolean {
  return socketHealthy;
}

// ---------------------------------------------------------------------------
// Legacy wrappers (signatures unchanged; implemented on protocol v2)
// ---------------------------------------------------------------------------

/** Returns the position ticket for market fills, else the order ticket. */
export async function mt5PlaceOrder(payload: Omit<Mt5OrderSendPayload, 'action'>): Promise<number> {
  const { expiration, ...rest } = payload;
  const data = await mt5Request('ORDER_SEND', {
    ...rest,
    ...(expiration && expiration > 0 ? { expiration } : {}),
  });
  const ticket = Number(data.position) || Number(data.order) || 0;
  if (!ticket) throw new Mt5BridgeError(0, 'No ticket returned from ORDER_SEND', data);
  return ticket;
}

export async function mt5ModifyOrder(ticket: number, sl: number, tp: number): Promise<void> {
  await mt5Request('POSITION_MODIFY', { ticket, sl, tp });
}

export async function mt5GetPositions(symbol: string): Promise<Mt5Position[]> {
  const data = await mt5Request<{ positions?: Mt5Position[] }>('GET_POSITIONS', { symbol });
  return data.positions ?? [];
}

export async function mt5ClosePosition(ticket: number, volume?: number): Promise<void> {
  await mt5Request('CLOSE_POSITION', { ticket, ...(volume && volume > 0 ? { volume } : {}) });
}

/** Health probe: PING (no account or symbol dependency). */
export async function mt5HealthCheck(): Promise<{ healthy: boolean; latencyMs?: number }> {
  const start = Date.now();
  try {
    await mt5Request('PING');
    return { healthy: true, latencyMs: Date.now() - start };
  } catch {
    return { healthy: false };
  }
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

export function setSocketFactoryForTests(factory: Mt5SocketFactory | null): void {
  socketFactory = factory;
}

export function _resetForTests(): void {
  destroySocket();
  socketFactory = null;
  queue = Promise.resolve();
  counter = 0;
  lastAlertAt = 0;
  socketHealthy = true;
  offset = null;
  gmtSkew = null;
}
