import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAdminDb, jsonError, readJsonObject } from '@/lib/adminControl';
import { isResponse, requireAdmin } from '@/lib/serverAuth';
import { actionErrorResponse, DOC_ID_PATTERN, switchActiveProfile } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * POST /api/profiles/rollback: body { docId?: string }. Re-activates a superseded
 * version. Without docId, the most recently activated superseded version is chosen.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (isResponse(auth)) return auth;

  const body = (await readJsonObject(request)) ?? {};
  const docId = typeof body.docId === 'string' && body.docId ? body.docId : null;
  if (docId !== null && !DOC_ID_PATTERN.test(docId)) return jsonError('Invalid doc id', 400);

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  try {
    const result = await switchActiveProfile(db, auth, { docId, rollback: true });
    return NextResponse.json({
      ok: true,
      doc_id: result.docId,
      status: 'active',
      previous_active_doc_id: result.previousActiveDocId,
      notes: result.notes,
    });
  } catch (err) {
    return actionErrorResponse(err);
  }
}
