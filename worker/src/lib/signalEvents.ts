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
 */

import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';
import type { GoldSignal } from './vipSignalParser';

export const SIGNAL_EVENTS_COLLECTION = 'signal_events';

export type SignalEventKind = 'signal' | 'cancel';

export type SignalEventInput = {
  chatId: string;
  messageId: string;
  messageType: 'new' | 'edit';
  /** sha256 of the message text — makes each revision a distinct event */
  textHash: string;
  kind: SignalEventKind;
  signal?: GoldSignal | null;
  messageDate?: Date | null;
};

export async function publishSignalEvent(input: SignalEventInput): Promise<void> {
  const firestore = initFirestore();
  if (!firestore) return;

  const docId = `${input.chatId}_${input.messageId}_${input.textHash}`;

  try {
    await firestore.collection(SIGNAL_EVENTS_COLLECTION).doc(docId).set({
      chat_id: input.chatId,
      message_id: input.messageId,
      message_type: input.messageType,
      text_hash: input.textHash,
      kind: input.kind,
      signal: input.signal ?? null,
      message_date: input.messageDate ? input.messageDate.toISOString() : null,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    logger.warn('signal_event_publish_failed', {
      docId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
