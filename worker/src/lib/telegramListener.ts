import crypto from 'node:crypto';
import { NewMessage } from 'telegram/events';
import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';
import { writeSystemLog } from './systemLog';
import { parseTelegramSignal } from './telegramParser';
import { getTelegramClient, getTelegramStatus } from './telegramClient';
import { handleParsedSignal } from './tradeEngine';

let listenerStarted = false;
let lastSettingsFetch = 0;
let cachedAllowedChatIds: string[] | null = null;

const SETTINGS_DOC_PATH = 'settings/default';
const SETTINGS_TTL_MS = 60_000;

function isParseError(
  result: ReturnType<typeof parseTelegramSignal>,
): result is { ok: false; error: string } {
  return result.ok === false;
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function getMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const candidate = message as { message?: string; text?: string };
  return candidate.message ?? candidate.text ?? '';
}

function getChatId(message: unknown): string {
  if (!message || typeof message !== 'object') return 'unknown';
  const candidate = message as {
    chatId?: bigint | number | string;
    peerId?: { channelId?: number; chatId?: number; userId?: number };
  };
  if (candidate.chatId) return String(candidate.chatId);
  if (candidate.peerId?.channelId) return String(candidate.peerId.channelId);
  if (candidate.peerId?.chatId) return String(candidate.peerId.chatId);
  if (candidate.peerId?.userId) return String(candidate.peerId.userId);
  return 'unknown';
}

function getMessageId(message: unknown): string {
  if (!message || typeof message !== 'object') return 'unknown';
  const candidate = message as { id?: number | string };
  return candidate.id ? String(candidate.id) : 'unknown';
}

function getMessageDate(message: unknown): Date | null {
  if (!message || typeof message !== 'object') return null;
  const candidate = message as { date?: number | string };
  const raw = candidate.date;
  if (!raw) return null;
  const seconds = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}

function getEditDate(message: unknown): Date | null {
  if (!message || typeof message !== 'object') return null;
  const candidate = message as { editDate?: number | string };
  const raw = candidate.editDate;
  if (!raw) return null;
  const seconds = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}

async function logTelegramMessage(
  type: 'new' | 'edit',
  message: unknown,
): Promise<void> {
  const firestore = initFirestore();
  if (!firestore) {
    logger.warn('firestore_not_configured', {
      component: 'telegram_listener',
      message: 'FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY not configured',
    });
    return;
  }

  const text = getMessageText(message);
  const hash = hashText(text);
  const chatId = getChatId(message);
  const messageId = getMessageId(message);
  const messageDate = getMessageDate(message);
  const editDate = getEditDate(message);

  const allowedChatIds = await getAllowedChatIds();
  if (allowedChatIds.length > 0 && !allowedChatIds.includes(chatId)) {
    logger.info('telegram_message_filtered', { chatId, messageId });
    await writeSystemLog('info', 'telegram_listener', 'message_filtered', {
      chatId,
      messageId,
    });
    return;
  }

  const docId = `${chatId}_${messageId}_${hash}`;
  const docRef = firestore.collection('telegram_messages').doc(docId);

  const existing = await docRef.get();
  if (existing.exists) return;

  const parsed: ReturnType<typeof parseTelegramSignal> = text
    ? parseTelegramSignal(text)
    : { ok: false, error: 'empty_message' };

  let parseError: string | null = null;
  if (isParseError(parsed)) {
    parseError = parsed.error;
  }

  await docRef.set({
    chat_id: chatId,
    message_id: messageId,
    hash,
    type,
    text,
    date: messageDate ? messageDate.toISOString() : null,
    edit_date: editDate ? editDate.toISOString() : null,
    parsed_ok: parsed.ok,
    parsed: parsed.ok ? parsed.signal : null,
    parse_error: parseError,
    timestamp: new Date().toISOString(),
  });

  if (isParseError(parsed) && text) {
    await writeSystemLog('info', 'telegram_listener', 'signal_parse_failed', {
      chatId,
      messageId,
      error: parseError ?? 'unknown_error',
    });
  }

  if (parsed.ok && parsed.signal) {
    await writeSystemLog('info', 'telegram_listener', 'signal_parsed', {
      chatId,
      messageId,
      symbol: parsed.signal.symbol,
      direction: parsed.signal.direction,
    });

    try {
      await handleParsedSignal({
        chatId,
        messageId,
        messageDate,
        signal: parsed.signal,
      });
    } catch (error) {
      logger.error('trade_engine_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      await writeSystemLog('error', 'telegram_listener', 'trade_engine_failed', {
        chatId,
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function getAllowedChatIds(): Promise<string[]> {
  const now = Date.now();
  if (cachedAllowedChatIds && now - lastSettingsFetch < SETTINGS_TTL_MS) {
    return cachedAllowedChatIds;
  }

  const firestore = initFirestore();
  if (!firestore) {
    cachedAllowedChatIds = [];
    return cachedAllowedChatIds;
  }

  try {
    const snap = await firestore.doc(SETTINGS_DOC_PATH).get();
    const data = snap.data() as
      | { telegram?: { allowed_chat_ids?: string[] } }
      | undefined;
    const rawIds = data?.telegram?.allowed_chat_ids ?? [];
    cachedAllowedChatIds = rawIds.map((id) => String(id).trim()).filter(Boolean);
    lastSettingsFetch = now;
    return cachedAllowedChatIds;
  } catch (error) {
    logger.warn('settings_load_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    cachedAllowedChatIds = [];
    return cachedAllowedChatIds;
  }
}

export async function startTelegramListener(): Promise<void> {
  if (listenerStarted) return;

  const status = await getTelegramStatus();
  if (status.status !== 'authorized') {
    await writeSystemLog('warn', 'telegram_listener', 'listener_not_authorized', {
      status: status.status,
      lastError: status.lastError,
    });
    return;
  }

  const client = await getTelegramClient();

  const handler = async (event: { message?: unknown }, type: 'new' | 'edit') => {
    try {
      const chatId = getChatId(event.message);
      const messageId = getMessageId(event.message);
      logger.info('telegram_message_received', { chatId, messageId, type });
    await logTelegramMessage(type, event.message);
    } catch (error) {
      logger.error('telegram_listener_error', {
        error: error instanceof Error ? error.message : String(error),
      });
      await writeSystemLog('error', 'telegram_listener', 'listener_error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  client.addEventHandler((event) => handler(event, event.message && 'editDate' in event.message ? 'edit' : 'new'), new NewMessage({}));

  listenerStarted = true;
  await writeSystemLog('info', 'telegram_listener', 'listener_started');
}
