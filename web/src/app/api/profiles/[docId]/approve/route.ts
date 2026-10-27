import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { DocumentData } from 'firebase-admin/firestore';
import { validateProfile, validateProfileAgainstSafety } from '@shared/executionProfile';
import { getAdminDb, jsonError, SETTINGS_COLLECTION, SETTINGS_DOC_ID } from '@/lib/adminControl';
import { isResponse, requireAdmin } from '@/lib/serverAuth';
import {
  actionErrorResponse,
  auditWrites,
  contentOf,
  DOC_ID_PATTERN,
  PROFILES_COLLECTION,
  ProfileActionError,
  safetyFromSettings,
  validationRecord,
} from '../../_shared';

export const dynamic = 'force-dynamic';

/**
 * POST /api/profiles/[docId]/approve: draft -> approved. Requires a passing
 * validateProfile and no validateProfileAgainstSafety issues. The content is
 * immutable from here on; changes need a new version.
 */
export async function POST(request: NextRequest, { params }: { params: { docId: string } }) {
  const auth = await requireAdmin(request);
  if (isResponse(auth)) return auth;
  if (!DOC_ID_PATTERN.test(params.docId)) return jsonError('Invalid doc id', 400);

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  const now = new Date().toISOString();
  const ref = db.collection(PROFILES_COLLECTION).doc(params.docId);
  const settingsRef = db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC_ID);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ProfileActionError(404, 'Not found');
      const data: DocumentData = snap.data() ?? {};
      if (data.status !== 'draft') {
        throw new ProfileActionError(409, `Only drafts can be approved (status is ${data.status})`);
      }

      const settingsSnap = await tx.get(settingsRef);
      const validation = validateProfile(contentOf(data));
      if (!validation.ok || !validation.value) {
        throw new ProfileActionError(422, 'Profile does not validate', { issues: validation.errors });
      }
      const safety = safetyFromSettings(settingsSnap.data());
      if (!safety.ok) {
        throw new ProfileActionError(409, 'Stored safety limits are invalid; fix settings.safety first', {
          issues: safety.errors,
        });
      }
      const safetyIssues = validateProfileAgainstSafety(validation.value, safety.limits);
      if (safetyIssues.length > 0) {
        throw new ProfileActionError(422, 'Profile exceeds the current safety limits', { issues: safetyIssues });
      }

      tx.update(ref, {
        status: 'approved',
        approved_at: now,
        approved_by: auth.email,
        approved_by_uid: auth.uid,
        validation: validationRecord(validation, now),
        updated_at: now,
        updated_by: auth.email,
      });
      auditWrites(tx, db, auth, now, {
        action: 'approve',
        profileDocId: params.docId,
        details: {
          profile_id: data.profile_id,
          version: data.version,
          warning_count: validation.warnings.length,
          safety_source: safety.source,
        },
      });
    });

    return NextResponse.json({ ok: true, doc_id: params.docId, status: 'approved' });
  } catch (err) {
    return actionErrorResponse(err);
  }
}
