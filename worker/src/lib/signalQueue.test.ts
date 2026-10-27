import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUEUE_OPTIONS,
  MAX_HISTORY,
  appendHistory,
  backoffDelayMs,
  claimDecision,
  discardPatch,
  initialQueueState,
  orderingKey,
  readQueueState,
  requeueDecision,
  requeuePatch,
  selectEligible,
} from './signalQueue.js';
import type { SignalQueueState } from './signalQueue.js';

const NOW = Date.parse('2026-10-18T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function state(over: Partial<SignalQueueState> = {}): SignalQueueState {
  return { ...initialQueueState(iso(NOW - 1000)), ...over };
}

describe('readQueueState', () => {
  it('returns null for a missing or legacy status', () => {
    expect(readQueueState(undefined)).toBeNull();
    expect(readQueueState({})).toBeNull();
    expect(readQueueState({ status: 'failed', attempts: 5 })).toBeNull();
    expect(readQueueState('pending')).toBeNull();
  });

  it('fills defaults for partial documents', () => {
    expect(readQueueState({ status: 'pending' })).toMatchObject({
      status: 'pending',
      attempts: 0,
      next_attempt_at: null,
      lease_id: null,
      lease_expires_at: null,
    });
  });
});

describe('claimDecision', () => {
  it('claims a due pending or retry_wait event and refuses one still backing off', () => {
    expect(claimDecision(state(), NOW)).toEqual({ claim: true, reason: 'due' });
    expect(claimDecision(state({ status: 'retry_wait', next_attempt_at: iso(NOW) }), NOW)).toEqual({ claim: true, reason: 'due' });
    expect(claimDecision(state({ status: 'retry_wait', next_attempt_at: iso(NOW + 1) }), NOW)).toEqual({ claim: false, reason: 'backing_off' });
  });

  it('refuses a live lease and claims an expired or unreadable one', () => {
    expect(claimDecision(state({ status: 'processing', lease_expires_at: iso(NOW + 1) }), NOW).claim).toBe(false);
    expect(claimDecision(state({ status: 'processing', lease_expires_at: iso(NOW) }), NOW)).toEqual({ claim: true, reason: 'lease_expired' });
    expect(claimDecision(state({ status: 'processing', lease_expires_at: 'garbage' }), NOW)).toEqual({ claim: true, reason: 'lease_expired' });
  });

  it('never claims a terminal event', () => {
    for (const status of ['done', 'ignored', 'dead_letter', 'discarded'] as const) {
      expect(claimDecision(state({ status }), NOW)).toEqual({ claim: false, reason: 'terminal' });
    }
    expect(claimDecision(null, NOW)).toEqual({ claim: false, reason: 'no_status' });
  });
});

describe('backoffDelayMs', () => {
  it('doubles from the base and caps at the maximum', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelayMs(n))).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ]);
  });

  it('applies at most ±20 % jitter', () => {
    expect(backoffDelayMs(2, DEFAULT_QUEUE_OPTIONS, 0)).toBe(8_000);
    expect(backoffDelayMs(2, DEFAULT_QUEUE_OPTIONS, 0.999999)).toBeCloseTo(12_000, -1);
  });

  it('reaches dead letter after roughly ten minutes with the defaults', () => {
    let total = 0;
    for (let n = 1; n < DEFAULT_QUEUE_OPTIONS.maxAttempts; n += 1) total += backoffDelayMs(n);
    expect(total).toBe(615_000);
  });
});

describe('selectEligible', () => {
  const doc = (id: string, msg: string, createdMs: number, s: Partial<SignalQueueState> = {}) => ({
    id,
    chat_id: '-100',
    message_id: msg,
    created_at: iso(createdMs),
    autotrader: state(s),
  });

  it('returns at most one event per key, the earliest, only when it is claimable', () => {
    const docs = [
      doc('b', '1', NOW - 1000),
      doc('a', '1', NOW - 2000, { status: 'retry_wait', next_attempt_at: iso(NOW + 60_000) }),
      doc('c', '2', NOW - 3000),
      doc('d', '2', NOW - 500),
      doc('e', '3', NOW - 100, { status: 'processing', lease_expires_at: iso(NOW + 10_000) }),
    ];
    expect(selectEligible(docs, NOW).map((d) => d.id)).toEqual(['c']);
  });

  it('breaks created_at ties by document id', () => {
    const docs = [doc('z', '1', NOW - 1000), doc('y', '2', NOW - 1000)];
    expect(selectEligible(docs, NOW).map((d) => d.id)).toEqual(['y', 'z']);
  });

  it('ignores terminal statuses entirely', () => {
    const docs = [doc('a', '1', NOW - 2000, { status: 'dead_letter' }), doc('b', '1', NOW - 1000)];
    expect(selectEligible(docs, NOW).map((d) => d.id)).toEqual(['b']);
  });

  it('keys documents without ids by document id', () => {
    expect(orderingKey({ id: 'x' })).toBe('doc:x');
    expect(orderingKey({ id: 'x', chat_id: '-1', message_id: 5 })).toBe('-1_5');
  });
});

describe('appendHistory', () => {
  it('keeps the last entries and truncates detail', () => {
    let h = appendHistory(undefined, { attempt: 1, at: iso(NOW), result: 'retry', detail: 'x'.repeat(2000) });
    expect(h[0].detail?.length).toBe(500);
    for (let i = 2; i <= 15; i += 1) h = appendHistory(h, { attempt: i, at: iso(NOW), result: 'retry' });
    expect(h).toHaveLength(MAX_HISTORY);
    expect(h[0].attempt).toBe(6);
  });
});

describe('operator recovery', () => {
  const dead = state({ status: 'dead_letter', attempts: 8, last_error: 'gate_error' });

  it('allows a requeue of a dead letter when no later event of the key was handled', () => {
    expect(requeueDecision(dead, [])).toEqual({ ok: true });
    expect(requeueDecision(dead, [{ autotrader: state() }, { autotrader: state({ status: 'dead_letter' }) }])).toEqual({ ok: true });
  });

  it('refuses a requeue that would replay an older event after a newer one was handled', () => {
    expect(requeueDecision(dead, [{ autotrader: state({ status: 'done' }) }])).toEqual({ ok: false, reason: 'superseded' });
    expect(requeueDecision(dead, [{ autotrader: state({ status: 'processing' }) }])).toEqual({ ok: false, reason: 'later_event_in_progress' });
  });

  it('refuses anything that is not a dead letter', () => {
    expect(requeueDecision(state(), [])).toEqual({ ok: false, reason: 'not_dead_letter' });
    expect(requeueDecision(null, [])).toEqual({ ok: false, reason: 'not_dead_letter' });
  });

  it('requeue resets attempts and records the actor; discard is terminal', () => {
    const r = requeuePatch(dead, 'ops@example.com', iso(NOW));
    expect(r).toMatchObject({ status: 'pending', attempts: 0, next_attempt_at: iso(NOW), requeue_count: 1, requeued_by: 'ops@example.com' });
    expect(r.last_error).toBe('gate_error');
    const d = discardPatch(dead, 'ops@example.com', iso(NOW), 'stale');
    expect(d).toMatchObject({ status: 'discarded', discarded_by: 'ops@example.com', discard_note: 'stale' });
    expect(claimDecision(d, NOW).claim).toBe(false);
  });
});
