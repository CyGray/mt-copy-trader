/**
 * mt5Client.ts
 *
 * ZeroMQ REQ/REP client that bridges the Node.js worker to the
 * MQL5 VantageBridgeEA running inside MetaTrader 5 (Wine/Xvfb).
 *
 * Transport: tcp://127.0.0.1:5555  (loopback, < 0.5 ms RTT)
 * Pattern:   REQ → EA → REP
 *
 * If the socket is unavailable or the EA does not respond within
 * MT5_TIMEOUT_MS, the call rejects with an Mt5TimeoutError so callers
 * can trigger the emergency alert path.
 */

import { logger } from './logger';
import { writeSystemLog } from './systemLog';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrderType =
  | 'BUY'
  | 'SELL'
  | 'BUY_LIMIT'
  | 'SELL_LIMIT'
  | 'BUY_STOP'
  | 'SELL_STOP';

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
};

export type Mt5OrderModifyPayload = {
  action: 'ORDER_MODIFY';
  ticket: number;
  sl: number;
  tp: number;
};

export type Mt5GetPositionsPayload = {
  action: 'GET_POSITIONS';
  symbol: string;
};

export type Mt5ClosePositionPayload = {
  action: 'CLOSE_POSITION';
  ticket: number;
  volume?: number; // omit for full close
};

export type Mt5Payload =
  | Mt5OrderSendPayload
  | Mt5OrderModifyPayload
  | Mt5GetPositionsPayload
  | Mt5ClosePositionPayload;

export type Mt5Position = {
  ticket: number;
  symbol: string;
  type: 'BUY' | 'SELL';
  volume: number;
  open_price: number;
  sl: number;
  tp: number;
  profit: number;
  magic: number;
  comment: string;
};

export type Mt5Response =
  | { ok: true; retcode: number; data: unknown }
  | { ok: false; retcode: number; error: string };

export class Mt5TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`MT5 bridge did not respond within ${timeoutMs}ms`);
    this.name = 'Mt5TimeoutError';
  }
}

export class Mt5BridgeError extends Error {
  retcode: number;
  constructor(retcode: number, message: string) {
    super(`MT5 error ${retcode}: ${message}`);
    this.name = 'Mt5BridgeError';
    this.retcode = retcode;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MT5_ENDPOINT = process.env.MT5_ZMQ_ENDPOINT ?? 'tcp://127.0.0.1:5555';
const MT5_TIMEOUT_MS = Number(process.env.MT5_TIMEOUT_MS ?? 5000);
const MT5_RECONNECT_INTERVAL_MS = 1000;
const ALERT_CHAT_ID = process.env.MT5_ALERT_CHAT_ID ?? '';

// ---------------------------------------------------------------------------
// Lazy ZeroMQ import — zeromq is an optional peer dependency.
// If not installed, calls will throw a clear error rather than crash startup.
// ---------------------------------------------------------------------------

let _zmq: typeof import('zeromq') | null = null;

async function getZmq(): Promise<typeof import('zeromq')> {
  if (_zmq) return _zmq;
  try {
    _zmq = await import('zeromq');
    return _zmq;
  } catch {
    throw new Error(
      'zeromq package not installed. Run: npm install zeromq --workspace worker',
    );
  }
}

// ---------------------------------------------------------------------------
// Socket management — one shared REQ socket, recreated on timeout.
// ---------------------------------------------------------------------------

// zeromq.Request type imported lazily
type ZmqRequest = Awaited<ReturnType<typeof createSocket>>;

let _socket: ZmqRequest | null = null;
let _socketHealthy = true;
let _lastAlertAt = 0;

async function createSocket() {
  const zmq = await getZmq();
  // @ts-expect-error — zeromq v6 dynamic import typing
  const sock = new zmq.Request() as {
    connect(addr: string): void;
    send(data: Buffer): Promise<void>;
    receive(): Promise<[Buffer]>;
    close(): void;
    sendTimeout: number;
    receiveTimeout: number;
  };
  sock.sendTimeout = MT5_TIMEOUT_MS;
  sock.receiveTimeout = MT5_TIMEOUT_MS;
  sock.connect(MT5_ENDPOINT);
  return sock;
}

async function getSocket(): Promise<ZmqRequest> {
  if (!_socket) {
    _socket = await createSocket();
    logger.info('mt5_zmq_connected', { endpoint: MT5_ENDPOINT });
  }
  return _socket;
}

function destroySocket(): void {
  if (_socket) {
    try {
      _socket.close();
    } catch {
      // ignore
    }
    _socket = null;
  }
}

// ---------------------------------------------------------------------------
// Alert helpers
// ---------------------------------------------------------------------------

async function maybeSendDisconnectAlert(message: string): Promise<void> {
  const now = Date.now();
  // Throttle alerts to once per 60 s
  if (now - _lastAlertAt < 60_000) return;
  _lastAlertAt = now;

  await writeSystemLog('error', 'mt5_client', 'mt5_bridge_unreachable', { message, alertChatId: ALERT_CHAT_ID });
  logger.error('mt5_bridge_unreachable', { message });

  // If a Telegram admin bot token is configured, send a message.
  // The actual Telegram send is handled by the caller's notification layer.
}

// ---------------------------------------------------------------------------
// Core send function
// ---------------------------------------------------------------------------

export async function mt5Send(payload: Mt5Payload): Promise<Mt5Response> {
  const serialized = JSON.stringify(payload);
  let attempts = 0;

  while (attempts < 2) {
    attempts += 1;
    let socket: ZmqRequest;

    try {
      socket = await getSocket();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await maybeSendDisconnectAlert(msg);
      throw new Mt5TimeoutError(MT5_TIMEOUT_MS);
    }

    try {
      await socket.send(Buffer.from(serialized));
      const [reply] = await socket.receive();
      const text = reply.toString();
      const parsed = JSON.parse(text) as Mt5Response;

      _socketHealthy = true;

      if (!parsed.ok) {
        const errResponse = parsed as { ok: false; retcode: number; error: string };
        throw new Mt5BridgeError(errResponse.retcode, errResponse.error);
      }

      return parsed;
    } catch (err) {
      if (err instanceof Mt5BridgeError) throw err;

      // Timeout or socket error — destroy and retry once with a fresh socket
      destroySocket();
      _socketHealthy = false;

      if (attempts >= 2) {
        const msg = err instanceof Error ? err.message : String(err);
        await maybeSendDisconnectAlert(msg);
        throw new Mt5TimeoutError(MT5_TIMEOUT_MS);
      }

      // Brief pause before retry
      await new Promise((r) => setTimeout(r, MT5_RECONNECT_INTERVAL_MS));
    }
  }

  // Unreachable but satisfies TS
  throw new Mt5TimeoutError(MT5_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Typed convenience wrappers
// ---------------------------------------------------------------------------

export async function mt5PlaceOrder(
  payload: Omit<Mt5OrderSendPayload, 'action'>,
): Promise<number> {
  const response = await mt5Send({ ...payload, action: 'ORDER_SEND' });
  if (!response.ok) {
    const e = response as { ok: false; retcode: number; error: string };
    throw new Mt5BridgeError(e.retcode, e.error);
  }
  const data = response.data as { ticket?: number };
  if (!data?.ticket) throw new Mt5BridgeError(0, 'No ticket returned from ORDER_SEND');
  return data.ticket;
}

export async function mt5ModifyOrder(ticket: number, sl: number, tp: number): Promise<void> {
  const response = await mt5Send({ action: 'ORDER_MODIFY', ticket, sl, tp });
  if (!response.ok) {
    const e = response as { ok: false; retcode: number; error: string };
    throw new Mt5BridgeError(e.retcode, e.error);
  }
}

export async function mt5GetPositions(symbol: string): Promise<Mt5Position[]> {
  const response = await mt5Send({ action: 'GET_POSITIONS', symbol });
  if (!response.ok) {
    const e = response as { ok: false; retcode: number; error: string };
    throw new Mt5BridgeError(e.retcode, e.error);
  }
  const data = response.data as { positions?: Mt5Position[] };
  return data?.positions ?? [];
}

export async function mt5ClosePosition(ticket: number, volume?: number): Promise<void> {
  const response = await mt5Send({ action: 'CLOSE_POSITION', ticket, volume });
  if (!response.ok) {
    const e = response as { ok: false; retcode: number; error: string };
    throw new Mt5BridgeError(e.retcode, e.error);
  }
}

// ---------------------------------------------------------------------------
// Health check — used by the watchdog and /health endpoint
// ---------------------------------------------------------------------------

export async function mt5HealthCheck(): Promise<{ healthy: boolean; latencyMs?: number }> {
  const start = Date.now();
  try {
    await mt5Send({ action: 'GET_POSITIONS', symbol: 'XAUUSD' });
    return { healthy: true, latencyMs: Date.now() - start };
  } catch {
    return { healthy: false };
  }
}

export function isMt5SocketHealthy(): boolean {
  return _socketHealthy;
}
