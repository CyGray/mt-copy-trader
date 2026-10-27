import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { profileDocId, validateProfile } from '@shared/executionProfile';
import { getAdminDb, jsonError, readJsonObject, SETTINGS_COLLECTION, SETTINGS_DOC_ID } from '@/lib/adminControl';
import { isResponse, requireAdmin, requireUser } from '@/lib/serverAuth';
import {
  actionErrorResponse,
  asString,
  auditWrites,
  PROFILE_ID_PATTERN,
  PROFILES_COLLECTION,
  plain,
  stripServerFields,
  validationRecord,
} from './_shared';

export const dynamic = 'force-dynamic';

function summaryOf(snap: QueryDocumentSnapshot) {
  const data = snap.data();
  const validation = (data.validation ?? {}) as Record<string, unknown>;
  return {
    doc_id: snap.id,
    profile_id: asString(data.profile_id),
    version: typeof data.version === 'number' ? data.version : null,
    name: asString(data.name),
    status: asString(data.status),
    validation: {
      ok: validation.ok === true,
      error_count: Array.isArray(validation.errors) ? validation.errors.length : 0,
      warning_count: Array.isArray(validation.warnings) ? validation.warnings.length : 0,
      validated_at: asString(validation.validated_at),
    },
    created_at: asString(data.created_at),
    approved_at: asString(data.approved_at),
    activated_at: asString(data.activated_at),
    superseded_at: asString(data.superseded_at),
    updated_at: asString(data.updated_at),
  };
}

/** GET /api/profiles: all profile versions (profile_id asc, version desc) and the active doc id. */
export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (isResponse(auth)) return auth;

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  try {
    const [profilesSnap, settingsSnap] = await Promise.all([
      db.collection(PROFILES_COLLECTION).get(),
      db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC_ID).get(),
    ]);
    const profiles = profilesSnap.docs.map(summaryOf).sort((a, b) => {
      const byId = (a.profile_id ?? '').localeCompare(b.profile_id ?? '');
      return byId !== 0 ? byId : (b.version ?? 0) - (a.version ?? 0);
    });
    const execution = (settingsSnap.data()?.execution ?? {}) as Record<string, unknown>;
    return NextResponse.json({
      profiles,
      active_profile_doc_id: asString(execution.active_profile_doc_id),
    });
  } catch {
    return jsonError('Read failed', 503);
  }
}

/**
 * POST /api/profiles: creates a draft. The server assigns `version` inside the
 * transaction. Drafts may be saved invalid so they can be fixed; only a missing or
 * malformed profile_id is refused, because it is needed for the document id.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (isResponse(auth)) return auth;

  const body = await readJsonObject(request);
  if (!body) return jsonError('Body must be a JSON object', 400);

  const { profile, notes } = stripServerFields(body, ['version']);
  const profileId = profile.profile_id;
  if (typeof profileId !== 'string' || !PROFILE_ID_PATTERN.test(profileId)) {
    return jsonError('profile_id is required: 3 to 48 characters, a-z, 0-9 and hyphens, starting with a letter or digit', 400, {
      issues: [{ path: 'profile_id', message: 'missing or invalid profile_id' }],
    });
  }

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  const now = new Date().toISOString();
  const profilesCol = db.collection(PROFILES_COLLECTION);

  try {
    const created = await db.runTransaction(async (tx) => {
      const existing = await tx.get(profilesCol.where('profile_id', '==', profileId));
      const highest = existing.docs.reduce((max, doc) => {
        const version = doc.data().version;
        return typeof version === 'number' && version > max ? version : max;
      }, 0);
      const version = highest + 1;

      const ref = profilesCol.doc(profileDocId(profileId, version));
      const validation = validateProfile({ ...profile, version });
      const record = validationRecord(validation, now);

      tx.create(ref, {
        ...plain(profile),
        version,
        status: 'draft',
        validation: record,
        created_at: now,
        created_by: auth.email,
        created_by_uid: auth.uid,
        updated_at: now,
        updated_by: auth.email,
      });
      auditWrites(tx, db, auth, now, {
        action: 'create_draft',
        profileDocId: ref.id,
        details: {
          profile_id: profileId,
          version,
          validation_ok: validation.ok,
          error_count: validation.errors.length,
          warning_count: validation.warnings.length,
          ignored_fields: notes,
        },
      });
      return { docId: ref.id, version, validation: record };
    });

    return NextResponse.json(
      {
        ok: true,
        doc_id: created.docId,
        profile_id: profileId,
        version: created.version,
        status: 'draft',
        validation: created.validation,
        notes,
      },
      { status: 201 },
    );
  } catch (err) {
    return actionErrorResponse(err);
  }
}
