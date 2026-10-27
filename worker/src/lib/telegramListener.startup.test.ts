import { beforeEach, describe, expect, it, vi } from 'vitest';

function buildHarness() {
  const registrations: Array<{ eventName: string }> = [];
  const client = {
    getMe: vi.fn(async () => ({ id: 1n })),
    addEventHandler: vi.fn((_handler: unknown, event: { constructor?: { name?: string } }) => {
      registrations.push({ eventName: event?.constructor?.name ?? 'unknown' });
    }),
  };
  const getTelegramStatus = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { status: 'authorized', phone: null, lastError: null, reauthRequired: false };
  });
  const getTelegramClient = vi.fn(async () => client);

  vi.doMock('./telegramClient', () => ({ getTelegramStatus, getTelegramClient }));
  vi.doMock('./firestoreAdmin', () => ({ initFirestore: vi.fn(() => null) }));
  vi.doMock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
  vi.doMock('./systemLog', () => ({ writeSystemLog: vi.fn(async () => undefined) }));
  vi.doMock('./signalForwarding', () => ({ forwardGoldSignal: vi.fn(async () => true) }));
  vi.doMock('./signalEvents', () => ({ publishSignalEvent: vi.fn(async () => true) }));

  return { registrations, client, getTelegramStatus, getTelegramClient };
}

beforeEach(() => {
  vi.resetModules();
});

describe('startTelegramListener startup', () => {
  it('registers handlers once when called concurrently', async () => {
    const harness = buildHarness();
    const { startTelegramListener } = await import('./telegramListener.js');

    await Promise.all([startTelegramListener(), startTelegramListener()]);

    expect(harness.getTelegramStatus).toHaveBeenCalledTimes(1);
    expect(harness.client.addEventHandler).toHaveBeenCalledTimes(3);
    expect(harness.registrations.map((r) => r.eventName)).toEqual(['NewMessage', 'EditedMessage', 'Raw']);

    await startTelegramListener();
    expect(harness.client.addEventHandler).toHaveBeenCalledTimes(3);
  });

  it('lets a later call retry after a failed start', async () => {
    const harness = buildHarness();
    harness.getTelegramClient.mockRejectedValueOnce(new Error('client unavailable'));
    const { startTelegramListener } = await import('./telegramListener.js');

    await expect(startTelegramListener()).rejects.toThrow('client unavailable');
    expect(harness.client.addEventHandler).not.toHaveBeenCalled();

    await startTelegramListener();
    expect(harness.client.addEventHandler).toHaveBeenCalledTimes(3);
  });
});
