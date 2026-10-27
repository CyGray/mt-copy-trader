import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  validateProfile,
  validateProfileAgainstSafety,
  type ValidationIssue,
} from '@shared/executionProfile';
import { getAdminDb, jsonError, readJsonObject, SETTINGS_COLLECTION, SETTINGS_DOC_ID } from '@/lib/adminControl';
import { buildProfilePreview, parsePreviewInput, type ProfilePreview } from '@/lib/profilePreview';
import { isResponse, requireUser } from '@/lib/serverAuth';
import { isRecord, safetyFromSettings, stripServerFields } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * POST /api/profiles/validate: read-only. Body { profile, preview? }.
 * Returns the validation of the profile, its safety issues against the current
 * settings.safety, and (optionally) the execution preview for a sample signal.
 * A draft without `version` is validated as version 1 for this check only.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (isResponse(auth)) return auth;

  const body = await readJsonObject(request);
  if (!body) return jsonError('Body must be a JSON object', 400);
  if (!isRecord(body.profile)) return jsonError('profile must be a JSON object', 400);

  const previewRequested = body.preview !== undefined && body.preview !== null;
  const preview = previewRequested ? parsePreviewInput(body.preview) : null;
  if (preview && !preview.ok) return jsonError(`Invalid preview: ${preview.error}`, 400);

  const { profile: incoming, notes: ignoredNotes } = stripServerFields(body.profile);
  const notes: string[] = [...ignoredNotes];
  let candidate: Record<string, unknown> = incoming;
  if (candidate.version === undefined) {
    candidate = { ...incoming, version: 1 };
    notes.push(
      'version was missing, so the profile was validated as version 1 for this check only. The server assigns the real version when the draft is saved.',
    );
  }

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  let settings: Record<string, unknown> | undefined;
  try {
    const snap = await db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC_ID).get();
    settings = snap.data();
  } catch {
    return jsonError('Read failed', 503);
  }

  const validation = validateProfile(candidate);
  const safety = safetyFromSettings(settings);
  let safetyIssues: ValidationIssue[] = [];
  let previewResult: ProfilePreview | null = null;

  if (!validation.ok || !validation.value) {
    notes.push('Safety check and preview are skipped until the profile validates.');
  } else if (!safety.ok) {
    safetyIssues = [
      { path: 'settings.safety', message: 'Stored safety limits are invalid, so no profile can be approved or activated.' },
    ];
    if (preview) notes.push('Preview skipped: stored safety limits are invalid.');
  } else {
    safetyIssues = validateProfileAgainstSafety(validation.value, safety.limits);
    if (preview && preview.ok) {
      previewResult = buildProfilePreview(validation.value, safety.limits, preview.value);
    }
  }

  return NextResponse.json({
    validation: {
      ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
    },
    safety: {
      source: safety.source,
      valid: safety.ok,
      errors: safety.ok ? [] : safety.errors,
    },
    safetyIssues,
    preview: previewResult,
    notes,
  });
}
