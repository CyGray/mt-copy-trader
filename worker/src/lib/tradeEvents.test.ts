import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ firestore: null as unknown }));

vi.mock('./firestoreAdmin', () => ({ initFirestore: vi.fn(() => fake.firestore) }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';
import { listTradeEvents, recordTradeEvent } from './tradeEvents.js';

type Row = Record<string, unknown>;

/** Mirrors Firestore: undefined values are rejected by the write. */
function assertNoUndefined(value: unknown, path = 'doc'): void {
  if (value === undefined) {
    throw Object.assign(new Error(`Cannot use "undefined" at ${path}`), { code: 3 });
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoUndefined(item, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) assertNoUndefined(inner, `${path}.${key}`);
  }
}

function makeFakeFirestore() {
  const collections = new Map<string, Map<string, Row>>();
  const docsOf = (name: string) => {
    let docs = collections.get(name);
    if (!docs) {
      docs = new Map();
      collections.set(name, docs);
    }
    return docs;
  };

  const firestore = {
    collection: vi.fn((name: string) => ({
      doc: (id: string) => ({
        create: vi.fn(async (data: Row) => {
          assertNoUndefined(data);
          const docs = docsOf(name);
          if (docs.has(id)) {
            throw Object.assign(new Error('6 ALREADY_EXISTS: document already exists'), { code: 6 });
          }
          docs.set(id, structuredClone(data));
        }),
      }),
      where: (field: string, _op: string, value: unknown) => ({
        orderBy: (orderField: string) => ({
          get: vi.fn(async () => {
            const rows = [...docsOf(name).entries()]
              .filter(([, data]) => data[field] === value)
              .sort(([, a], [, b]) => String(a[orderField]).localeCompare(String(b[orderField])));
            return { docs: rows.map(([id, data]) => ({ id, data: () => data })) };
          }),
        }),
      }),
    })),
  };

  return { firestore, docsOf };
}

describe('recordTradeEvent', () => {
  let fakeDb: ReturnType<typeof makeFakeFirestore>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T10:00:00.000Z'));
    fakeDb = makeFakeFirestore();
    fake.firestore = fakeDb.firestore;
  });

  afterEach(() => {
    vi.useRealTimers();
    fake.firestore = null;
  });

  it('writes a deterministic document id with snake_case fields and an ISO timestamp', async () => {
    const ok = await recordTradeEvent({
      tradeSetId: '-100_42',
      eventKey: 'entry_submitted',
      type: 'entry_submitted',
      mode: 'demo',
      profileDocId: null,
      profileVersion: 3,
      reasonCode: 'ok',
      message: 'sent',
      orderTicket: 11,
      positionTicket: 12,
      dealTicket: 13,
      volume: 0.05,
      price: 4000.5,
      sl: 4010,
      tp: 3990,
      realizedPnl: 1.25,
      retcode: 10009,
      details: { attempt: 1 },
    });

    expect(ok).toBe(true);
    const row = fakeDb.docsOf('trade_events').get('-100_42__entry_submitted');
    expect(row).toEqual({
      trade_set_id: '-100_42',
      event_key: 'entry_submitted',
      type: 'entry_submitted',
      timestamp: '2026-10-18T10:00:00.000Z',
      mode: 'demo',
      profile_doc_id: null,
      profile_version: 3,
      reason_code: 'ok',
      message: 'sent',
      order_ticket: 11,
      position_ticket: 12,
      deal_ticket: 13,
      volume: 0.05,
      price: 4000.5,
      sl: 4010,
      tp: 3990,
      realized_pnl: 1.25,
      retcode: 10009,
      details: { attempt: 1 },
    });
  });

  it('returns false for a duplicate event key and keeps the first write', async () => {
    const first = await recordTradeEvent({ tradeSetId: 'ts', eventKey: 'k', type: 'signal_received', message: 'one' });
    const second = await recordTradeEvent({ tradeSetId: 'ts', eventKey: 'k', type: 'signal_received', message: 'two' });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(fakeDb.docsOf('trade_events').get('ts__k')?.message).toBe('one');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('treats an ALREADY_EXISTS message without a code as a duplicate', async () => {
    vi.mocked(initFirestore).mockReturnValueOnce({
      collection: () => ({
        doc: () => ({
          create: async () => {
            throw new Error('ALREADY_EXISTS: document exists');
          },
        }),
      }),
    } as never);

    expect(await recordTradeEvent({ tradeSetId: 'ts', eventKey: 'k', type: 'execution_error' })).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('sanitizes the event key in the document id and caps it at 120 characters', async () => {
    await recordTradeEvent({ tradeSetId: 'ts', eventKey: 'tp 1/2:x', type: 'tp_checkpoint_reached' });
    await recordTradeEvent({ tradeSetId: 'ts', eventKey: 'a.b-c_d', type: 'sl_modified' });
    await recordTradeEvent({ tradeSetId: 'ts', eventKey: 'x'.repeat(200), type: 'sl_modified' });

    const ids = [...fakeDb.docsOf('trade_events').keys()];
    expect(ids).toContain('ts__tp_1_2_x');
    expect(ids).toContain('ts__a.b-c_d');
    expect(ids).toContain(`ts__${'x'.repeat(120)}`);
  });

  it('strips undefined fields, including nested ones in details', async () => {
    const ok = await recordTradeEvent({
      tradeSetId: 'ts',
      eventKey: 'u',
      type: 'reconciliation',
      mode: undefined,
      price: undefined,
      details: { keep: 1, drop: undefined, nested: { a: undefined, b: 'x' } },
    });

    expect(ok).toBe(true);
    const row: Row = fakeDb.docsOf('trade_events').get('ts__u') ?? {};
    expect(row).not.toHaveProperty('mode');
    expect(row).not.toHaveProperty('price');
    expect(row.details).toEqual({ keep: 1, nested: { b: 'x' } });
  });

  it('returns false without throwing when Firestore is unavailable', async () => {
    fake.firestore = null;
    await expect(recordTradeEvent({ tradeSetId: 'ts', eventKey: 'k', type: 'signal_received' })).resolves.toBe(false);
  });

  it('returns false without throwing when initFirestore itself throws', async () => {
    vi.mocked(initFirestore).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(recordTradeEvent({ tradeSetId: 'ts', eventKey: 'k', type: 'signal_received' })).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'trade_event_write_failed',
      expect.objectContaining({ error: 'boom' }),
    );
  });

  it('logs and returns false on other write errors', async () => {
    vi.mocked(initFirestore).mockReturnValueOnce({
      collection: () => ({
        doc: () => ({
          create: async () => {
            throw Object.assign(new Error('14 UNAVAILABLE'), { code: 14 });
          },
        }),
      }),
    } as never);

    expect(await recordTradeEvent({ tradeSetId: 'ts', eventKey: 'k', type: 'entry_unknown' })).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'trade_event_write_failed',
      expect.objectContaining({ trade_set_id: 'ts', event_key: 'k', type: 'entry_unknown' }),
    );
  });
});

describe('listTradeEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    fake.firestore = null;
  });

  it('returns [] when Firestore is unavailable', async () => {
    fake.firestore = null;
    expect(await listTradeEvents('ts')).toEqual([]);
  });

  it('returns only the events of the requested trade set, ordered by timestamp', async () => {
    const db = makeFakeFirestore();
    fake.firestore = db.firestore;
    db.docsOf('trade_events').set('ts__b', { trade_set_id: 'ts', event_key: 'b', timestamp: '2026-10-18T10:00:02.000Z' });
    db.docsOf('trade_events').set('ts__a', { trade_set_id: 'ts', event_key: 'a', timestamp: '2026-10-18T10:00:01.000Z' });
    db.docsOf('trade_events').set('other__a', { trade_set_id: 'other', event_key: 'a', timestamp: '2026-10-18T10:00:00.000Z' });

    const rows = await listTradeEvents('ts');
    expect(rows.map((r) => r.event_key)).toEqual(['a', 'b']);
  });
});
