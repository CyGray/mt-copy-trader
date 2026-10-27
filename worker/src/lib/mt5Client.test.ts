import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('zeromq', () => ({
  Request: class {
    connect(): void {}
    send(): Promise<void> {
      return Promise.reject(new Error('real zeromq must not be used in tests'));
    }
    receive(): Promise<never> {
      return Promise.reject(new Error('real zeromq must not be used in tests'));
    }
    close(): void {}
  },
}));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./systemLog', () => ({ writeSystemLog: vi.fn(async () => true) }));

import {
  _resetForTests,
  getCachedGmtSkewSec,
  getCachedServerTimeOffsetSec,
  getServerTimeOffsetSec,
  isMutatingAction,
  Mt5BridgeError,
  Mt5TimeoutError,
  Mt5UnavailableError,
  mt5ClosePosition,
  mt5GetPositions,
  mt5HealthCheck,
  mt5ModifyOrder,
  mt5PlaceOrder,
  mt5Request,
  refreshServerTimeOffset,
  setSocketFactoryForTests,
  type Mt5Socket,
} from './mt5Client.js';

type Req = Record<string, unknown>;
type Responder = (req: Req) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;

/** Fake REQ socket. A responder returning null leaves the request unanswered (timeout). */
class FakeSocket implements Mt5Socket {
  readonly sent: Req[] = [];
  closed = false;
  private readonly inbox: Buffer[] = [];
  private waiter: ((frames: Buffer[]) => void) | null = null;
  private rejecter: ((err: Error) => void) | null = null;

  constructor(private readonly respond: Responder) {}

  connect(): void {}

  async send(data: Buffer): Promise<void> {
    if (this.closed) throw new Error('socket closed');
    const req = JSON.parse(data.toString('utf8')) as Req;
    this.sent.push(req);
    const reply = await this.respond(req);
    if (reply !== null && !this.closed) this.deliver(reply);
  }

  receive(): Promise<Buffer[]> {
    if (this.closed) return Promise.reject(new Error('socket closed'));
    const frame = this.inbox.shift();
    if (frame) return Promise.resolve([frame]);
    return new Promise<Buffer[]>((resolve, reject) => {
      this.waiter = resolve;
      this.rejecter = reject;
    });
  }

  close(): void {
    this.closed = true;
    const reject = this.rejecter;
    this.rejecter = null;
    this.waiter = null;
    reject?.(new Error('socket closed'));
  }

  private deliver(reply: Record<string, unknown>): void {
    const frame = Buffer.from(JSON.stringify(reply));
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      this.rejecter = null;
      resolve([frame]);
    } else {
      this.inbox.push(frame);
    }
  }
}

function ok(req: Req, data: Record<string, unknown> = {}, requestId = req.request_id): Record<string, unknown> {
  return { ok: true, retcode: 0, request_id: requestId, replayed: false, data };
}

function fail(req: Req, retcode: number, error: string, data: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: false, retcode, error, request_id: req.request_id, replayed: false, data };
}

const echoOk: Responder = (req) => ok(req, { echoed: req.action });

/** Each new socket gets its own responder, chosen by creation index. */
function installFactory(makeResponder: (index: number) => Responder = () => echoOk): FakeSocket[] {
  const sockets: FakeSocket[] = [];
  setSocketFactoryForTests(async () => {
    const socket = new FakeSocket(makeResponder(sockets.length));
    sockets.push(socket);
    return socket;
  });
  return sockets;
}

function allSent(sockets: FakeSocket[]): Req[] {
  return sockets.flatMap((s) => s.sent);
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const ORDER_PARAMS = {
  symbol: 'XAUUSD',
  order_type: 'BUY' as const,
  volume: 0.01,
  price: 0,
  sl: 2640,
  tp: 2660,
  deviation: 20,
  comment: 'BT-abc',
  magic: 98801,
};

describe('mt5Client protocol v2', () => {
  beforeEach(() => {
    _resetForTests();
    vi.stubEnv('MT5_TIMEOUT_MS', '50');
    vi.stubEnv('MT5_ZMQ_ENDPOINT', 'tcp://fake-bridge:5555');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetForTests();
  });

  it('adds v=2, a bounded request_id and expires_at on mutations only', async () => {
    const sockets = installFactory();
    const before = Math.floor(Date.now() / 1000);

    await mt5Request('PING');
    await mt5Request('ORDER_SEND', ORDER_PARAMS);

    const [ping, order] = sockets[0].sent;
    expect(ping.v).toBe(2);
    expect(ping.action).toBe('PING');
    expect(ping).not.toHaveProperty('expires_at');

    expect(order.v).toBe(2);
    expect(order.action).toBe('ORDER_SEND');
    expect(order.symbol).toBe('XAUUSD');
    expect(String(order.request_id)).toMatch(/^\d+-[a-z0-9]+-\d+$/);
    expect(String(order.request_id).length).toBeLessThanOrEqual(48);
    expect(order.expires_at).toBeGreaterThanOrEqual(before + 8);
    expect(order.expires_at).toBeLessThanOrEqual(before + 9);
    expect(ping.request_id).not.toBe(order.request_id);
  });

  it('honours an explicit expiresAt on a mutation', async () => {
    const sockets = installFactory();
    await mt5Request('CLOSE_POSITION', { ticket: 42 }, { expiresAt: 4102444800 });
    expect(sockets[0].sent[0].expires_at).toBe(4102444800);
  });

  it('isMutatingAction classifies the six mutating actions only', () => {
    for (const a of ['ORDER_SEND', 'POSITION_MODIFY', 'ORDER_MODIFY', 'PENDING_MODIFY', 'CLOSE_POSITION', 'CANCEL_ORDER']) {
      expect(isMutatingAction(a)).toBe(true);
    }
    for (const a of ['PING', 'GET_POSITIONS', 'GET_DEALS', 'ORDER_CHECK', 'SYMBOL_INFO']) {
      expect(isMutatingAction(a)).toBe(false);
    }
  });

  it('serializes requests: the second send waits for the first reply', async () => {
    const releases: (() => void)[] = [];
    const sockets = installFactory(() => (req) =>
      new Promise((resolve) => releases.push(() => resolve(ok(req, { echoed: req.action })))),
    );

    const p1 = mt5Request('PING');
    const p2 = mt5Request('GET_POSITIONS', { magic: 98801 });
    await flush();
    expect(allSent(sockets)).toHaveLength(1);

    releases[0]();
    await p1;
    await flush();
    expect(allSent(sockets)).toHaveLength(2);
    expect(allSent(sockets)[1].action).toBe('GET_POSITIONS');

    releases[1]();
    await expect(p2).resolves.toEqual({ echoed: 'GET_POSITIONS' });
  });

  it('retries a read once on timeout with a fresh socket and a new request_id', async () => {
    const sockets = installFactory((i) => (i === 0 ? () => null : echoOk));

    const data = await mt5Request('GET_ORDERS', { magic: 98801 });

    expect(data).toEqual({ echoed: 'GET_ORDERS' });
    expect(sockets).toHaveLength(2);
    expect(sockets[0].closed).toBe(true);
    expect(sockets[0].sent[0].request_id).not.toBe(sockets[1].sent[0].request_id);
  });

  it('a mutation timeout throws an ambiguous Mt5TimeoutError after exactly one send', async () => {
    const sockets = installFactory(() => () => null);

    const err = await mt5Request('ORDER_SEND', ORDER_PARAMS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Mt5TimeoutError);
    const timeout = err as Mt5TimeoutError;
    expect(timeout.ambiguous).toBe(true);
    expect(timeout.action).toBe('ORDER_SEND');
    expect(timeout.requestId).toBe(allSent(sockets)[0].request_id);
    expect(timeout.expiresAt).toBe(allSent(sockets)[0].expires_at);
    expect(allSent(sockets)).toHaveLength(1);
    expect(sockets).toHaveLength(1);
  });

  it('a read timeout after the retry throws a non-ambiguous Mt5TimeoutError', async () => {
    const sockets = installFactory(() => () => null);

    const err = await mt5Request('GET_DEALS', { from: 1 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Mt5TimeoutError);
    expect((err as Mt5TimeoutError).ambiguous).toBe(false);
    expect(allSent(sockets)).toHaveLength(2);
  });

  it('ok:false throws Mt5BridgeError with retcode, error and data, and is not retried', async () => {
    const sockets = installFactory(() => (req) => fail(req, 10016, 'Invalid stops', { detail: 'x' }));

    const err = await mt5Request('ORDER_SEND', ORDER_PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Mt5BridgeError);
    const bridge = err as Mt5BridgeError;
    expect(bridge.retcode).toBe(10016);
    expect(bridge.error).toBe('Invalid stops');
    expect(bridge.data).toEqual({ detail: 'x' });
    expect(bridge.message).toContain('10016');

    await expect(mt5Request('GET_ORDERS', {})).rejects.toBeInstanceOf(Mt5BridgeError);
    expect(allSent(sockets)).toHaveLength(2);
    expect(sockets).toHaveLength(1);
  });

  it('a reply with a different request_id is a transport failure: the mutation is ambiguous', async () => {
    const sockets = installFactory(() => (req) => ok(req, {}, 'some-other-request'));

    const err = await mt5Request('POSITION_MODIFY', { ticket: 1, sl: 1, tp: 2 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Mt5TimeoutError);
    expect((err as Mt5TimeoutError).ambiguous).toBe(true);
    expect(sockets[0].closed).toBe(true);
    expect(allSent(sockets)).toHaveLength(1);
  });

  it('a read with a mismatched request_id is retried on a fresh socket', async () => {
    const sockets = installFactory((i) => (i === 0 ? (req) => ok(req, {}, 'stale-id') : echoOk));

    await expect(mt5Request('GET_POSITIONS', {})).resolves.toEqual({ echoed: 'GET_POSITIONS' });
    expect(sockets).toHaveLength(2);
  });

  it('socket creation failure is Mt5UnavailableError and nothing is sent', async () => {
    setSocketFactoryForTests(() => {
      throw new Error('connect refused');
    });

    await expect(mt5Request('ORDER_SEND', ORDER_PARAMS)).rejects.toBeInstanceOf(Mt5UnavailableError);
  });

  it('PING updates the server-time offset cache (server_time - gmt_time)', async () => {
    const sockets = installFactory(() => (req) =>
      ok(req, { server_time: 1760010800, gmt_time: 1760000000, ea_version: '2.0.0' }),
    );

    await mt5Request('PING');
    expect(getCachedServerTimeOffsetSec()).toBe(10800);

    await expect(getServerTimeOffsetSec()).resolves.toBe(10800);
    expect(allSent(sockets)).toHaveLength(1);

    await expect(refreshServerTimeOffset()).resolves.toBe(10800);
    expect(allSent(sockets)).toHaveLength(2);
    expect(allSent(sockets)[1].action).toBe('PING');
  });

  it('PING measures the EA TimeGMT() skew against the worker clock', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    installFactory(() => (req) => ok(req, { server_time: nowSec + 7200 - 9, gmt_time: nowSec - 9, ea_version: '2.0.0' }));
    expect(getCachedGmtSkewSec()).toBeNull();
    await mt5Request('PING');
    const skew = getCachedGmtSkewSec();
    expect(skew).not.toBeNull();
    expect(Math.abs((skew as number) + 9)).toBeLessThanOrEqual(1);
  });

  it('legacy wrappers keep their signatures and run on v2', async () => {
    const sockets = installFactory((): Responder => (req) => {
      switch (req.action) {
        case 'ORDER_SEND':
          return ok(req, { retcode: 10009, order: 77, deal: 78, position: 88, price: 2650, volume: 0.01, duplicate: false });
        case 'GET_POSITIONS':
          return ok(req, {
            positions: [{ ticket: 88, symbol: 'XAUUSD', type: 'BUY', volume: 0.01, open_price: 2650, sl: 2640, tp: 2660, profit: 1, magic: 98801, comment: 'x' }],
            count: 1,
          });
        default:
          return ok(req, {});
      }
    });

    await expect(mt5PlaceOrder({ ...ORDER_PARAMS, expiration: 0 })).resolves.toBe(88);
    const order = allSent(sockets)[0];
    expect(order.action).toBe('ORDER_SEND');
    expect(order.magic).toBe(98801);
    expect(order).not.toHaveProperty('expiration');

    const positions = await mt5GetPositions('XAUUSD');
    expect(positions).toHaveLength(1);
    expect(positions[0].ticket).toBe(88);
    expect(allSent(sockets)[1]).toMatchObject({ action: 'GET_POSITIONS', symbol: 'XAUUSD' });

    await mt5ModifyOrder(88, 2645, 2660);
    expect(allSent(sockets)[2]).toMatchObject({ action: 'POSITION_MODIFY', ticket: 88, sl: 2645, tp: 2660 });

    await mt5ClosePosition(88);
    expect(allSent(sockets)[3]).toMatchObject({ action: 'CLOSE_POSITION', ticket: 88 });
    expect(allSent(sockets)[3]).not.toHaveProperty('volume');

    await mt5ClosePosition(88, 0.005);
    expect(allSent(sockets)[4]).toMatchObject({ action: 'CLOSE_POSITION', ticket: 88, volume: 0.005 });
  });

  it('mt5PlaceOrder falls back to the order ticket for pending orders', async () => {
    installFactory(() => (req) => ok(req, { retcode: 10008, order: 91, deal: 0, position: 0, price: 2640, volume: 0.01, duplicate: false }));
    await expect(mt5PlaceOrder({ ...ORDER_PARAMS, order_type: 'BUY_LIMIT', price: 2640 })).resolves.toBe(91);
  });

  it('mt5HealthCheck uses PING and reports unhealthy on timeout', async () => {
    const sockets = installFactory(() => echoOk);
    const healthy = await mt5HealthCheck();
    expect(healthy.healthy).toBe(true);
    expect(allSent(sockets)[0].action).toBe('PING');

    _resetForTests();
    installFactory(() => () => null);
    await expect(mt5HealthCheck()).resolves.toEqual({ healthy: false });
  });

  it('empty env strings fall back to the defaults; invalid timeouts fall back to 5000', async () => {
    const seen: { endpoint: string; timeoutMs: number }[] = [];
    setSocketFactoryForTests((opts) => {
      seen.push(opts);
      return new FakeSocket(echoOk);
    });

    vi.stubEnv('MT5_ZMQ_ENDPOINT', '');
    vi.stubEnv('MT5_TIMEOUT_MS', '');
    await mt5Request('PING');
    expect(seen[0]).toEqual({ endpoint: 'tcp://127.0.0.1:5555', timeoutMs: 5000 });

    for (const bad of ['abc', '0', '-5']) {
      _resetForTests();
      vi.stubEnv('MT5_TIMEOUT_MS', bad);
      setSocketFactoryForTests((opts) => {
        seen.push(opts);
        return new FakeSocket(echoOk);
      });
      await mt5Request('PING');
      expect(seen[seen.length - 1].timeoutMs).toBe(5000);
    }

    _resetForTests();
    vi.stubEnv('MT5_TIMEOUT_MS', '250');
    setSocketFactoryForTests((opts) => {
      seen.push(opts);
      return new FakeSocket(echoOk);
    });
    await mt5Request('PING');
    expect(seen[seen.length - 1].timeoutMs).toBe(250);
  });
});
