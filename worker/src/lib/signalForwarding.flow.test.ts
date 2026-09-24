import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoldSignal } from './vipSignalParser';

const SIGNAL: GoldSignal = {
  symbol: 'XAUUSD',
  direction: 'sell',
  orderType: 'market',
  entryLow: 4028,
  entryHigh: 4032,
  stopLoss: 4040,
  takeProfits: [4020, 4013, 4005, 3987],
};

const CORRECTED: GoldSignal = { ...SIGNAL, stopLoss: 4045 };

const SOURCE = '-1003271337051';
const TARGET = '-1002350471397';

type SendCall = { chatId: string; text: string };

function buildHarness(options: { telegram?: Record<string, unknown> } = {}) {
  const sends: SendCall[] = [];
  const store = new Map<string, Record<string, unknown>>();

  const client = {
    getEntity: vi.fn(async (chatId: string) => ({ id: chatId })),
    sendMessage: vi.fn(async (entity: { id: string }, payload: { message: string }) => {
      sends.push({ chatId: entity.id, text: payload.message });
    }),
  };

  const collection = {
    doc: vi.fn((id: string) => ({
      get: vi.fn(async () => {
        const key = id;
        return {
          exists: store.has(key),
          data: () => store.get(key),
        };
      }),
      set: vi.fn(async (data: Record<string, unknown>) => {
        store.set(id, data);
      }),
    })),
  };

  const firestore = {
    doc: vi.fn(() => ({
      get: vi.fn(async () => ({
        exists: true,
        data: () => ({ telegram: options.telegram ?? {} }),
      })),
    })),
    collection: vi.fn(() => collection),
  };

  vi.doMock('./telegramClient', () => ({
    getTelegramClient: vi.fn(async () => client),
  }));
  vi.doMock('./firestoreAdmin', () => ({
    initFirestore: vi.fn(() => firestore),
  }));
  vi.doMock('./logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));
  vi.doMock('./systemLog', () => ({
    writeSystemLog: vi.fn(async () => undefined),
  }));

  return { sends, store, client };
}

async function loadForwarder() {
  return import('./signalForwarding.js');
}

beforeEach(() => {
  vi.resetModules();
});

describe('forwardGoldSignal', () => {
  it('forwards a source signal to the target and records revision 0', async () => {
    const harness = buildHarness();
    const { forwardGoldSignal } = await loadForwarder();

    const forwarded = await forwardGoldSignal(SOURCE, '2500', SIGNAL, 'hash-a');

    expect(forwarded).toBe(true);
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0].chatId).toBe(TARGET);
    expect(harness.sends[0].text).toContain('🔴 SELL XAUUSD');
    expect(harness.sends[0].text).not.toContain('CORRECTION');

    const record = harness.store.get(`${SOURCE}_2500`);
    expect(record?.revision).toBe(0);
    expect(record?.last_hash).toBe('hash-a');
    expect(record?.correction).toBe(false);
  });

  it('ignores chats that are not configured signal sources', async () => {
    const harness = buildHarness();
    const { forwardGoldSignal } = await loadForwarder();

    expect(await forwardGoldSignal('-1009999999999', '1', SIGNAL, 'h')).toBe(false);
    expect(harness.sends).toHaveLength(0);
  });

  it('does not resend the same revision of a signal', async () => {
    const harness = buildHarness();
    const { forwardGoldSignal } = await loadForwarder();

    expect(await forwardGoldSignal(SOURCE, '2500', SIGNAL, 'hash-a')).toBe(true);
    expect(await forwardGoldSignal(SOURCE, '2500', SIGNAL, 'hash-a')).toBe(false);
    expect(harness.sends).toHaveLength(1);
  });

  it('forwards an edit as a labelled correction', async () => {
    const harness = buildHarness();
    const { forwardGoldSignal } = await loadForwarder();

    await forwardGoldSignal(SOURCE, '2500', SIGNAL, 'hash-a');
    const forwardedEdit = await forwardGoldSignal(SOURCE, '2500', CORRECTED, 'hash-b');

    expect(forwardedEdit).toBe(true);
    expect(harness.sends).toHaveLength(2);
    expect(harness.sends[1].text).toContain('♻️ CORRECTION');
    expect(harness.sends[1].text).toContain('SL: 4045');

    const record = harness.store.get(`${SOURCE}_2500`);
    expect(record?.revision).toBe(1);
    expect(record?.correction).toBe(true);
    expect(record?.last_hash).toBe('hash-b');
  });

  it('honors a disabled flag and a custom target from settings', async () => {
    const disabled = buildHarness({ telegram: { signal_forward_enabled: false } });
    const { forwardGoldSignal } = await loadForwarder();
    expect(await forwardGoldSignal(SOURCE, '2500', SIGNAL, 'h1')).toBe(false);
    expect(disabled.sends).toHaveLength(0);

    vi.resetModules();
    const custom = buildHarness({ telegram: { forward_chat_id: '-1001234567890' } });
    const { forwardGoldSignal: forwarder } = await loadForwarder();
    expect(await forwarder(SOURCE, '2501', SIGNAL, 'h2')).toBe(true);
    expect(custom.sends[0].chatId).toBe('-1001234567890');
  });
});
