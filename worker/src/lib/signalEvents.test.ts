import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignalEventInput } from './signalEvents.js';

const SIGNAL = {
  symbol: 'XAUUSD',
  direction: 'sell' as const,
  orderType: 'market' as const,
  entryLow: 4028,
  entryHigh: 4032,
  stopLoss: 4040,
  takeProfits: [4020, 4013, 4005],
};

const BASE_INPUT: SignalEventInput = {
  chatId: '-1003271337051',
  messageId: '3664',
  messageType: 'new',
  textHash: 'hash-a',
  kind: 'signal',
  signal: SIGNAL,
  messageDate: new Date('2026-10-18T00:00:00.000Z'),
};

function buildHarness(options: { firestore?: boolean; create?: (data: Record<string, unknown>) => Promise<void> } = {}) {
  const create = vi.fn(options.create ?? (async () => undefined));
  const doc = vi.fn(() => ({ create }));
  const collection = vi.fn(() => ({ doc }));
  const firestore = options.firestore === false ? null : { collection };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const writeSystemLog = vi.fn(async () => true);

  vi.doMock('./firestoreAdmin', () => ({ initFirestore: vi.fn(() => firestore) }));
  vi.doMock('./logger', () => ({ logger }));
  vi.doMock('./systemLog', () => ({ writeSystemLog }));

  return { create, doc, collection, logger, writeSystemLog };
}

async function load() {
  return import('./signalEvents.js');
}

function alreadyExists(): Error {
  return Object.assign(new Error('6 ALREADY_EXISTS: document already exists'), { code: 6 });
}

beforeEach(() => {
  vi.resetModules();
  vi.useRealTimers();
});

describe('publishSignalEvent', () => {
  it('creates the document with snake_case fields and omits unset cancel fields', async () => {
    const harness = buildHarness();
    const { publishSignalEvent } = await load();

    expect(await publishSignalEvent(BASE_INPUT)).toBe(true);

    expect(harness.collection).toHaveBeenCalledWith('signal_events');
    expect(harness.doc).toHaveBeenCalledWith('-1003271337051_3664_hash-a');
    const data = harness.create.mock.calls[0][0];
    expect(data).toEqual({
      chat_id: '-1003271337051',
      message_id: '3664',
      message_type: 'new',
      text_hash: 'hash-a',
      kind: 'signal',
      signal: SIGNAL,
      message_date: '2026-10-18T00:00:00.000Z',
      created_at: expect.any(String),
      autotrader: {
        status: 'pending',
        attempts: 0,
        next_attempt_at: data.created_at,
        lease_id: null,
        lease_owner: null,
        lease_expires_at: null,
        updated_at: data.created_at,
      },
    });
    expect(Object.keys(data)).not.toContain('cancel_reason');
    expect(Object.keys(data)).not.toContain('trigger_message_id');
  });

  it('stores cancel_reason and trigger_message_id when provided', async () => {
    const harness = buildHarness();
    const { publishSignalEvent } = await load();

    expect(
      await publishSignalEvent({
        ...BASE_INPUT,
        kind: 'cancel',
        signal: null,
        messageId: '3664',
        cancelReason: 'explicit_cancel',
        triggerMessageId: '3700',
      }),
    ).toBe(true);

    expect(harness.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ kind: 'cancel', signal: null, cancel_reason: 'explicit_cancel', trigger_message_id: '3700' }),
    );
  });

  it('treats ALREADY_EXISTS as success without retrying or logging an error', async () => {
    const harness = buildHarness({ create: async () => Promise.reject(alreadyExists()) });
    const { publishSignalEvent } = await load();

    expect(await publishSignalEvent(BASE_INPUT)).toBe(true);
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(harness.logger.error).not.toHaveBeenCalled();
    expect(harness.writeSystemLog).not.toHaveBeenCalled();
  });

  it('recognises ALREADY_EXISTS from the message when no code is present', async () => {
    const harness = buildHarness({ create: async () => Promise.reject(new Error('ALREADY_EXISTS: exists')) });
    const { publishSignalEvent } = await load();

    expect(await publishSignalEvent(BASE_INPUT)).toBe(true);
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and succeeds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const harness = buildHarness({
      create: async () => {
        calls += 1;
        if (calls === 1) throw new Error('UNAVAILABLE: try again');
      },
    });
    const { publishSignalEvent } = await load();

    const pending = publishSignalEvent(BASE_INPUT);
    await vi.runAllTimersAsync();

    expect(await pending).toBe(true);
    expect(harness.create).toHaveBeenCalledTimes(2);
    expect(harness.logger.error).not.toHaveBeenCalled();
  });

  it('gives up after three attempts and reports the failure', async () => {
    vi.useFakeTimers();
    const harness = buildHarness({ create: async () => Promise.reject(new Error('UNAVAILABLE: down')) });
    const { publishSignalEvent } = await load();

    const pending = publishSignalEvent({ ...BASE_INPUT, kind: 'cancel', signal: null });
    await vi.runAllTimersAsync();

    expect(await pending).toBe(false);
    expect(harness.create).toHaveBeenCalledTimes(3);
    expect(harness.logger.error).toHaveBeenCalledWith(
      'signal_event_publish_failed',
      expect.objectContaining({ chatId: '-1003271337051', messageId: '3664', kind: 'cancel', attempts: 3 }),
    );
    expect(harness.writeSystemLog).toHaveBeenCalledWith(
      'error',
      'signal_events',
      'signal_event_publish_failed',
      expect.objectContaining({ chatId: '-1003271337051', messageId: '3664', error: 'UNAVAILABLE: down' }),
    );
  });

  it('returns false without writing when Firestore is not configured', async () => {
    const harness = buildHarness({ firestore: false });
    const { publishSignalEvent } = await load();

    expect(await publishSignalEvent(BASE_INPUT)).toBe(false);
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.logger.warn).toHaveBeenCalledWith('signal_event_publish_skipped', expect.any(Object));
  });
});
