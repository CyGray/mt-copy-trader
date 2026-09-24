import { TelegramClient } from 'telegram';
import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';
import { writeSystemLog } from './systemLog';
import { getTelegramClient } from './telegramClient';
import type { GoldSignal } from './vipSignalParser';

export const DEFAULT_FORWARD_CHAT_ID = '-1002350471397';
export const DEFAULT_SIGNAL_SOURCE_CHAT_IDS = ['-1003271337051'];

const SETTINGS_DOC_PATH = 'settings/default';
const FORWARDS_COLLECTION = 'signal_forwards';
const CONFIG_TTL_MS = 30_000;

export type SignalForwardConfig = {
  enabled: boolean;
  forwardChatId: string;
  sourceChatIds: string[];
};

const DEFAULT_CONFIG: SignalForwardConfig = {
  enabled: true,
  forwardChatId: DEFAULT_FORWARD_CHAT_ID,
  sourceChatIds: DEFAULT_SIGNAL_SOURCE_CHAT_IDS,
};

let cachedConfig: SignalForwardConfig | null = null;
let lastConfigFetch = 0;

function normalizeChatId(value: string | number): string {
  const id = String(value).trim();
  return id;
}

export async function getSignalForwardConfig(): Promise<SignalForwardConfig> {
  const now = Date.now();
  if (cachedConfig && now - lastConfigFetch < CONFIG_TTL_MS) {
    return cachedConfig;
  }

  const firestore = initFirestore();
  if (!firestore) {
    cachedConfig = DEFAULT_CONFIG;
    lastConfigFetch = now;
    return cachedConfig;
  }

  try {
    const snap = await firestore.doc(SETTINGS_DOC_PATH).get();
    const telegram = (snap.data()?.telegram ?? {}) as {
      signal_forward_enabled?: unknown;
      forward_chat_id?: unknown;
      signal_source_chat_ids?: unknown;
    };

    const enabled =
      telegram.signal_forward_enabled === undefined
        ? DEFAULT_CONFIG.enabled
        : telegram.signal_forward_enabled !== false &&
          telegram.signal_forward_enabled !== 'false';

    const forwardChatId =
      telegram.forward_chat_id != null
        ? normalizeChatId(telegram.forward_chat_id as string | number)
        : DEFAULT_CONFIG.forwardChatId;

    const sourceChatIds = Array.isArray(telegram.signal_source_chat_ids)
      ? (telegram.signal_source_chat_ids as Array<string | number>).map(normalizeChatId)
      : DEFAULT_CONFIG.sourceChatIds;

    cachedConfig = { enabled, forwardChatId, sourceChatIds };
    lastConfigFetch = now;
    return cachedConfig;
  } catch (error) {
    logger.warn('signal_forward_config_load_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    cachedConfig = DEFAULT_CONFIG;
    lastConfigFetch = now;
    return cachedConfig;
  }
}

export function formatSignalMessage(
  signal: GoldSignal,
  options: { correction?: boolean } = {},
): string {
  const header = signal.direction === 'buy' ? '🟢 BUY' : '🔴 SELL';
  const entry =
    signal.entryLow === signal.entryHigh
      ? `${signal.entryLow}`
      : `${signal.entryLow} - ${signal.entryHigh}`;

  const lines: string[] = [];

  if (options.correction) {
    lines.push('♻️ CORRECTION', '');
  }

  lines.push(`${header} ${signal.symbol}`, '', `Entry: ${entry}`, `SL: ${signal.stopLoss}`);

  signal.takeProfits.forEach((tp, index) => {
    lines.push(`TP${index + 1}: ${tp}`);
  });

  return lines.join('\n');
}

async function resolveChat(client: TelegramClient, chatId: string) {
  try {
    return await client.getEntity(chatId);
  } catch {
    const dialogs = await client.getDialogs({ limit: 300 });
    const target = chatId.replace(/^-100/, '');
    const match = dialogs.find((dialog) => dialog.id?.toString() === target);
    if (match?.entity) return match.entity;
    throw new Error(`Could not resolve chat ${chatId}`);
  }
}

export async function forwardGoldSignal(
  sourceChatId: string,
  messageId: string,
  signal: GoldSignal,
  revisionHash: string,
): Promise<boolean> {
  const config = await getSignalForwardConfig();
  if (!config.enabled) return false;
  if (!config.sourceChatIds.includes(sourceChatId)) return false;

  const firestore = initFirestore();
  const forwardDocId = `${sourceChatId}_${messageId}`;
  const docRef = firestore
    ? firestore.collection(FORWARDS_COLLECTION).doc(forwardDocId)
    : null;

  let revision = 0;
  if (docRef) {
    const existing = await docRef.get();
    const previous = (existing.exists ? existing.data() : null) as
      | { last_hash?: string; revision?: number }
      | null;
    if (previous && previous.last_hash === revisionHash) return false;
    if (previous) revision = Number(previous.revision ?? 0) + 1;
  }

  const correction = revision > 0;

  try {
    const client = await getTelegramClient();
    const entity = await resolveChat(client, config.forwardChatId);
    const text = formatSignalMessage(signal, { correction });

    await client.sendMessage(entity, { message: text });

    if (docRef) {
      await docRef.set({
        source_chat_id: sourceChatId,
        message_id: messageId,
        forward_chat_id: config.forwardChatId,
        symbol: signal.symbol,
        direction: signal.direction,
        entry_low: signal.entryLow,
        entry_high: signal.entryHigh,
        stop_loss: signal.stopLoss,
        take_profits: signal.takeProfits,
        revision,
        correction,
        last_hash: revisionHash,
        text,
        timestamp: new Date().toISOString(),
      });
    }

    await writeSystemLog('info', 'signal_forwarding', 'signal_forwarded', {
      sourceChatId,
      messageId,
      forwardChatId: config.forwardChatId,
      symbol: signal.symbol,
      direction: signal.direction,
      revision,
      correction,
    });

    return true;
  } catch (error) {
    logger.error('signal_forward_failed', {
      sourceChatId,
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    await writeSystemLog('error', 'signal_forwarding', 'signal_forward_failed', {
      sourceChatId,
      messageId,
      forwardChatId: config.forwardChatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
