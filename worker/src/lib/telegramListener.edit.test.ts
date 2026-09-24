import { beforeEach, describe, expect, it, vi } from 'vitest';

type Registration = { eventName: string; handler: unknown };

function buildHarness() {
  const registrations: Registration[] = [];
  const client = {
    getMe: vi.fn(async () => ({ id: 1n })),
    addEventHandler: vi.fn((handler: unknown, event: { constructor?: { name?: string } }) => {
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
    initFirestore: vi.fn(() => null),
    getFirestore: vi.fn(() => null),
  }));
  vi.doMock('./logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));
  vi.doMock('./systemLog', () => ({
    writeSystemLog: vi.fn(async () => undefined),
  }));
  vi.doMock('./tradeEngine', () => ({
    handleParsedSignal: vi.fn(async () => undefined),
  }));

  return { registrations, client };
}

async function loadListener() {
  return import('./telegramListener.js');
}

beforeEach(() => {
  vi.resetModules();
});

describe('startTelegramListener', () => {
  it('subscribes to new messages, edits and raw updates', async () => {
    const harness = buildHarness();
    const { startTelegramListener } = await loadListener();

    await startTelegramListener();

    const eventNames = harness.registrations.map((entry) => entry.eventName);
    expect(eventNames).toEqual(['NewMessage', 'EditedMessage', 'Raw']);
    expect(harness.client.addEventHandler).toHaveBeenCalledTimes(3);
  });
});
