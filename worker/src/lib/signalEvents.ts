/**
 * signalEvents.ts
 *
 * Firestore-backed hand-off between the two ByTrader services:
 *
 *   forwarder  (Telegram listener)  →  signal_events collection  →  autotrader
 *
 * The forwarder owns the single authenticated Telegram session and publishes
 * every actionable event here. The autotrader consumes the collection and
 * executes against MT5. Neither service imports the other, so they can be
 * rebuilt and restarted independently.
 *
 * Writes use create(): a second publish of the same document id is a no-op.
 * Each event is created with its durable queue state (`autotrader.status =
 * pending`, signalQueue.ts), so the AutoTrader finds it however long it was down.
 *
 * If Firestore is configured but the write keeps failing, the event goes to the
 * local outbox (signalOutbox.ts) and is retried in the background in FIFO order.
 * While the outbox is not empty, new events queue behind it.
 */

import { raiseAlert, resolveAlert } from './alerts';
import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';
import { appendOutbox, getOutboxMax, getOutboxPath, readOutbox, writeOutbox } from './signalOutbox';
import type { OutboxEntry } from './signalOutbox';
import { initialQueueState } from './signalQueue';
import { writeSystemLog } from './systemLog';
import type { GoldSignal } from './vipSignalParser';

export const SIGNAL_EVENTS_COLLECTION = 'signal_events';

const ALREADY_EXISTS_CODE = 6;
const PUBLISH_RETRY_DELAYS_MS = [250, 1000];
const OUTBOX_FLUSH_INTERVAL_MS = 15_000;

export type SignalEventKind = 'signal' | 'cancel';
export type SignalCancelReason = 'unparseable_edit' | 'explicit_cancel';

export type SignalEventInput = {
  chatId: string;
  messageId: string;
  messageType: 'new' | 'edit';
  /** sha256 of the message text — makes each revision a distinct event */
  textHash: string;
  kind: SignalEventKind;
  signal?: GoldSignal | null;
  messageDate?: Date | null;
  cancelReason?: SignalCancelReason;
  /** For a reply-cancel: the message that carried the cancel text */
  triggerMessageId?: string;
};

let outboxCount: number | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushInFlight: Promise<void> | null = null;

function isAlreadyExists(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { code?: unknown }).code === ALREADY_EXISTS_CODE) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('ALREADY_EXISTS');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Firestore credentials are present (the client may still fail to initialise or to write). */
function firestoreConfigured(): boolean {
  return !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
}

function outboxEnabled(): boolean {
  return process.env.SIGNAL_OUTBOX !== 'disabled';
}

function currentOutboxCount(): number {
  if (outboxCount === null) {
    try {
      outboxCount = readOutbox(getOutboxPath()).length;
    } catch (err) {
      logger.error('signal_outbox_read_failed', { error: errorMessage(err) });
      outboxCount = 0;
    }
  }
  return outboxCount;
}

function buildEventData(input: SignalEventInput, createdAt: string): Record<string, unknown> {
  const data: Record<string, unknown> = {
    chat_id: input.chatId,
    message_id: input.messageId,
    message_type: input.messageType,
    text_hash: input.textHash,
    kind: input.kind,
    signal: input.signal ?? null,
    message_date: input.messageDate ? input.messageDate.toISOString() : null,
    created_at: createdAt,
    autotrader: initialQueueState(createdAt),
  };
  // Firestore rejects undefined field values, so optional fields are omitted.
  if (input.cancelReason !== undefined) data.cancel_reason = input.cancelReason;
  if (input.triggerMessageId !== undefined) data.trigger_message_id = input.triggerMessageId;
  return data;
}

/** One create with the short in-line retries. Resolves 'stored' or rejects with the last error. */
async function createWithRetries(firestore: FirebaseFirestore.Firestore, docId: string, data: Record<string, unknown>): Promise<void> {
  const ref = firestore.collection(SIGNAL_EVENTS_COLLECTION).doc(docId);
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= PUBLISH_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const delayMs = PUBLISH_RETRY_DELAYS_MS[attempt - 1];
      logger.warn('signal_event_publish_retry', { docId, attempt, delay_ms: delayMs, error: errorMessage(lastError) });
      await sleep(delayMs);
    }
    try {
      await ref.create(data);
      return;
    } catch (error) {
      if (isAlreadyExists(error)) return;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function spool(docId: string, data: Record<string, unknown>, lastError?: string): boolean {
  const max = getOutboxMax();
  if (currentOutboxCount() >= max) {
    logger.error('signal_outbox_full', { docId, max });
    return false;
  }
  const entry: OutboxEntry = {
    doc_id: docId,
    data,
    spooled_at: new Date().toISOString(),
    attempts: 0,
    ...(lastError ? { last_error: lastError.slice(0, 300) } : {}),
  };
  try {
    appendOutbox(entry, getOutboxPath());
  } catch (err) {
    logger.error('signal_outbox_append_failed', { docId, error: errorMessage(err) });
    return false;
  }
  outboxCount = currentOutboxCount() + 1;
  ensureFlushTimer();
  return true;
}

function ensureFlushTimer(): void {
  if (flushTimer !== null) return;
  flushTimer = setInterval(() => void flushSignalOutbox(), OUTBOX_FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

function stopFlushTimer(): void {
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

/**
 * Writes spooled events to Firestore in order. Stops at the first failure.
 * Single-flight: concurrent callers share one pass. Never throws.
 */
export function flushSignalOutbox(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = (async () => {
    const filePath = getOutboxPath();
    let entries: OutboxEntry[];
    try {
      entries = readOutbox(filePath, (line) => logger.error('signal_outbox_corrupt_line', { line }));
    } catch (err) {
      logger.error('signal_outbox_read_failed', { error: errorMessage(err) });
      return;
    }
    outboxCount = entries.length;
    if (entries.length === 0) {
      stopFlushTimer();
      return;
    }
    const firestore = initFirestore();
    if (!firestore) return;

    let delivered = 0;
    let failure: string | null = null;
    for (const entry of entries) {
      try {
        await firestore
          .collection(SIGNAL_EVENTS_COLLECTION)
          .doc(entry.doc_id)
          .create({ ...entry.data, spooled_at: entry.spooled_at });
        delivered += 1;
      } catch (err) {
        if (isAlreadyExists(err)) {
          delivered += 1;
          continue;
        }
        failure = errorMessage(err);
        entry.attempts += 1;
        entry.last_error = failure.slice(0, 300);
        break;
      }
    }

    const remaining = entries.slice(delivered);
    try {
      // Re-read so entries appended during the flush are kept behind the remaining ones.
      const now = readOutbox(filePath);
      const appended = now.slice(entries.length);
      writeOutbox([...remaining, ...appended], filePath);
      outboxCount = remaining.length + appended.length;
    } catch (err) {
      // Delivered entries stay in the file and are re-sent; create() makes that a no-op.
      logger.error('signal_outbox_rewrite_failed', { error: errorMessage(err) });
      return;
    }

    if (delivered > 0) {
      logger.info('signal_outbox_flushed', { delivered, remaining: outboxCount });
      await writeSystemLog('info', 'signal_events', 'signal_outbox_flushed', { delivered, remaining: outboxCount });
    }
    if (outboxCount === 0) {
      stopFlushTimer();
      await resolveAlert('signal_publish_failed', 'outbox', 'outbox_drained');
    } else if (failure) {
      logger.warn('signal_outbox_flush_blocked', { remaining: outboxCount, error: failure });
    }
  })().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

/**
 * Returns true when the event is stored (or was already stored) in Firestore,
 * or durably spooled to the local outbox for a later write. Returns false when
 * it could not be kept at all. Never throws.
 */
export async function publishSignalEvent(input: SignalEventInput): Promise<boolean> {
  const docId = `${input.chatId}_${input.messageId}_${input.textHash}`;
  const data = buildEventData(input, new Date().toISOString());
  const canSpool = outboxEnabled() && firestoreConfigured();

  // Keep FIFO order behind events that are already waiting in the outbox.
  if (canSpool && currentOutboxCount() > 0) {
    const kept = spool(docId, data, 'queued_behind_outbox');
    void flushSignalOutbox();
    if (!kept) await reportPublishFailure(input, docId, 'outbox_unavailable');
    return kept;
  }

  const firestore = initFirestore();
  if (!firestore) {
    if (canSpool && spool(docId, data, 'firestore_init_failed')) {
      await reportSpooled(input, docId, 'firestore_init_failed');
      return true;
    }
    logger.warn('signal_event_publish_skipped', { docId, reason: 'firestore_not_configured' });
    return false;
  }

  try {
    await createWithRetries(firestore, docId, data);
    return true;
  } catch (err) {
    const message = errorMessage(err);
    if (canSpool && spool(docId, data, message)) {
      await reportSpooled(input, docId, message);
      return true;
    }
    await reportPublishFailure(input, docId, message);
    return false;
  }
}

async function reportSpooled(input: SignalEventInput, docId: string, error: string): Promise<void> {
  const details = { docId, chatId: input.chatId, messageId: input.messageId, kind: input.kind, error, outbox: currentOutboxCount() };
  logger.error('signal_event_spooled', details);
  await writeSystemLog('error', 'signal_events', 'signal_event_spooled', details);
  await raiseAlert({
    type: 'signal_publish_failed',
    subject: 'outbox',
    severity: 'error',
    source: 'forwarder',
    title: 'Signal events spooled locally',
    message: `Firestore rejected signal event ${docId}; it is kept in the forwarder outbox and retried every ${OUTBOX_FLUSH_INTERVAL_MS / 1000} s.`,
    details: { outbox: currentOutboxCount(), last_error: error },
  });
}

async function reportPublishFailure(input: SignalEventInput, docId: string, error: string): Promise<void> {
  const details = {
    docId,
    chatId: input.chatId,
    messageId: input.messageId,
    kind: input.kind,
    attempts: PUBLISH_RETRY_DELAYS_MS.length + 1,
    error,
  };
  logger.error('signal_event_publish_failed', details);
  await writeSystemLog('error', 'signal_events', 'signal_event_publish_failed', details);
  await raiseAlert({
    type: 'signal_publish_failed',
    subject: 'lost',
    severity: 'critical',
    source: 'forwarder',
    title: 'Signal event could not be kept',
    message: `Signal event ${docId} could not be written to Firestore or the local outbox. It will not be executed.`,
    details: { last_error: error },
  });
}

/** Number of events waiting in the local outbox (for health output). */
export function getSignalOutboxDepth(): number {
  return currentOutboxCount();
}

/** Starts the background flush if the outbox has entries from an earlier run. */
export function startSignalOutbox(): void {
  if (outboxEnabled() && currentOutboxCount() > 0) {
    ensureFlushTimer();
    void flushSignalOutbox();
  }
}

/** Test seam. */
export function _resetSignalEventsForTests(): void {
  stopFlushTimer();
  outboxCount = null;
  flushInFlight = null;
}
