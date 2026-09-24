/**
 * signalFeed.ts
 *
 * AutoTrader-side consumer of the `signal_events` Firestore collection that the
 * forwarder publishes to. Decouples MT5 execution from the Telegram listener so
 * the two services can be deployed and restarted independently.
 *
 * Poll model: ordered single-field query on `created_at` (> cursor), so no
 * composite index is required. The consumer is idempotent — `handleGoldSignal`
 * dedupes by trade-set id and drops stale signals — so overlapping re-reads
 * after a restart are harmless.
 */

import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';
import { writeSystemLog } from './systemLog';
import { getMt5Config } from './mt5Secrets';
import { cancelGoldTrade, handleGoldSignal } from './mt5TradeEngine';
import type { GoldSignal } from './vipSignalParser';

const COLLECTION = 'signal_events';
const MAX_PER_POLL = 100;

let _running = false;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _cursor = new Date().toISOString();

export type SignalEventDoc = {
  chat_id?: string;
  message_id?: string;
  kind?: string;
  signal?: GoldSignal | null;
  message_date?: string | null;
};

export async function dispatchSignalEvent(
  data: SignalEventDoc,
  sourceChatIds: string[],
): Promise<void> {
  const chatId = String(data.chat_id ?? '');
  const messageId = String(data.message_id ?? '');
  if (!chatId || !messageId) return;
  if (!sourceChatIds.includes(chatId)) return; // chat not configured for MT5 execution

  if (data.kind === 'signal' && data.signal) {
    await handleGoldSignal({
      chatId,
      messageId,
      messageDate: data.message_date ? new Date(data.message_date) : null,
      signal: data.signal,
    });
  } else if (data.kind === 'cancel') {
    await cancelGoldTrade(chatId, messageId);
  }
}

async function tick(intervalHint: number): Promise<void> {
  const firestore = initFirestore();
  if (!firestore) return;

  const { sourceChatIds } = await getMt5Config();

  const snap = await firestore
    .collection(COLLECTION)
    .where('created_at', '>', _cursor)
    .orderBy('created_at', 'asc')
    .limit(MAX_PER_POLL)
    .get();

  if (snap.empty) return;

  for (const doc of snap.docs) {
    const data = doc.data() as SignalEventDoc;
    const createdAt = (doc.get('created_at') as string | undefined) ?? _cursor;
    _cursor = createdAt;

    try {
      await dispatchSignalEvent(data, sourceChatIds);
    } catch (error) {
      logger.error('signal_feed_dispatch_failed', {
        docId: doc.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await writeSystemLog('error', 'signal_feed', 'dispatch_failed', {
        docId: doc.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Drained a full page — there may be more waiting, poll again immediately.
  if (snap.size >= MAX_PER_POLL) {
    _timer = setTimeout(() => void loop(intervalHint), 0);
  }
}

async function loop(intervalMs: number): Promise<void> {
  if (!_running) return;
  try {
    await tick(intervalMs);
  } catch (error) {
    logger.warn('signal_feed_tick_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (_running) {
      _timer = setTimeout(() => void loop(intervalMs), intervalMs);
    }
  }
}

export function startSignalFeed(): void {
  if (_running) return;
  _running = true;

  const intervalMs = Number(process.env.SIGNAL_FEED_INTERVAL_MS ?? 3000);
  const lookbackMs = Number(process.env.SIGNAL_FEED_LOOKBACK_MS ?? 5 * 60_000);
  _cursor = new Date(Date.now() - lookbackMs).toISOString();

  logger.info('signal_feed_started', { intervalMs, lookbackMs, cursor: _cursor });
  void writeSystemLog('info', 'signal_feed', 'feed_started', { intervalMs, lookbackMs });

  _timer = setTimeout(() => void loop(intervalMs), intervalMs);
}

export function stopSignalFeed(): void {
  _running = false;
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
  logger.info('signal_feed_stopped');
}

export function isSignalFeedRunning(): boolean {
  return _running;
}
