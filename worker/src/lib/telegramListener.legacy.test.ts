import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTelegramSignal } from './telegramParser.js';

// Accepted by the legacy Bybit parser, rejected by the gold parser.
const LEGACY_TEXT = 'BTCUSDT LONG NOW\nSL: 60000\nTP 61000\nTP 62000\nTP 63000';

function buildHarness() {
  const registrations: Array<{ eventName: string; handler: (event: unknown) => Promise<void> }> = [];
  const messageSet = vi.fn(async () => undefined);
  const forwardGoldSignal = vi.fn(async () => true);
  const publishSignalEvent = vi.fn(async () => true);

  const firestore = {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ get: vi.fn(async () => ({ exists: false })), set: messageSet })),
    })),
    doc: vi.fn(() => ({
      get: vi.fn(async () => ({ data: () => ({ telegram: { blocked_chat_ids: [] } }) })),
      set: vi.fn(async () => undefined),
    })),
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
  vi.doMock('./signalForwarding', () => ({ forwardGoldSignal }));
  vi.doMock('./signalEvents', () => ({ publishSignalEvent }));

  return { registrations, messageSet, forwardGoldSignal, publishSignalEvent };
}

beforeEach(() => {
  vi.resetModules();
});

describe('forwarder does not place broker orders', () => {
  it('does not execute a message the legacy parser accepts', async () => {
    expect(parseTelegramSignal(LEGACY_TEXT).ok).toBe(true);

    const harness = buildHarness();
    const { startTelegramListener } = await import('./telegramListener.js');
    await startTelegramListener();

    const newMessage = harness.registrations.find((r) => r.eventName === 'NewMessage')!;
    await newMessage.handler({
      message: {
        message: LEGACY_TEXT,
        id: 42,
        peerId: { channelId: 3271337051n },
        date: 1790251462,
        out: false,
      },
    });

    // Still recorded in the message history with its legacy parse, but never forwarded or executed.
    expect(harness.messageSet).toHaveBeenCalledWith(expect.objectContaining({ parsed_ok: true }));
    expect(harness.forwardGoldSignal).not.toHaveBeenCalled();
    expect(harness.publishSignalEvent).not.toHaveBeenCalled();
  });

  it('the legacy Bybit execution modules are gone', () => {
    for (const name of ['tradeEngine', 'bybitClient', 'bybitSecrets', 'tradeSizing', 'tradingSettings']) {
      expect(existsSync(resolve(__dirname, `${name}.ts`)), name).toBe(false);
    }
  });

  it('keeps the forwarder source free of any trade engine import', () => {
    const source = readFileSync(resolve(__dirname, 'telegramListener.ts'), 'utf8');
    expect(source).not.toContain('tradeEngine');
    expect(source).not.toContain('handleParsedSignal');
    expect(source).not.toContain('mt5TradeEngine');
    expect(source).not.toContain('handleGoldSignal');
  });
});
