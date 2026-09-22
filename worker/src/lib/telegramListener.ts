import crypto from 'node:crypto';
import { NewMessage, Raw } from 'telegram/events';
import { TelegramClient } from 'telegram';
import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';
import { writeSystemLog } from './systemLog';
import { parseTelegramSignal } from './telegramParser';
import { getTelegramClient, getTelegramStatus } from './telegramClient';
import { handleParsedSignal } from './tradeEngine';

let attachedClient: TelegramClient | null = null;
let lastSettingsFetch = 0;
let cachedAllowedChatIds: string[] | null = null;
let cachedBlockedChatIds: string[] | null = null;
let telegramSettingsMigrationChecked = false;

const SETTINGS_DOC_PATH = 'settings/default';
const SETTINGS_TTL_MS = 30_000;

function isParseError(
  result: ReturnType<typeof parseTelegramSignal>,
): result is { ok: false; error: string } {
  return result.ok === false;
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function safeSerialize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, inner) => {
      if (typeof inner === 'bigint') return inner.toString();
      if (inner instanceof Date) return inner.toISOString();
      if (inner && typeof inner === 'object' && 'toJSON' in inner) {
        try {
          return (inner as { toJSON: () => unknown }).toJSON();
        } catch {
          return String(inner);
        }
      }
      return inner;
    }),
  );
}

function getMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const candidate = message as { message?: string; text?: string };
  return candidate.message ?? candidate.text ?? '';
}

function toIdString(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  if (value && typeof value === 'object' && 'toString' in value) {
    return String((value as { toString: () => string }).toString());
  }
  return String(value);
}

function getChatId(message: unknown): string {
  if (!message || typeof message !== 'object') return 'unknown';
  const candidate = message as {
    chatId?: bigint | number | string;
    peerId?: { channelId?: bigint | number | string; chatId?: bigint | number | string; userId?: bigint | number | string };
  };

  if (candidate.peerId?.channelId != null) {
    return `-100${toIdString(candidate.peerId.channelId)}`;
  }
  if (candidate.peerId?.chatId != null) {
    return `-${toIdString(candidate.peerId.chatId)}`;
  }
  if (candidate.peerId?.userId != null) {
    return toIdString(candidate.peerId.userId);
  }
  if (candidate.chatId != null) {
    return toIdString(candidate.chatId);
  }
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

function getMediaFileName(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;

  const candidate = message as {
    file?: { name?: string; fileName?: string };
    media?: {
      document?: {
        attributes?: Array<{ fileName?: string; file_name?: string; className?: string }>;
      };
    };
  };

  const fileName = candidate.file?.name ?? candidate.file?.fileName;
  if (fileName) return fileName;

  const attrs = candidate.media?.document?.attributes;
  if (!Array.isArray(attrs)) return null;

  for (const attr of attrs) {
    if (!attr || typeof attr !== 'object') continue;
    if (attr.fileName) return attr.fileName;
    if (attr.file_name) return attr.file_name;
    if (attr.className?.includes('DocumentAttributeFilename') && attr.fileName) {
      return attr.fileName;
    }
  }

  return null;
}

function getDebugEnvelope(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== 'object') {
    return {
      has_text: false,
      has_media: false,
      media_file_name: null,
      is_forward: false,
      is_reply: false,
      reply_to_msg_id: null,
      is_post: false,
      grouped_id: null,
      via_bot_id: null,
      post_author: null,
      action_type: null,
    };
  }

  const candidate = message as {
    message?: string;
    text?: string;
    media?: unknown;
    photo?: unknown;
    document?: unknown;
    video?: unknown;
    audio?: unknown;
    voice?: unknown;
    sticker?: unknown;
    gif?: unknown;
    webPreview?: unknown;
    forward?: unknown;
    fwdFrom?: unknown;
    replyTo?: { replyToMsgId?: number | string };
    replyToMsgId?: number | string;
    post?: boolean;
    groupedId?: bigint | number | string;
    viaBotId?: bigint | number | string;
    postAuthor?: string;
    action?: { className?: string };
  };

  const text = candidate.message ?? candidate.text ?? '';
  const hasMedia = Boolean(
    candidate.media ||
      candidate.photo ||
      candidate.document ||
      candidate.video ||
      candidate.audio ||
      candidate.voice ||
      candidate.sticker ||
      candidate.gif ||
      candidate.webPreview,
  );

  return {
    has_text: text.length > 0,
    has_media: hasMedia,
    media_file_name: getMediaFileName(message),
    is_forward: Boolean(candidate.forward || candidate.fwdFrom),
    is_reply: Boolean(candidate.replyTo || candidate.replyToMsgId),
    reply_to_msg_id: candidate.replyTo?.replyToMsgId ?? candidate.replyToMsgId ?? null,
    is_post: Boolean(candidate.post),
    grouped_id: candidate.groupedId != null ? toIdString(candidate.groupedId) : null,
    via_bot_id: candidate.viaBotId != null ? toIdString(candidate.viaBotId) : null,
    post_author: candidate.postAuthor ?? null,
    action_type: candidate.action?.className ?? null,
  };
}

function getSenderUserId(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const candidate = message as {
    senderId?: bigint | number | string;
    fromId?: { userId?: bigint | number | string };
    sender?: { id?: bigint | number | string };
  };

  if (candidate.fromId?.userId != null) {
    return toIdString(candidate.fromId.userId);
  }
  if (candidate.senderId != null) {
    return toIdString(candidate.senderId);
  }
  if (candidate.sender?.id != null) {
    return toIdString(candidate.sender.id);
  }
  return null;
}

function isInboundMessage(message: unknown, selfUserId: string | null): boolean {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as {
    out?: boolean;
    outgoing?: boolean;
  };

  if (candidate.out === true || candidate.outgoing === true) {
    return false;
  }

  if (selfUserId) {
    const senderUserId = getSenderUserId(message);
    if (senderUserId && senderUserId === selfUserId) {
      return false;
    }
  }

  return true;
}

async function logTelegramMessage(
  type: 'new' | 'edit',
  message: unknown,
  client: TelegramClient,
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
  const debugEnvelope = getDebugEnvelope(message);
  const rawMessage = safeSerialize(message);

  const { allowedChatIds, blockedChatIds } = await getTelegramChatFilters();

  if (blockedChatIds.includes(chatId)) {
    logger.info('telegram_message_blocked', { chatId, messageId });
    await writeSystemLog('info', 'telegram_listener', 'message_blocked', {
      chatId,
      messageId,
      type,
    });
    return;
  }

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
    debug: debugEnvelope,
    raw_message: rawMessage,
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

async function logRawTelegramUpdate(event: unknown): Promise<void> {
  const firestore = initFirestore();
  if (!firestore) return;

  try {
    const candidate = (event ?? {}) as {
      message?: unknown;
      update?: unknown;
      originalUpdate?: unknown;
      className?: string;
    };

    const message = candidate.message;
    const update = candidate.update ?? candidate.originalUpdate ?? event;
    const serializedUpdate = safeSerialize(update);
    const serializedMessage = safeSerialize(message);

    const chatId = getChatId(message);
    const messageId = getMessageId(message);
    const text = getMessageText(message);
    const debugEnvelope = getDebugEnvelope(message);
    const eventClass = candidate.className ?? 'RawUpdate';

    const hash = hashText(JSON.stringify(serializedUpdate ?? {}));
    const docId = `${Date.now()}_${hash.slice(0, 16)}`;

    await firestore.collection('telegram_updates_debug').doc(docId).set({
      event_class: eventClass,
      chat_id: chatId,
      message_id: messageId,
      text,
      debug: debugEnvelope,
      message: serializedMessage,
      update: serializedUpdate,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.warn('telegram_raw_update_log_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeChatIdList(rawIds: Array<string | number>): string[] {
  const normalized = new Set<string>();

  for (const rawId of rawIds) {
    const id = String(rawId).trim();
    if (!id) continue;

    normalized.add(id);

    if (/^\d+$/.test(id)) {
      normalized.add(`-100${id}`);
      normalized.add(`-${id}`);
    }
  }

  return Array.from(normalized);
}

async function ensureTelegramSettingsMigration(data: { telegram?: Record<string, unknown> } | undefined): Promise<void> {
  if (telegramSettingsMigrationChecked) return;

  telegramSettingsMigrationChecked = true;
  const firestore = initFirestore();
  if (!firestore) return;

  const telegram = data?.telegram ?? {};
  const hasBlocked = Array.isArray(telegram.blocked_chat_ids);

  if (!hasBlocked) {
    await firestore.doc(SETTINGS_DOC_PATH).set(
      {
        telegram: {
          blocked_chat_ids: [],
        },
      },
      { merge: true },
    );
    await writeSystemLog('info', 'telegram_listener', 'telegram_settings_migrated', {
      added_field: 'telegram.blocked_chat_ids',
    });
  }
}

async function getTelegramChatFilters(): Promise<{ allowedChatIds: string[]; blockedChatIds: string[] }> {
  const now = Date.now();
  if (cachedAllowedChatIds && cachedBlockedChatIds && now - lastSettingsFetch < SETTINGS_TTL_MS) {
    return {
      allowedChatIds: cachedAllowedChatIds,
      blockedChatIds: cachedBlockedChatIds,
    };
  }

  const firestore = initFirestore();
  if (!firestore) {
    cachedAllowedChatIds = [];
    cachedBlockedChatIds = [];
    return {
      allowedChatIds: cachedAllowedChatIds,
      blockedChatIds: cachedBlockedChatIds,
    };
  }

  try {
    const snap = await firestore.doc(SETTINGS_DOC_PATH).get();
    const data = snap.data() as
      | { telegram?: { allowed_chat_ids?: Array<string | number>; blocked_chat_ids?: Array<string | number> } }
      | undefined;

    await ensureTelegramSettingsMigration(data as { telegram?: Record<string, unknown> } | undefined);

    cachedAllowedChatIds = normalizeChatIdList(data?.telegram?.allowed_chat_ids ?? []);
    cachedBlockedChatIds = normalizeChatIdList(data?.telegram?.blocked_chat_ids ?? []);
    lastSettingsFetch = now;

    return {
      allowedChatIds: cachedAllowedChatIds,
      blockedChatIds: cachedBlockedChatIds,
    };
  } catch (error) {
    logger.warn('settings_load_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    cachedAllowedChatIds = [];
    cachedBlockedChatIds = [];
    return {
      allowedChatIds: cachedAllowedChatIds,
      blockedChatIds: cachedBlockedChatIds,
    };
  }
}

function isRawDebugEnabled(): boolean {
  const flag = process.env.TELEGRAM_RAW_DEBUG;
  return flag === '1' || flag === 'true';
}

export async function startTelegramListener(): Promise<void> {
  const status = await getTelegramStatus();
  if (status.status !== 'authorized') {
    await writeSystemLog('warn', 'telegram_listener', 'listener_not_authorized', {
      status: status.status,
      lastError: status.lastError,
    });
    return;
  }

  const client = await getTelegramClient();
  if (attachedClient === client) return;

  const me = await client.getMe();
  const selfUserId = me?.id ? toIdString(me.id) : null;

  const handler = async (event: { message?: unknown }, type: 'new' | 'edit') => {
    try {
      if (!isInboundMessage(event.message, selfUserId)) {
        const chatId = getChatId(event.message);
        const messageId = getMessageId(event.message);
        logger.info('telegram_message_outbound_ignored', { chatId, messageId, type });
        await writeSystemLog('info', 'telegram_listener', 'message_outbound_ignored', {
          chatId,
          messageId,
          type,
        });
        return;
      }

      const chatId = getChatId(event.message);
      const messageId = getMessageId(event.message);
      logger.info('telegram_message_received', { chatId, messageId, type });
      await logTelegramMessage(type, event.message, client);
    } catch (error) {
      logger.error('telegram_listener_error', {
        error: error instanceof Error ? error.message : String(error),
      });
      await writeSystemLog('error', 'telegram_listener', 'listener_error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const rawHandler = async (event: unknown) => {
    try {
      await logRawTelegramUpdate(event);
    } catch (error) {
      logger.warn('telegram_raw_listener_error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  client.addEventHandler((event) => handler(event, event.message && 'editDate' in event.message ? 'edit' : 'new'), new NewMessage({}));

  if (isRawDebugEnabled()) {
    client.addEventHandler(rawHandler, new Raw({}));
  }

  attachedClient = client;
  await writeSystemLog('info', 'telegram_listener', 'listener_started');
}
