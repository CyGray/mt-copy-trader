import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { DocumentData } from 'firebase-admin/firestore';
import { validateProfile } from '@shared/executionProfile';
import { getAdminDb, jsonError, readJsonObject } from '@/lib/adminControl';
import { isResponse, requireAdmin, requireUser } from '@/lib/serverAuth';
import {
  actionErrorResponse,
  asString,
  auditWrites,
  changedKeys,
  contentOf,
  DOC_ID_PATTERN,
  metaOf,
  PROFILES_COLLECTION,
  ProfileActionError,
  plain,
  stripServerFields,
  validationRecord,
} from '../_shared';

export const dynamic = 'force-dynamic';

type RouteContext = { params: { docId: string } };

/** GET /api/profiles/[docId]: one version with its profile content and envelope metadata. */
export async function GET(request: NextRequest, { params }: RouteContext) {
  const auth = await requireUser(request);
  if (isResponse(auth)) return auth;
  if (!DOC_ID_PATTERN.test(params.docId)) return jsonError('Invalid doc id', 400);

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  try {
    const snap = await db.collection(PROFILES_COLLECTION).doc(params.docId).get();
    if (!snap.exists) return jsonError('Not found', 404);
    const data: DocumentData = snap.data() ?? {};
    return NextResponse.json({
      doc_id: snap.id,
      status: asString(data.status),
      profile: contentOf(data),
      meta: metaOf(data),
    });
  } catch {
    return jsonError('Read failed', 503);
  }
}

/**
 * PUT /api/profiles/[docId]: replaces the content of a draft. Refused once the
 * version is approved, activated, superseded or rejected. profile_id and version
 * cannot change; the saved document keeps its creation metadata.
 */
export async function PUT(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdmin(request);
  if (isResponse(auth)) return auth;
  if (!DOC_ID_PATTERN.test(params.docId)) return jsonError('Invalid doc id', 400);

  const body = await readJsonObject(request);
  if (!body) return jsonError('Body must be a JSON object', 400);

  const { profile: incoming, notes } = stripServerFields(body);

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  const now = new Date().toISOString();
  const ref = db.collection(PROFILES_COLLECTION).doc(params.docId);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ProfileActionError(404, 'Not found');
      const data: DocumentData = snap.data() ?? {};

      if (data.status !== 'draft') {
        throw new ProfileActionError(409, `Only drafts can be edited (status is ${data.status})`);
      }
      if (incoming.profile_id !== undefined && incoming.profile_id !== data.profile_id) {
        throw new ProfileActionError(400, 'profile_id cannot change', {
          issues: [{ path: 'profile_id', message: 'profile_id cannot change on an existing version' }],
        });
      }
      if (incoming.version !== undefined && incoming.version !== data.version) {
        throw new ProfileActionError(400, 'version cannot change', {
          issues: [{ path: 'version', message: 'version is assigned by the server and cannot change' }],
        });
      }

      const next: Record<string, unknown> = { ...incoming, profile_id: data.profile_id, version: data.version };
      const validation = validateProfile(next);
      const record = validationRecord(validation, now);
      const changed = changedKeys(contentOf(data), next);

      tx.set(ref, {
        ...plain(next),
        status: 'draft',
        validation: record,
        created_at: data.created_at ?? now,
        created_by: data.created_by ?? null,
        created_by_uid: data.created_by_uid ?? null,
        updated_at: now,
        updated_by: auth.email,
        updated_by_uid: auth.uid,
      });
      auditWrites(tx, db, auth, now, {
        action: 'update_draft',
        profileDocId: params.docId,
        details: {
          profile_id: data.profile_id,
          version: data.version,
          validation_ok: validation.ok,
          error_count: validation.errors.length,
          warning_count: validation.warnings.length,
          changed_keys: changed,
          ignored_fields: notes,
        },
      });
      return { validation: record, changed };
    });

    return NextResponse.json({
      ok: true,
      doc_id: params.docId,
      status: 'draft',
      validation: result.validation,
      changed_keys: result.changed,
      notes,
    });
  } catch (err) {
    return actionErrorResponse(err);
  }
}
