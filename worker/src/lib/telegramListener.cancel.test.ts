import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CHANNEL_ID = 3271337051n;
const CHAT_ID = '-1003271337051';
const GOLD_TEXT = `SELL POSITION XAUUSD🚨

OPEN : 4258.5-4261
SL : 4264
TP1 : 4254
TP2 : 4247
TP3 : 4240`;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function buildHarness(options: { publishResult?: boolean } = {}) {
  const registrations: Array<{ eventName: string; handler: (event: { message?: unknown }) => Promise<void> }> = [];
  const publishSignalEvent = vi.fn(async () => options.publishResult ?? true);
  const forwardGoldSignal = vi.fn(async () => true);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const writeSystemLog = vi.fn(async () => undefined);

  const firestore = {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ get: vi.fn(async () => ({ exists: false })), set: vi.fn(async () => undefined) })),
    })),
    doc: vi.fn(() => ({
      get: vi.fn(async () => ({ data: () => ({ telegram: { blocked_chat_ids: [] } }) })),
      set: vi.fn(async () => undefined),
    })),
  };

  const client = {
    getMe: vi.fn(async () => ({ id: 1n })),
    addEventHandler: vi.fn((handler: (event: { message?: unknown }) => Promise<void>, event: { constructor?: { name?: string } }) => {
      registrations.push({ eventName: event?.constructor?.name ?? 'unknown', handler });
    }),
  };

  vi.doMock('./telegramClient', () => ({
    getTelegramStatus: vi.fn(async () => ({ status: 'authorized', phone: null, lastError: null, reauthRequired: false })),
    getTelegramClient: vi.fn(async () => client),
  }));
  vi.doMock('./firestoreAdmin', () => ({ initFirestore: vi.fn(() => firestore) }));
  vi.doMock('./logger', () => ({ logger }));
  vi.doMock('./systemLog', () => ({ writeSystemLog }));
  vi.doMock('./signalForwarding', () => ({ forwardGoldSignal }));
  vi.doMock('./signalEvents', () => ({ publishSignalEvent }));

  return { registrations, publishSignalEvent, forwardGoldSignal, logger, writeSystemLog };
}

function channelMessage(id: number, text: string, extra: Record<string, unknown> = {}) {
  return { message: text, id, peerId: { channelId: CHANNEL_ID }, date: 1790251462, out: false, ...extra };
}

async function dispatch(
  harness: ReturnType<typeof buildHarness>,
  eventName: 'NewMessage' | 'EditedMessage',
  message: unknown,
) {
  const registration = harness.registrations.find((r) => r.eventName === eventName)!;
  await registration.handler({ message });
}

async function startListener() {
  const { startTelegramListener } = await import('./telegramListener.js');
  await startTelegramListener();
}

beforeEach(() => {
  vi.resetModules();
});

describe('edited messages', () => {
  it('publishes an unparseable_edit cancel when an edit no longer parses', async () => {
    const harness = buildHarness();
    await startListener();

    const text = 'Market is moving, watching closely';
    await dispatch(harness, 'EditedMessage', channelMessage(3664, text));

    expect(harness.publishSignalEvent).toHaveBeenCalledTimes(1);
    expect(harness.publishSignalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: CHAT_ID,
        messageId: '3664',
        messageType: 'edit',
        textHash: sha256(text),
        kind: 'cancel',
        signal: null,
        cancelReason: 'unparseable_edit',
      }),
    );
  });

  it('publishes an explicit_cancel cancel when an edit says cancelled', async () => {
    const harness = buildHarness();
    await startListener();

    await dispatch(harness, 'EditedMessage', channelMessage(3664, 'Signal cancelled ❌'));

    expect(harness.publishSignalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: '3664', kind: 'cancel', cancelReason: 'explicit_cancel' }),
    );
  });
});

describe('new reply cancels', () => {
  it('targets the replied-to signal for a reply that says cancel', async () => {
    const harness = buildHarness();
    await startListener();

    const text = 'Cancel this signal';
    await dispatch(
      harness,
      'NewMessage',
      channelMessage(3700, text, { replyTo: { replyToMsgId: 3664 } }),
    );

    expect(harness.publishSignalEvent).toHaveBeenCalledTimes(1);
    expect(harness.publishSignalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: CHAT_ID,
        messageId: '3664',
        messageType: 'new',
        textHash: sha256(text),
        kind: 'cancel',
        signal: null,
        cancelReason: 'explicit_cancel',
        triggerMessageId: '3700',
      }),
    );
  });

  it('does not publish a cancel for an untargeted cancel message', async () => {
    const harness = buildHarness();
    await startListener();

    await dispatch(harness, 'NewMessage', channelMessage(3701, 'cancel'));

    expect(harness.publishSignalEvent).not.toHaveBeenCalled();
    expect(harness.logger.info).toHaveBeenCalledWith(
      'cancel_intent_untargeted',
      expect.objectContaining({ chatId: CHAT_ID, messageId: '3701' }),
    );
  });

  it('does not publish for a reply that is not a cancel', async () => {
    const harness = buildHarness();
    await startListener();

    await dispatch(
      harness,
      'NewMessage',
      channelMessage(3702, 'TP1 hit, moving SL to entry', { replyTo: { replyToMsgId: 3664 } }),
    );

    expect(harness.publishSignalEvent).not.toHaveBeenCalled();
  });

  it('keeps forwarding and publishing a valid signal unchanged', async () => {
    const harness = buildHarness();
    await startListener();

    await dispatch(harness, 'NewMessage', channelMessage(3664, GOLD_TEXT));

    expect(harness.forwardGoldSignal).toHaveBeenCalledWith(CHAT_ID, '3664', expect.any(Object), sha256(GOLD_TEXT));
    expect(harness.publishSignalEvent).toHaveBeenCalledTimes(1);
    expect(harness.publishSignalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'signal', messageId: '3664', messageType: 'new' }),
    );
  });
});

describe('publish failure reporting', () => {
  it('logs twice at error level with chat and message ids when a publish fails', async () => {
    const harness = buildHarness({ publishResult: false });
    await startListener();

    await dispatch(harness, 'NewMessage', channelMessage(3664, GOLD_TEXT));

    expect(harness.logger.error).toHaveBeenCalledWith(
      'telegram_signal_event_not_published',
      expect.objectContaining({ chatId: CHAT_ID, messageId: '3664', kind: 'signal' }),
    );
    expect(harness.writeSystemLog).toHaveBeenCalledWith(
      'error',
      'telegram_listener',
      'signal_event_not_published',
      expect.objectContaining({ chatId: CHAT_ID, messageId: '3664', kind: 'signal' }),
    );
  });
});
