import { beforeEach, describe, expect, it, vi } from 'vitest';

const GOLD_TEXT = `SELL POSITION XAUUSD🚨

OPEN : 4258.5-4261
SL : 4264
TP1 : 4254
TP2 : 4247
TP3 : 4240
TP4 : 4225`;

function buildHarness() {
  const registrations: Array<{ eventName: string; handler: (event: unknown) => Promise<void> }> = [];

  const messageSet = vi.fn(async () => undefined);
  const messageGet = vi.fn(async () => ({ exists: false }));
  const settingsGet = vi.fn(async () => ({ data: () => ({ telegram: { blocked_chat_ids: [] } }) }));

  const firestore = {
    collection: vi.fn(() => ({ doc: vi.fn(() => ({ get: messageGet, set: messageSet })) })),
    doc: vi.fn(() => ({ get: settingsGet, set: vi.fn(async () => undefined) })),
  };

  const client = {
    getMe: vi.fn(async () => ({ id: 1n })),
    addEventHandler: vi.fn((handler: (event: unknown) => Promise<void>, event: { constructor?: { name?: string } }) => {
      registrations.push({ eventName: event?.constructor?.name ?? 'unknown', handler });
    }),
  };

  vi.doMock('./telegramClient', () => ({
    getTelegramStatus: vi.fn(async () => ({
      status: 'authorized',
      phone: null,
      lastError: null,
      reauthRequired: false,
    })),
    getTelegramClient: vi.fn(async () => client),
  }));
  vi.doMock('./firestoreAdmin', () => ({
    initFirestore: vi.fn(() => firestore),
    getFirestore: vi.fn(() => firestore),
  }));
  vi.doMock('./logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));
  vi.doMock('./systemLog', () => ({ writeSystemLog: vi.fn(async () => undefined) }));
  vi.doMock('./signalForwarding', () => ({ forwardGoldSignal: vi.fn(async () => true) }));
  vi.doMock('./signalEvents', () => ({ publishSignalEvent: vi.fn(async () => true) }));
  vi.doMock('./mt5TradeEngine', () => ({
    handleGoldSignal: vi.fn(async () => undefined),
    cancelGoldTrade: vi.fn(async () => undefined),
  }));

  return { registrations, firestore };
}

async function load() {
  return import('./telegramListener.js');
}

beforeEach(() => {
  vi.resetModules();
});

describe('forwarder listener hand-off', () => {
  it('publishes a signal event to the autotrader without executing MT5 itself', async () => {
    const { registrations } = buildHarness();
    const { startTelegramListener } = await load();
    await startTelegramListener();

    const newMessage = registrations.find((r) => r.eventName === 'NewMessage')!;
    expect(newMessage).toBeDefined();

    await newMessage.handler({
      message: {
        message: GOLD_TEXT,
        id: 3664,
        peerId: { channelId: 3271337051n },
        date: 1790251462,
        out: false,
      },
    });

    const { publishSignalEvent } = await import('./signalEvents.js');
    expect(publishSignalEvent).toHaveBeenCalledTimes(1);
    expect(publishSignalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-1003271337051',
        messageId: '3664',
        kind: 'signal',
      }),
    );

    const { handleGoldSignal, cancelGoldTrade } = await import('./mt5TradeEngine.js');
    expect(handleGoldSignal).not.toHaveBeenCalled();
    expect(cancelGoldTrade).not.toHaveBeenCalled();
  });
});
