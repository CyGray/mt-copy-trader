import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAdminDb, jsonError, readJsonObject } from '@/lib/adminControl';
import { isResponse, requireAdmin } from '@/lib/serverAuth';
import { actionErrorResponse, DOC_ID_PATTERN, switchActiveProfile } from '../../_shared';

export const dynamic = 'force-dynamic';

/**
 * POST /api/profiles/[docId]/activate: body { confirm: 'ACTIVATE <docId>' }.
 * Approved or superseded -> active. The previously active version becomes superseded.
 */
export async function POST(request: NextRequest, { params }: { params: { docId: string } }) {
  const auth = await requireAdmin(request);
  if (isResponse(auth)) return auth;
  if (!DOC_ID_PATTERN.test(params.docId)) return jsonError('Invalid doc id', 400);

  const body = await readJsonObject(request);
  if (!body || body.confirm !== `ACTIVATE ${params.docId}`) {
    return jsonError(`Type ACTIVATE ${params.docId} to confirm`, 400);
  }

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  try {
    const result = await switchActiveProfile(db, auth, { docId: params.docId, rollback: false });
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
