import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { discardPatch, readQueueState, requeueDecision, requeuePatch } from '@shared/signalQueue';
import { AUDIT_COLLECTION, getAdminDb, jsonError, readJsonObject } from '@/lib/adminControl';
import { isResponse, requireAdmin } from '@/lib/serverAuth';

export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

const ID_PATTERN = /^[A-Za-z0-9_-]{1,300}$/;
const CONFIRM: Record<string, string> = { requeue: 'REQUEUE', discard: 'DISCARD' };

const REFUSALS: Record<string, string> = {
  not_dead_letter: 'Only dead-lettered events can be requeued',
  superseded: 'A later event of the same trade set was already handled; replaying this one would act out of order',
  later_event_in_progress: 'A later event of the same trade set is being handled right now',
};

class QueueActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * POST /api/signal-events/[id]: body { action: 'requeue' | 'discard', confirm, note? }.
 * Operator recovery for a dead-lettered signal event (signalQueue.ts rules).
 * A requeued event runs through every engine gate again, including the signal
 * age limit, so a stale entry is skipped rather than executed. The change and an
 * admin_audit entry are written in one transaction.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdmin(request);
  if (isResponse(auth)) return auth;
  if (!ID_PATTERN.test(params.id)) return jsonError('Invalid event id', 400);

  const body = await readJsonObject(request);
  const action = typeof body?.action === 'string' ? body.action : '';
  const required = CONFIRM[action];
  if (!required) return jsonError('action must be requeue or discard', 400);
  if (body?.confirm !== required) return jsonError(`Type ${required} to confirm`, 400, { required_confirm: required });
  const note = typeof body?.note === 'string' ? body.note.slice(0, 200) : undefined;

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  const events = db.collection('signal_events');
  const ref = events.doc(params.id);
  const at = new Date().toISOString();
  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new QueueActionError(404, 'Not found');
      const data = snap.data() ?? {};
      const state = readQueueState(data.autotrader);
      if (!state || state.status !== 'dead_letter') {
        throw new QueueActionError(409, REFUSALS.not_dead_letter, { status: state?.status ?? null });
      }

      let next;
      if (action === 'requeue') {
        const sameKey = await tx.get(
          events.where('chat_id', '==', data.chat_id ?? '').where('message_id', '==', data.message_id ?? ''),
        );
        const createdAt = String(data.created_at ?? '');
        const later = sameKey.docs
          .filter((d) => d.id !== params.id && String(d.data().created_at ?? '') > createdAt)
          .map((d) => ({ autotrader: d.data().autotrader }));
        const decision = requeueDecision(state, later);
        if (decision.ok === false) throw new QueueActionError(409, REFUSALS[decision.reason], { reason: decision.reason });
        next = requeuePatch(state, auth.email, at);
      } else {
        next = discardPatch(state, auth.email, at, note);
      }

      tx.update(ref, { autotrader: JSON.parse(JSON.stringify(next)) });
      tx.set(db.collection(AUDIT_COLLECTION).doc(), {
        action: `signal_event.${action}`,
        actor_uid: auth.uid,
        actor_email: auth.email,
        at,
        details: { event_id: params.id, kind: data.kind ?? null, attempts: state.attempts, last_error: state.last_error ?? null, note: note ?? null },
      });
      return next.status;
    });
    return NextResponse.json({ ok: true, id: params.id, status: result });
  } catch (err) {
    if (err instanceof QueueActionError) return jsonError(err.message, err.status, err.extra);
    return jsonError('Write failed', 503);
  }
}
