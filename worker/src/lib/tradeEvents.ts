/**
 * tradeEvents.ts
 *
 * Append-only audit trail for a trade set, stored in `trade_events`.
 * Document id is `${tradeSetId}__${eventKey}`, so a repeated event with the
 * same key is rejected by Firestore (`create`) and reported as `false`.
 * Never throws; a null Firestore client is a silent no-op.
 */

import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';
import type { TradeEventInput } from './tradeSetTypes';

const EVENT_KEY_MAX_LENGTH = 120;
const ALREADY_EXISTS_CODE = 6;

function sanitizeEventKey(eventKey: string): string {
  return eventKey.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, EVENT_KEY_MAX_LENGTH);
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (inner !== undefined) out[key] = stripUndefined(inner);
    }
    return out;
  }
  return value;
}

function buildDocument(e: TradeEventInput): Record<string, unknown> {
  return stripUndefined({
    trade_set_id: e.tradeSetId,
    event_key: e.eventKey,
    type: e.type,
    timestamp: new Date().toISOString(),
    mode: e.mode,
    profile_doc_id: e.profileDocId,
    profile_version: e.profileVersion,
    reason_code: e.reasonCode,
    message: e.message,
    order_ticket: e.orderTicket,
    position_ticket: e.positionTicket,
    deal_ticket: e.dealTicket,
    volume: e.volume,
    price: e.price,
    sl: e.sl,
    tp: e.tp,
    realized_pnl: e.realizedPnl,
    retcode: e.retcode,
    details: e.details,
  }) as Record<string, unknown>;
}

function isAlreadyExists(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { code?: unknown }).code === ALREADY_EXISTS_CODE) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('ALREADY_EXISTS');
}

export async function recordTradeEvent(e: TradeEventInput): Promise<boolean> {
  try {
    const firestore = initFirestore();
    if (!firestore) return false;

    const docId = `${e.tradeSetId}__${sanitizeEventKey(e.eventKey)}`;
    await firestore.collection('trade_events').doc(docId).create(buildDocument(e));
    return true;
  } catch (err) {
    if (isAlreadyExists(err)) return false;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('trade_event_write_failed', {
      trade_set_id: e.tradeSetId,
      event_key: e.eventKey,
      type: e.type,
      error: message,
    });
    return false;
  }
}

export async function listTradeEvents(tradeSetId: string): Promise<Array<Record<string, unknown>>> {
  try {
    const firestore = initFirestore();
    if (!firestore) return [];

    const snap = await firestore
      .collection('trade_events')
      .where('trade_set_id', '==', tradeSetId)
      .orderBy('timestamp')
      .get();
    return snap.docs.map((doc) => doc.data() as Record<string, unknown>);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('trade_events_list_failed', { trade_set_id: tradeSetId, error: message });
    return [];
  }
}
