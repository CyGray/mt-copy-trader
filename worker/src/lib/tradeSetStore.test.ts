import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fs: null as unknown }));

vi.mock('./firestoreAdmin', () => ({ initFirestore: () => h.fs }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { createFakeFirestore, type FakeFirestore } from './testing/fakeFirestore.js';
import {
  PersistenceUnavailableError,
  createTradeSet,
  getTradeSet,
  listTradeSetsByState,
  requireFirestore,
  stripUndefined,
  transitionTradeSet,
  updateTradeSet,
} from './tradeSetStore.js';
import type { TradeSetDoc } from './tradeSetTypes.js';

function fs(): FakeFirestore {
  return h.fs as FakeFirestore;
}

function trade(id: string, over: Record<string, unknown> = {}): TradeSetDoc {
  return {
    schema: 2,
    trade_set_id: id,
    chat_id: '-100',
    message_id: id,
    event_id: `${id}_event`,
    signal: null,
    signal_revisions: [],
    symbol: 'XAUUSD',
    broker_symbol: 'XAUUSD',
    direction: 'buy',
    order_type: 'BUY',
    mode: 'demo',
    broker: 'mt5',
    profile: null,
    profile_snapshot: null,
    limits_snapshot: null,
    state: 'CLAIMED',
    correlation_comment: 'BT-000000000000',
    claim: { attempts: 1, claimed_at: '2026-10-18T00:00:00.000Z', owner: 'test:1' },
    plan: null,
    submission: null,
    broker_refs: null,
    lifecycle: null,
    result: null,
    created_at: '2026-10-18T00:00:00.000Z',
    updated_at: '2026-10-18T00:00:00.000Z',
    ...over,
  } as unknown as TradeSetDoc;
}

describe('tradeSetStore', () => {
  beforeEach(() => {
    h.fs = createFakeFirestore();
  });

  describe('requireFirestore', () => {
    it('throws PersistenceUnavailableError when no client is configured', () => {
      h.fs = null;
      expect(() => requireFirestore()).toThrow(PersistenceUnavailableError);
    });

    it('returns the client when configured', () => {
      expect(requireFirestore()).toBe(h.fs);
    });
  });

  describe('stripUndefined', () => {
    it('removes undefined keys deeply, keeps null and falsy values', () => {
      const out = stripUndefined({
        a: undefined,
        b: null,
        c: 0,
        d: '',
        e: { f: undefined, g: [1, undefined, { h: undefined, i: false }] },
      });
      expect(out).toEqual({ b: null, c: 0, d: '', e: { g: [1, { i: false }] } });
      expect('a' in out).toBe(false);
    });
  });

  describe('createTradeSet', () => {
    it('creates once, then reports exists for the same id', async () => {
      await expect(createTradeSet(trade('-100_1'))).resolves.toBe('created');
      await expect(createTradeSet(trade('-100_1'))).resolves.toBe('exists');
      expect(fs().peek('trade_sets/-100_1')?.state).toBe('CLAIMED');
    });

    it('rethrows errors other than ALREADY_EXISTS', async () => {
      fs().failNext('create', new Error('network down'));
      await expect(createTradeSet(trade('-100_2'))).rejects.toThrow('network down');
      expect(fs().peek('trade_sets/-100_2')).toBeUndefined();
    });

    it('throws PersistenceUnavailableError without a client', async () => {
      h.fs = null;
      await expect(createTradeSet(trade('-100_3'))).rejects.toBeInstanceOf(PersistenceUnavailableError);
    });
  });

  describe('getTradeSet', () => {
    it('returns null for a missing doc and the stored doc otherwise', async () => {
      await expect(getTradeSet('missing')).resolves.toBeNull();
      await createTradeSet(trade('-100_4'));
      const doc = await getTradeSet('-100_4');
      expect(doc?.trade_set_id).toBe('-100_4');
      expect(doc?.state).toBe('CLAIMED');
    });
  });

  describe('updateTradeSet', () => {
    it('merges the patch and stamps updated_at', async () => {
      await createTradeSet(trade('-100_5'));
      await updateTradeSet('-100_5', { state: 'SKIPPED', skip_reason: 'spread_too_wide', ignored: undefined });
      const stored = fs().peek('trade_sets/-100_5') ?? {};
      expect(stored.state).toBe('SKIPPED');
      expect(stored.skip_reason).toBe('spread_too_wide');
      expect(stored.claim).toEqual({ attempts: 1, claimed_at: '2026-10-18T00:00:00.000Z', owner: 'test:1' });
      expect(stored.updated_at).not.toBe('2026-10-18T00:00:00.000Z');
      expect('ignored' in stored).toBe(false);
    });

    it('throws when the write fails', async () => {
      fs().failNext('set', new Error('write refused'));
      await expect(updateTradeSet('-100_6', { state: 'ERROR' })).rejects.toThrow('write refused');
    });
  });

  describe('transitionTradeSet', () => {
    it('applies the patch when the state is one of fromStates', async () => {
      await createTradeSet(trade('-100_7'));
      const moved = await transitionTradeSet('-100_7', ['CLAIMED', 'SUBMITTING'], { state: 'SUBMITTING' });
      expect(moved).toBe(true);
      expect(fs().peek('trade_sets/-100_7')?.state).toBe('SUBMITTING');
    });

    it('refuses without writing when the state is not in fromStates', async () => {
      await createTradeSet(trade('-100_8', { state: 'OPEN' }));
      const writesBefore = fs().writes.length;
      const moved = await transitionTradeSet('-100_8', ['CLAIMED'], { state: 'SKIPPED' });
      expect(moved).toBe(false);
      expect(fs().peek('trade_sets/-100_8')?.state).toBe('OPEN');
      expect(fs().writes.length).toBe(writesBefore);
    });

    it('returns false for a missing doc', async () => {
      await expect(transitionTradeSet('nope', ['CLAIMED'], { state: 'ERROR' })).resolves.toBe(false);
    });

    it('is a single winner under two competing transitions', async () => {
      await createTradeSet(trade('-100_9'));
      const results = await Promise.all([
        transitionTradeSet('-100_9', ['CLAIMED'], { state: 'SUBMITTING', order_type: 'BUY' }),
        transitionTradeSet('-100_9', ['CLAIMED'], { state: 'SKIPPED', skip_reason: 'x' }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe('listTradeSetsByState', () => {
    it('returns schema-2 docs in the requested states only', async () => {
      await createTradeSet(trade('-100_10', { state: 'OPEN' }));
      await createTradeSet(trade('-100_11', { state: 'CLOSED' }));
      await createTradeSet(trade('-100_12', { state: 'PENDING_ORDER' }));
      fs().seed('trade_sets/legacy_1', { schema: 1, state: 'ENTRY_PLACED', chat_id: '-100' });

      const found = await listTradeSetsByState(['OPEN', 'PENDING_ORDER', 'ENTRY_PLACED' as never]);
      expect(found.map((d) => d.trade_set_id).sort()).toEqual(['-100_10', '-100_12']);
    });

    it('returns [] for an empty state list without querying', async () => {
      await expect(listTradeSetsByState([])).resolves.toEqual([]);
    });
  });

  describe('fake firestore semantics relied on by the store tests', () => {
    it('rolls back a transaction whose function throws', async () => {
      fs().seed('demo/a', { v: 1 });
      await expect(
        fs().runTransaction(async (tx) => {
          tx.set(fs().collection('demo').doc('a'), { v: 2 }, { merge: true });
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(fs().peek('demo/a')).toEqual({ v: 1 });
    });

    it('rejects undefined field values like Firestore does', async () => {
      await expect(fs().collection('demo').doc('b').set({ v: undefined })).rejects.toThrow(/undefined/);
    });
  });
});
