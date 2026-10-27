import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fs: null as unknown, up: true }));

vi.mock('./firestoreAdmin', () => ({ initFirestore: () => (h.up ? h.fs : null) }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./mt5Secrets', () => ({ getMt5Config: vi.fn(async () => ({ sourceChatIds: ['-1003271337051'] })) }));
vi.mock('./mt5TradeEngine', () => ({ handleSignalEvent: vi.fn() }));

import { createFakeFirestore, FakeFirestoreError, type FakeFirestore } from './testing/fakeFirestore.js';
import { _resetAlertsForTests } from './alerts.js';
import { logger } from './logger.js';
import { handleSignalEvent } from './mt5TradeEngine.js';
import type { HandleResult, SignalEventInput } from './mt5TradeEngine.js';
import {
  _resetSignalFeedForTests,
  createSignalFeed,
  dispatchSignalEvent,
  getSignalFeedStats,
  isSignalFeedRunning,
  startSignalFeed,
  stopSignalFeed,
  tickSignalFeed,
} from './signalFeed.js';
import type { SignalFeed, SignalFeedOptions } from './signalFeed.js';
import { initialQueueState } from './signalQueue.js';
import type { GoldSignal } from './vipSignalParser.js';

const SOURCE = '-1003271337051';
const OTHER = '-1009999999999';
const T0 = Date.parse('2026-10-18T10:00:00.000Z');
const LEASE_MS = 120_000;

const SIGNAL: GoldSignal = {
  symbol: 'XAUUSD',
  direction: 'sell',
  orderType: 'market',
  entryLow: 4258.5,
  entryHigh: 4261,
  stopLoss: 4264,
  takeProfits: [4254, 4247, 4240, 4225],
};

function fs(): FakeFirestore {
  return h.fs as FakeFirestore;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Seeds an event. `queued: false` writes it as an older forwarder did (no queue status). */
function eventDoc(
  id: string,
  createdMs: number,
  over: Record<string, unknown> = {},
  opts: { queued?: boolean } = {},
): void {
  const createdAt = iso(createdMs);
  fs().seed(`signal_events/${id}`, {
    chat_id: SOURCE,
    message_id: id.replace(/\D/g, '') || '1',
    message_type: 'new',
    text_hash: `hash-${id}`,
    kind: 'signal',
    signal: SIGNAL,
    message_date: createdAt,
    created_at: createdAt,
    ...(opts.queued === false ? {} : { autotrader: initialQueueState(createdAt) }),
    ...over,
  });
}

function q(id: string): Record<string, unknown> {
  return (fs().peek(`signal_events/${id}`)?.autotrader as Record<string, unknown> | undefined) ?? {};
}

function handled(): string[] {
  return vi.mocked(handleSignalEvent).mock.calls.map((c) => (c[0] as SignalEventInput).eventId);
}

function sysLogs(message: string): Array<Record<string, unknown>> {
  return fs()
    .docs('system_logs')
    .map((e) => e.data)
    .filter((e) => e.message === message);
}

const ok: HandleResult = { outcome: 'submitted', state: 'OPEN' };
const retry: HandleResult = { outcome: 'retry', reason: 'gate_error' };

function feedFor(workerId: string, over: SignalFeedOptions = {}): SignalFeed {
  return createSignalFeed({ workerId, rand: () => 0.5, queue: { leaseMs: LEASE_MS }, ...over });
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('signalFeed (durable queue)', () => {
  beforeEach(() => {
    h.fs = createFakeFirestore();
    h.up = true;
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T0);
    vi.mocked(handleSignalEvent).mockReset();
    vi.mocked(handleSignalEvent).mockResolvedValue(ok);
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
    _resetAlertsForTests();
    _resetSignalFeedForTests({ initialCursor: iso(T0 - 60_000), queue: { leaseMs: LEASE_MS } });
  });

  afterEach(() => {
    stopSignalFeed();
    vi.useRealTimers();
  });

  describe('dispatchSignalEvent', () => {
    it('maps a signal document to the engine input', async () => {
      await dispatchSignalEvent(
        {
          chat_id: SOURCE,
          message_id: '3664',
          message_type: 'edit',
          text_hash: 'abc',
          kind: 'signal',
          signal: SIGNAL,
          message_date: '2026-09-24T10:54:22.908Z',
        },
        [SOURCE],
        `${SOURCE}_3664_abc`,
      );

      const input = vi.mocked(handleSignalEvent).mock.calls[0][0] as SignalEventInput;
      expect(input).toEqual({
        eventId: `${SOURCE}_3664_abc`,
        chatId: SOURCE,
        messageId: '3664',
        messageDate: '2026-09-24T10:54:22.908Z',
        messageType: 'edit',
        kind: 'signal',
        signal: SIGNAL,
        cancelReason: undefined,
        textHash: 'abc',
      });
    });

    it('maps cancel documents with their cancel reason', async () => {
      await dispatchSignalEvent(
        { chat_id: SOURCE, message_id: '3664', kind: 'cancel', cancel_reason: 'unparseable_edit', text_hash: 'x' },
        [SOURCE],
      );
      expect(vi.mocked(handleSignalEvent).mock.calls[0][0]).toMatchObject({
        kind: 'cancel',
        signal: null,
        cancelReason: 'unparseable_edit',
        messageDate: null,
      });
    });

    it('ignores events from chats that are not configured sources', async () => {
      const result = await dispatchSignalEvent({ chat_id: OTHER, message_id: '1', kind: 'signal', signal: SIGNAL }, [SOURCE]);
      expect(result).toEqual({ outcome: 'ignored', reason: 'chat_not_configured' });
      expect(handleSignalEvent).not.toHaveBeenCalled();
    });

    it('ignores events without a chat or message id', async () => {
      const result = await dispatchSignalEvent({ chat_id: SOURCE, kind: 'signal', signal: SIGNAL }, [SOURCE]);
      expect(result).toEqual({ outcome: 'ignored', reason: 'missing_ids' });
      expect(handleSignalEvent).not.toHaveBeenCalled();
    });
  });

  describe('processing', () => {
    it('handles pending events in created_at order and records a terminal status with history', async () => {
      eventDoc('B2', T0 - 2000);
      eventDoc('A1', T0 - 3000);
      eventDoc('C3', T0 - 1000, { kind: 'cancel', signal: null, cancel_reason: 'explicit_cancel' });

      await tickSignalFeed();

      expect(handled()).toEqual(['A1', 'B2', 'C3']);
      expect(q('A1')).toMatchObject({
        status: 'done',
        attempts: 1,
        outcome: 'submitted',
        state: 'OPEN',
        lease_id: null,
        lease_owner: null,
        lease_expires_at: null,
        next_attempt_at: null,
        processed_at: iso(T0),
      });
      expect(q('A1').history).toEqual([{ attempt: 1, at: iso(T0), result: 'done' }]);

      // A second pass does nothing: finished events are never re-dispatched.
      await tickSignalFeed();
      expect(handled()).toHaveLength(3);
    });

    it('marks events from non-source chats as ignored', async () => {
      eventDoc('X9', T0 - 1000, { chat_id: OTHER });
      await tickSignalFeed();
      expect(q('X9')).toMatchObject({ status: 'ignored', outcome: 'ignored', reason: 'chat_not_configured' });
      expect(handleSignalEvent).not.toHaveBeenCalled();
    });

    it('does nothing while Firestore is unavailable (fail closed)', async () => {
      eventDoc('A1', T0 - 1000);
      h.up = false;
      expect(await tickSignalFeed()).toBe(false);
      expect(handleSignalEvent).not.toHaveBeenCalled();
      expect(getSignalFeedStats()?.lastError).toBe('firestore_unavailable');
    });

    it('never processes a legacy status (the old in-memory feed wrote `failed`)', async () => {
      eventDoc('L1', T0 - 1000, { autotrader: { status: 'failed', attempts: 5 } });
      await tickSignalFeed();
      expect(handleSignalEvent).not.toHaveBeenCalled();
      expect(q('L1')).toEqual({ status: 'failed', attempts: 5 });
    });
  });

  describe('intake and restart recovery', () => {
    it('adopts events without a queue status (older forwarder) and persists the cursor', async () => {
      eventDoc('A1', T0 - 2000, {}, { queued: false });
      eventDoc('B2', T0 - 1000, {}, { queued: false });

      await tickSignalFeed();

      expect(handled()).toEqual(['A1', 'B2']);
      expect(q('A1')).toMatchObject({ status: 'done', adopted: true });
      expect(fs().peek('autotrader_state/signal_feed')).toMatchObject({ cursor: iso(T0 - 1000), cursor_ids: ['B2'] });
    });

    it('a restart resumes from the stored cursor, even after an outage longer than the 10-minute lookback', async () => {
      eventDoc('A1', T0 - 1000, {}, { queued: false });
      await tickSignalFeed();
      expect(handled()).toEqual(['A1']);

      // The AutoTrader is down for 45 minutes while an older forwarder keeps writing status-less events.
      eventDoc('B2', T0 + 60_000, {}, { queued: false });
      eventDoc('C3', T0 + 30 * 60_000, {}, { queued: false });
      vi.setSystemTime(T0 + 45 * 60_000);

      const restarted = feedFor('restarted', { lookbackMs: 10 * 60_000 });
      await restarted.tick();
      expect(handled()).toEqual(['A1', 'B2', 'C3']);
      expect(restarted.stats().cursor).toBe(iso(T0 + 30 * 60_000));
    });

    it('without a stored cursor the first start looks back only SIGNAL_FEED_LOOKBACK_MS for status-less events', async () => {
      eventDoc('OLD', T0 - 20 * 60_000, {}, { queued: false });
      eventDoc('NEW', T0 - 5 * 60_000, {}, { queued: false });
      const first = feedFor('first', { lookbackMs: 10 * 60_000 });
      await first.tick();
      expect(handled()).toEqual(['NEW']);
      expect(q('OLD')).toEqual({});
    });

    it('events written with a pending status are found however old they are', async () => {
      eventDoc('A1', T0 - 2 * 60 * 60_000);
      const first = feedFor('first', { lookbackMs: 10 * 60_000 });
      await first.tick();
      expect(handled()).toEqual(['A1']);
    });

    it('a cursor read failure stops the tick instead of falling back to the lookback', async () => {
      const first = feedFor('first');
      fs().failNext('get');
      await expect(first.tick()).rejects.toThrow(/UNAVAILABLE/);
      expect(handleSignalEvent).not.toHaveBeenCalled();
    });

    it('reports a full intake page so the loop polls again without waiting', async () => {
      for (let i = 0; i < 100; i += 1) eventDoc(`F${i}`, T0 - 50_000 + i, {}, { queued: false });
      expect(await tickSignalFeed()).toBe(true);
    });
  });

  describe('retries, backoff and dead letters', () => {
    it('backs off exponentially and is not claimed before next_attempt_at', async () => {
      eventDoc('A1', T0 - 1000);
      vi.mocked(handleSignalEvent).mockResolvedValue(retry);

      await tickSignalFeed();
      expect(q('A1')).toMatchObject({ status: 'retry_wait', attempts: 1, last_error: 'gate_error', next_attempt_at: iso(T0 + 5_000) });

      vi.setSystemTime(T0 + 4_999);
      await tickSignalFeed();
      expect(handled()).toHaveLength(1);

      vi.setSystemTime(T0 + 5_000);
      await tickSignalFeed();
      expect(q('A1')).toMatchObject({ status: 'retry_wait', attempts: 2, next_attempt_at: iso(T0 + 5_000 + 10_000) });

      vi.setSystemTime(T0 + 15_000);
      vi.mocked(handleSignalEvent).mockResolvedValue(ok);
      await tickSignalFeed();
      expect(q('A1')).toMatchObject({ status: 'done', attempts: 3 });
      expect((q('A1').history as unknown[]).length).toBe(3);
      expect(sysLogs('signal_event_retry_scheduled')).toHaveLength(2);
    });

    it('treats a thrown dispatch error as a failed attempt', async () => {
      eventDoc('A1', T0 - 1000);
      vi.mocked(handleSignalEvent).mockRejectedValueOnce(new Error('boom'));
      await tickSignalFeed();
      expect(q('A1')).toMatchObject({ status: 'retry_wait', attempts: 1, last_error: 'boom' });
      expect((q('A1').history as Array<Record<string, unknown>>)[0]).toMatchObject({ result: 'error', detail: 'boom' });
    });

    it('dead-letters after the last attempt, raises an alert and never dispatches it again', async () => {
      _resetSignalFeedForTests({ initialCursor: iso(T0 - 60_000), queue: { maxAttempts: 3, leaseMs: LEASE_MS } });
      eventDoc('A1', T0 - 1000);
      vi.mocked(handleSignalEvent).mockResolvedValue(retry);

      for (let i = 0; i < 5; i += 1) {
        await tickSignalFeed();
        vi.setSystemTime(Date.now() + 10 * 60_000);
      }

      expect(handled()).toHaveLength(3);
      expect(q('A1')).toMatchObject({ status: 'dead_letter', attempts: 3, reason: 'max_attempts', last_error: 'gate_error' });
      expect(sysLogs('signal_event_dead_lettered')).toHaveLength(1);
      expect(fs().peek('alerts/signal_dead_letter__A1')).toMatchObject({
        type: 'signal_dead_letter',
        severity: 'error',
        status: 'open',
        source: 'autotrader',
      });
    });

    it('a dead letter does not block later events of the same trade set', async () => {
      eventDoc('A1', T0 - 2000, { message_id: '7', autotrader: { ...initialQueueState(iso(T0)), status: 'dead_letter', attempts: 8 } });
      eventDoc('A2', T0 - 1000, { message_id: '7', kind: 'cancel', signal: null, cancel_reason: 'explicit_cancel' });
      await tickSignalFeed();
      expect(handled()).toEqual(['A2']);
    });
  });

  describe('ordering', () => {
    it('a later event of the same trade set waits behind an unfinished earlier one; other trade sets proceed', async () => {
      eventDoc('S1', T0 - 3000, { message_id: '10' });
      eventDoc('E1', T0 - 2000, { message_id: '10', message_type: 'edit' });
      eventDoc('O1', T0 - 1000, { message_id: '20' });
      vi.mocked(handleSignalEvent).mockImplementation(async (ev) => (ev.eventId === 'S1' ? retry : ok));

      await tickSignalFeed();
      expect(handled()).toEqual(['S1', 'O1']);
      expect(q('E1')).toMatchObject({ status: 'pending', attempts: 0 });

      vi.setSystemTime(T0 + 5_000);
      vi.mocked(handleSignalEvent).mockResolvedValue(ok);
      await tickSignalFeed();
      // S1 finishes first, then E1 becomes eligible on the next pass.
      expect(handled()).toEqual(['S1', 'O1', 'S1']);
      await tickSignalFeed();
      expect(handled()).toEqual(['S1', 'O1', 'S1', 'E1']);
    });

    it('a reply cancel (same message id as its signal) cannot overtake the signal', async () => {
      eventDoc('S1', T0 - 2000, { message_id: '30' });
      eventDoc('C1', T0 - 1000, { message_id: '30', kind: 'cancel', signal: null, cancel_reason: 'explicit_cancel', trigger_message_id: '31' });
      vi.mocked(handleSignalEvent).mockResolvedValueOnce(retry);
      await tickSignalFeed();
      expect(handled()).toEqual(['S1']);
      expect(q('C1').status).toBe('pending');
    });
  });

  describe('leases and multiple workers', () => {
    it('two workers polling concurrently dispatch each event exactly once', async () => {
      for (let i = 1; i <= 6; i += 1) eventDoc(`K${i}`, T0 - 10_000 + i, { message_id: String(100 + i) });
      const a = feedFor('worker-a');
      const b = feedFor('worker-b');

      await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);

      expect(handled().sort()).toEqual(['K1', 'K2', 'K3', 'K4', 'K5', 'K6']);
      for (let i = 1; i <= 6; i += 1) expect(q(`K${i}`)).toMatchObject({ status: 'done', attempts: 1 });
    });

    it('a live lease blocks another worker; the second worker still serves other trade sets', async () => {
      eventDoc('S1', T0 - 2000, { message_id: '40' });
      eventDoc('O1', T0 - 1000, { message_id: '41' });
      const slow = deferred<HandleResult>();
      vi.mocked(handleSignalEvent).mockImplementation(async (ev) => (ev.eventId === 'S1' ? slow.promise : ok));

      const a = feedFor('worker-a');
      const b = feedFor('worker-b');
      const aTick = a.tick();
      await vi.waitFor(() => expect(handled()).toContain('S1'));
      expect(q('S1')).toMatchObject({ status: 'processing', lease_owner: 'worker-a' });

      await b.tick();
      expect(handled().filter((id) => id === 'S1')).toHaveLength(1);
      expect(handled()).toContain('O1');

      slow.resolve(ok);
      await aTick;
      expect(q('S1')).toMatchObject({ status: 'done', attempts: 1 });
    });

    it('renews the lease while the engine is still working', async () => {
      eventDoc('S1', T0 - 1000);
      const slow = deferred<HandleResult>();
      vi.mocked(handleSignalEvent).mockReturnValue(slow.promise);
      const a = feedFor('worker-a');
      const b = feedFor('worker-b');
      const aTick = a.tick();
      await vi.waitFor(() => expect(handled()).toHaveLength(1));

      // 130 s later the original 120 s lease would have expired, but it was renewed every 40 s.
      await vi.advanceTimersByTimeAsync(130_000);
      expect(Date.parse(String(q('S1').lease_expires_at))).toBeGreaterThan(Date.now());
      await b.tick();
      expect(handled()).toHaveLength(1);

      slow.resolve(ok);
      await aTick;
      expect(q('S1')).toMatchObject({ status: 'done', attempts: 1 });
    });

    it('recovers a crashed worker: the lease expires, another worker re-runs it, and the stale worker cannot overwrite', async () => {
      eventDoc('S1', T0 - 1000);
      const hung = deferred<HandleResult>();
      vi.mocked(handleSignalEvent).mockReturnValueOnce(hung.promise).mockResolvedValue({ outcome: 'noop', state: 'OPEN', reason: 'already_processed' });

      const a = feedFor('worker-a', { queue: { leaseMs: LEASE_MS } });
      const aTick = a.tick();
      await vi.waitFor(() => expect(handled()).toHaveLength(1));
      a.stop();

      // Worker A is frozen (no renewals run): move the clock past its lease without firing timers.
      // (vi.waitFor advances fake time a little, hence the margin.)
      vi.setSystemTime(T0 + LEASE_MS + 5_000);
      const b = feedFor('worker-b');
      await b.tick();
      expect(handled()).toHaveLength(2);
      expect(q('S1')).toMatchObject({ status: 'done', attempts: 2, outcome: 'noop', reason: 'already_processed' });
      expect((q('S1').history as Array<Record<string, unknown>>).map((r) => r.result)).toEqual(['lease_expired', 'done']);

      // A wakes up and finishes: its completion is fenced off by the lease id.
      hung.resolve(ok);
      await aTick;
      expect(q('S1')).toMatchObject({ status: 'done', attempts: 2, outcome: 'noop' });
      expect(sysLogs('signal_event_lease_lost')).toHaveLength(1);
    });

    it('a lease that expires on the final attempt dead-letters the event without another dispatch', async () => {
      eventDoc('S1', T0 - 1000, {
        autotrader: {
          ...initialQueueState(iso(T0)),
          status: 'processing',
          attempts: 8,
          lease_id: 'old',
          lease_owner: 'gone',
          lease_expires_at: iso(T0 - 1),
        },
      });
      await tickSignalFeed();
      expect(handleSignalEvent).not.toHaveBeenCalled();
      expect(q('S1')).toMatchObject({ status: 'dead_letter', reason: 'max_attempts' });
    });

    it('a failed status write leaves the event leased; it is re-run after the lease expires', async () => {
      eventDoc('S1', T0 - 1000);
      const a = feedFor('worker-a');
      // intake query, active query, claim tx succeed; the completion transaction fails.
      const realRun = fs().runTransaction.bind(fs());
      let txCount = 0;
      vi.spyOn(fs(), 'runTransaction').mockImplementation((fn) => {
        txCount += 1;
        if (txCount === 2) return Promise.reject(new FakeFirestoreError(14, 'UNAVAILABLE: injected'));
        return realRun(fn);
      });
      await a.tick();
      expect(q('S1')).toMatchObject({ status: 'processing', attempts: 1 });
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith('signal_event_status_write_failed', expect.objectContaining({ docId: 'S1' }));

      vi.setSystemTime(T0 + LEASE_MS + 1);
      await a.tick();
      expect(q('S1')).toMatchObject({ status: 'done', attempts: 2 });
    });
  });

  describe('index fallback and alerts', () => {
    it('falls back to an unordered read when the composite index is missing and still keeps per-key order', async () => {
      const original = fs().runQuery.bind(fs());
      vi.spyOn(fs(), 'runQuery').mockImplementation((c, filters, orders, limit) => {
        if (filters.some((f) => f.field === 'autotrader.status') && orders.length > 0) {
          throw new FakeFirestoreError(9, 'FAILED_PRECONDITION: The query requires an index.');
        }
        return original(c, filters, orders, limit);
      });
      eventDoc('E1', T0 - 1000, { message_id: '50', message_type: 'edit' });
      eventDoc('S1', T0 - 2000, { message_id: '50' });
      await tickSignalFeed();
      await tickSignalFeed();
      expect(handled()).toEqual(['S1', 'E1']);
      expect(getSignalFeedStats()?.orderedQuery).toBe(false);
    });

    it('raises a backlog warning when the oldest unfinished event is older than 5 minutes, and resolves it', async () => {
      eventDoc('S1', T0 - 10 * 60_000);
      vi.mocked(handleSignalEvent).mockResolvedValue(retry);
      await tickSignalFeed();
      expect(fs().peek('alerts/signal_backlog__age')).toMatchObject({ status: 'open', severity: 'warning' });

      vi.setSystemTime(T0 + 10 * 60_000);
      vi.mocked(handleSignalEvent).mockResolvedValue(ok);
      await tickSignalFeed();
      await tickSignalFeed();
      expect(fs().peek('alerts/signal_backlog__age')).toMatchObject({ status: 'resolved' });
    });

    it('exposes queue statistics for health output', async () => {
      eventDoc('S1', T0 - 1000);
      vi.mocked(handleSignalEvent).mockResolvedValue(retry);
      await tickSignalFeed();
      expect(getSignalFeedStats()).toMatchObject({
        workerId: 'test-worker',
        activeCount: 1,
        oldestActiveCreatedAt: iso(T0 - 1000),
        deadLetterCount: 0,
        lastError: null,
        orderedQuery: true,
      });
    });
  });

  it('starts and stops the loop', () => {
    expect(isSignalFeedRunning()).toBe(false);
    startSignalFeed();
    expect(isSignalFeedRunning()).toBe(true);
    stopSignalFeed();
    expect(isSignalFeedRunning()).toBe(false);
  });
});
