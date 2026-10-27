import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { AUDIT_COLLECTION, getAdminDb, jsonError, readJsonObject } from '@/lib/adminControl';
import { isResponse, requireAdmin } from '@/lib/serverAuth';

export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

const ID_PATTERN = /^-?[0-9]{1,20}_[0-9]{1,20}$/;
/** The request must have been unable to execute for at least this long (EA expiry + margin). */
const MIN_SECONDS_AFTER_EXPIRY = 120;
const RESOLUTIONS = {
  not_executed: { state: 'REJECTED', error: 'operator_resolved_not_executed' },
  handled_manually: { state: 'ERROR', error: 'operator_resolved_handled_manually' },
} as const;
type Resolution = keyof typeof RESOLUTIONS;

class ResolveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * POST /api/trades/[id]/resolve: body { resolution, confirm: 'RESOLVE <id>', note? }.
 * Operator resolution of a trade set the reconciler cannot settle (SUBMIT_UNKNOWN,
 * for example when the broker altered the correlation comment). Only Firestore
 * state changes; nothing is sent to the broker:
 *   not_executed      the order did not execute       -> REJECTED
 *   handled_manually  the operator dealt with it in MT5 -> ERROR
 * Refused until the request is well past its EA expiry, so it cannot race a late fill.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdmin(request);
  if (isResponse(auth)) return auth;
  if (!ID_PATTERN.test(params.id)) return jsonError('Invalid trade set id', 400);

  const body = await readJsonObject(request);
  const resolution = body?.resolution;
  if (typeof resolution !== 'string' || !(resolution in RESOLUTIONS)) {
    return jsonError('resolution must be not_executed or handled_manually', 400);
  }
  const required = `RESOLVE ${params.id}`;
  if (body?.confirm !== required) return jsonError(`Type ${required} to confirm`, 400, { required_confirm: required });
  const note = typeof body?.note === 'string' ? body.note.slice(0, 300) : null;
  const target = RESOLUTIONS[resolution as Resolution];

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  const ref = db.collection('trade_sets').doc(params.id);
  const at = new Date().toISOString();
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ResolveError(404, 'Not found');
      const data = snap.data() ?? {};
      if (data.state !== 'SUBMIT_UNKNOWN') {
        throw new ResolveError(409, `Only SUBMIT_UNKNOWN trade sets can be resolved by hand (state is ${String(data.state)})`);
      }
      const expiresAt = Number((data.submission as { expires_at?: unknown } | null)?.expires_at ?? 0);
      if (!(expiresAt > 0) || Date.now() / 1000 < expiresAt + MIN_SECONDS_AFTER_EXPIRY) {
        throw new ResolveError(409, `The request expired less than ${MIN_SECONDS_AFTER_EXPIRY} s ago; wait for the reconciler`);
      }
      // Reads before writes: the alerts this resolution closes, if they exist.
      const alertRefs = ['submit_unknown', 'correlation_mismatch'].map((type) =>
        db.collection('alerts').doc(`${type}__${params.id.replace(/[^A-Za-z0-9_.-]/g, '_')}`),
      );
      const alertSnaps = await Promise.all(alertRefs.map((r) => tx.get(r)));
      tx.set(
        ref,
        {
          state: target.state,
          error: target.error,
          operator_resolution: { resolution, by: auth.email, at, note },
          updated_at: at,
        },
        { merge: true },
      );
      tx.set(db.collection('trade_events').doc(`${params.id}__operator_resolved`), {
        trade_set_id: params.id,
        event_key: 'operator_resolved',
        type: 'reconciliation',
        mode: data.mode ?? null,
        reason_code: target.error,
        message: `resolved by ${auth.email}: ${resolution}${note ? ` (${note})` : ''}`,
        timestamp: at,
      });
      tx.set(db.collection(AUDIT_COLLECTION).doc(), {
        action: 'trade_set.resolve',
        actor_uid: auth.uid,
        actor_email: auth.email,
        at,
        details: { trade_set_id: params.id, resolution, from_state: 'SUBMIT_UNKNOWN', to_state: target.state, note },
      });
      alertSnaps.forEach((alertSnap, i) => {
        if (!alertSnap.exists || alertSnap.data()?.status === 'resolved') return;
        tx.set(
          alertRefs[i],
          { status: 'resolved', resolved_by: auth.email, resolved_at: at, resolution: `operator: ${resolution}`, updated_at: at },
          { merge: true },
        );
      });
    });
    return NextResponse.json({ ok: true, id: params.id, state: target.state });
  } catch (err) {
    if (err instanceof ResolveError) return jsonError(err.message, err.status);
    return jsonError('Write failed', 503);
  }
}
