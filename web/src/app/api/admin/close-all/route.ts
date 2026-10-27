import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { commitWithAudit, getAdminDb, jsonError, readJsonObject } from '@/lib/adminControl';
import { isResponse, requireAdmin, requireUser } from '@/lib/serverAuth';

export const dynamic = 'force-dynamic';

const CONFIRM_TEXT = 'CLOSE ALL';
const COMMAND_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * POST /api/admin/close-all: queues a close_all command for the AutoTrader to
 * execute. The web app never talks to the broker directly.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (isResponse(auth)) return auth;

  const body = await readJsonObject(request);
  if (!body || body.confirm !== CONFIRM_TEXT) {
    return jsonError(`Type ${CONFIRM_TEXT} to confirm`, 400);
  }

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  const ref = db.collection('admin_commands').doc();
  try {
    await commitWithAudit(db, auth, 'close_all.request', { command_id: ref.id }, (batch) => {
      batch.set(ref, {
        type: 'close_all',
        status: 'pending',
        confirm: CONFIRM_TEXT,
        requested_by_uid: auth.uid,
        requested_by_email: auth.email,
        requested_at: new Date().toISOString(),
      });
    });
  } catch {
    return jsonError('Write failed', 503);
  }

  return NextResponse.json({ ok: true, id: ref.id, status: 'pending' }, { status: 201 });
}

/** GET /api/admin/close-all?id=: status and result of a queued close_all command. */
export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (isResponse(auth)) return auth;

  const id = request.nextUrl.searchParams.get('id') ?? '';
  if (!COMMAND_ID.test(id)) return jsonError('Invalid id', 400);

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  try {
    const snap = await db.collection('admin_commands').doc(id).get();
    if (!snap.exists) return jsonError('Not found', 404);
    const data = snap.data() ?? {};
    return NextResponse.json({
      id: snap.id,
      type: data.type ?? null,
      status: data.status ?? null,
      requested_at: data.requested_at ?? null,
      requested_by_email: data.requested_by_email ?? null,
      started_at: data.started_at ?? null,
      finished_at: data.finished_at ?? null,
      result: data.result ?? null,
    });
  } catch {
    return jsonError('Read failed', 503);
  }
}
