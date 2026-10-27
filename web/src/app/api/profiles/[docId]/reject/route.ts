import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { DocumentData } from 'firebase-admin/firestore';
import { getAdminDb, jsonError, readJsonObject } from '@/lib/adminControl';
import { isResponse, requireAdmin } from '@/lib/serverAuth';
import {
  actionErrorResponse,
  asString,
  auditWrites,
  DOC_ID_PATTERN,
  PROFILES_COLLECTION,
  ProfileActionError,
  plain,
} from '../../_shared';

export const dynamic = 'force-dynamic';

const REJECTABLE = ['draft', 'approved'];

/**
 * POST /api/profiles/[docId]/reject: draft or approved -> rejected. A rejected
 * version can never be activated. Active and superseded versions cannot be rejected.
 * Optional body: { reason?: string }.
 */
export async function POST(request: NextRequest, { params }: { params: { docId: string } }) {
  const auth = await requireAdmin(request);
  if (isResponse(auth)) return auth;
  if (!DOC_ID_PATTERN.test(params.docId)) return jsonError('Invalid doc id', 400);

  const body = (await readJsonObject(request)) ?? {};
  const reason = asString(body.reason)?.trim().slice(0, 500) || null;

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  const now = new Date().toISOString();
  const ref = db.collection(PROFILES_COLLECTION).doc(params.docId);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ProfileActionError(404, 'Not found');
      const data: DocumentData = snap.data() ?? {};
      if (!REJECTABLE.includes(data.status)) {
        throw new ProfileActionError(409, `Only drafts or approved versions can be rejected (status is ${data.status})`);
      }

      tx.update(ref, {
        status: 'rejected',
        rejected_at: now,
        rejected_by: auth.email,
        rejected_by_uid: auth.uid,
        rejected_reason: reason,
        updated_at: now,
        updated_by: auth.email,
      });
      auditWrites(tx, db, auth, now, {
        action: 'reject',
        profileDocId: params.docId,
        details: plain({
          profile_id: data.profile_id,
          version: data.version,
          from_status: data.status,
          reason,
        }),
      });
    });

    return NextResponse.json({ ok: true, doc_id: params.docId, status: 'rejected' });
  } catch (err) {
    return actionErrorResponse(err);
  }
}
