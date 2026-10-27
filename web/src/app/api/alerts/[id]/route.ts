import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { AUDIT_COLLECTION, getAdminDb, jsonError, readJsonObject } from '@/lib/adminControl';
import { isResponse, requireAdmin } from '@/lib/serverAuth';

export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

const ID_PATTERN = /^[A-Za-z0-9_.-]{1,300}$/;
const ACTIONS = ['acknowledge', 'resolve'] as const;
type Action = (typeof ACTIONS)[number];

class AlertActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * POST /api/alerts/[id]: body { action: 'acknowledge' | 'resolve', note? }.
 * Acknowledge marks an open alert as seen; it stays listed until its condition
 * clears or it is resolved. Resolve closes it by hand (it re-opens if the worker
 * sees the condition again). Both write an admin_audit entry atomically.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdmin(request);
  if (isResponse(auth)) return auth;
  if (!ID_PATTERN.test(params.id)) return jsonError('Invalid alert id', 400);

  const body = await readJsonObject(request);
  const action = body?.action;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return jsonError('action must be acknowledge or resolve', 400);
  }
  const note = typeof body?.note === 'string' ? body.note.slice(0, 300) : null;

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  const ref = db.collection('alerts').doc(params.id);
  const at = new Date().toISOString();
  try {
    const status = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new AlertActionError(404, 'Not found');
      const current = snap.data() ?? {};
      const from = String(current.status ?? '');
      let patch: Record<string, unknown>;
      if ((action as Action) === 'acknowledge') {
        if (from === 'resolved') throw new AlertActionError(409, 'Alert is already resolved');
        patch = { status: 'acknowledged', acknowledged_by: auth.email, acknowledged_at: at, updated_at: at };
      } else {
        if (from === 'resolved') return 'resolved';
        patch = {
          status: 'resolved',
          resolved_by: auth.email,
          resolved_at: at,
          resolution: note ? `operator: ${note}` : 'operator',
          updated_at: at,
        };
      }
      tx.set(ref, patch, { merge: true });
      tx.set(db.collection(AUDIT_COLLECTION).doc(), {
        action: `alert.${action}`,
        actor_uid: auth.uid,
        actor_email: auth.email,
        at,
        details: { alert_id: params.id, type: current.type ?? null, from_status: from, note },
      });
      return String(patch.status);
    });
    return NextResponse.json({ ok: true, id: params.id, status });
  } catch (err) {
    if (err instanceof AlertActionError) return jsonError(err.message, err.status);
    return jsonError('Write failed', 503);
  }
}
