/**
 * Server-side helpers for the execution profile routes (admin SDK only).
 *
 * Every mutation runs in one Firestore transaction that also writes the
 * execution_profile_audit entry and the admin_audit entry. Stored documents hold
 * the profile fields plus server-owned envelope fields (status, validation,
 * timestamps); validation always runs on the profile fields alone.
 * Contracts: docs/project_memory/VANTAGE_DESIGN_CONTRACTS.md sections 5 and 8.
 */
import { NextResponse } from 'next/server';
import type { DocumentData, Firestore, Transaction } from 'firebase-admin/firestore';
import {
  DEFAULT_SAFETY_LIMITS,
  PROFILE_ENVELOPE_FIELDS,
  validateProfile,
  validateProfileAgainstSafety,
  validateSafetyLimits,
  type SafetyLimits,
  type ValidationIssue,
} from '@shared/executionProfile';
import { AUDIT_COLLECTION, jsonError, SETTINGS_COLLECTION, SETTINGS_DOC_ID } from '@/lib/adminControl';
import type { AuthenticatedUser } from '@/lib/serverAuth';

export const PROFILES_COLLECTION = 'execution_profiles';
export const PROFILE_AUDIT_COLLECTION = 'execution_profile_audit';
export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,47}$/;
export const DOC_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,47}__v[1-9][0-9]{0,8}$/;

/** Fields the server owns (shared with the AutoTrader). Client input carrying them is stripped and reported in `notes`. */
const SERVER_FIELDS = PROFILE_ENVELOPE_FIELDS;

/** Envelope fields returned to the dashboard next to the profile content. */
const META_FIELDS = [
  'validation',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
  'approved_at',
  'approved_by',
  'activated_at',
  'activated_by',
  'superseded_at',
  'rejected_at',
  'rejected_by',
  'rejected_reason',
];

export type AuditAction = 'create_draft' | 'update_draft' | 'approve' | 'reject' | 'activate' | 'rollback';

/** A refusal with an HTTP status. Thrown inside transactions, so nothing is written. */
export class ProfileActionError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown> | undefined;

  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'ProfileActionError';
    this.status = status;
    this.extra = extra;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Firestore rejects undefined; a JSON round trip drops it and keeps the rest. */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Removes server-owned fields (plus any `extra` keys) from client input. */
export function stripServerFields(
  input: Record<string, unknown>,
  extra: string[] = [],
): { profile: Record<string, unknown>; notes: string[] } {
  const profile: Record<string, unknown> = {};
  const notes: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (SERVER_FIELDS.includes(key) || extra.includes(key)) {
      notes.push(`Ignored server-managed field "${key}".`);
    } else {
      profile[key] = value;
    }
  }
  return { profile, notes };
}

/** Profile fields of a stored document (envelope removed, version kept). */
export function contentOf(data: DocumentData): Record<string, unknown> {
  return stripServerFields(data).profile;
}

export function metaOf(data: DocumentData): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const key of META_FIELDS) {
    meta[key] = data[key] ?? null;
  }
  return meta;
}

export function validationRecord(
  result: { ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] },
  at: string,
): Record<string, unknown> {
  return plain({ ok: result.ok, errors: result.errors, warnings: result.warnings, validated_at: at });
}

export type SafetyState =
  | { ok: true; source: 'stored' | 'default'; limits: SafetyLimits }
  | { ok: false; source: 'stored'; errors: ValidationIssue[] };

/**
 * Current safety limits. Absent settings.safety falls back to the conservative
 * defaults; present but invalid settings.safety blocks profile use entirely.
 */
export function safetyFromSettings(settings: DocumentData | undefined): SafetyState {
  const raw = settings?.safety;
  if (raw === undefined || raw === null) {
    return { ok: true, source: 'default', limits: DEFAULT_SAFETY_LIMITS };
  }
  const result = validateSafetyLimits(raw);
  if (!result.ok || !result.value) {
    return { ok: false, source: 'stored', errors: result.errors };
  }
  return { ok: true, source: 'stored', limits: result.value };
}

/** Top-level fields whose values differ between two profile objects. */
export function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort();
}

/**
 * Adds the execution_profile_audit entry and the admin_audit entry to a
 * transaction. Both carry the same actor, time and details.
 */
export function auditWrites(
  tx: Transaction,
  db: Firestore,
  actor: AuthenticatedUser,
  at: string,
  entry: {
    action: AuditAction;
    profileDocId: string;
    previousActiveDocId?: string | null;
    details?: Record<string, unknown>;
  },
): void {
  const details = plain(entry.details ?? {});
  const previous = entry.previousActiveDocId === undefined ? {} : { previous_active_doc_id: entry.previousActiveDocId };

  tx.set(db.collection(PROFILE_AUDIT_COLLECTION).doc(), {
    action: entry.action,
    profile_doc_id: entry.profileDocId,
    ...previous,
    actor_uid: actor.uid,
    actor_email: actor.email,
    at,
    details,
  });
  tx.set(db.collection(AUDIT_COLLECTION).doc(), {
    action: `profile.${entry.action}`,
    actor_uid: actor.uid,
    actor_email: actor.email,
    at,
    details: { profile_doc_id: entry.profileDocId, ...previous, ...details },
  });
}

/**
 * Makes `targetId` the active profile in one transaction: the previous active
 * version becomes superseded, the target becomes active, and
 * settings/default.execution.active_profile_doc_id is updated. Refuses unless the
 * target validates and passes the CURRENT safety limits. Trades already open keep
 * their frozen profile_snapshot.
 */
export async function switchActiveProfile(
  db: Firestore,
  actor: AuthenticatedUser,
  options: { docId: string | null; rollback: boolean },
): Promise<{ docId: string; previousActiveDocId: string | null; notes: string[] }> {
  const now = new Date().toISOString();
  const profilesCol = db.collection(PROFILES_COLLECTION);
  const settingsRef = db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC_ID);

  return db.runTransaction(async (tx) => {
    // All reads happen before the first write.
    const settingsSnap = await tx.get(settingsRef);
    const settings = settingsSnap.data();
    const execution = isRecord(settings?.execution) ? settings.execution : {};
    const previousId = asString(execution.active_profile_doc_id);

    let targetId = options.docId;
    if (!targetId && options.rollback) {
      const superseded = await tx.get(profilesCol.where('status', '==', 'superseded'));
      let best: { id: string; at: string } | null = null;
      for (const doc of superseded.docs) {
        const at = asString(doc.data().activated_at);
        if (at && (!best || at > best.at)) best = { id: doc.id, at };
      }
      if (!best) throw new ProfileActionError(409, 'No superseded version to roll back to');
      targetId = best.id;
    }
    if (!targetId) throw new ProfileActionError(400, 'docId is required');

    const ref = profilesCol.doc(targetId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ProfileActionError(404, 'Not found');
    const data = snap.data() as DocumentData;

    if (options.rollback ? data.status !== 'superseded' : !['approved', 'superseded'].includes(data.status)) {
      throw new ProfileActionError(
        409,
        options.rollback
          ? `Only superseded versions can be rolled back to (status is ${data.status})`
          : `Only approved or superseded versions can be activated (status is ${data.status})`,
      );
    }

    const validation = validateProfile(contentOf(data));
    if (!validation.ok || !validation.value) {
      throw new ProfileActionError(422, 'Profile does not validate', { issues: validation.errors });
    }
    const safety = safetyFromSettings(settings);
    if (!safety.ok) {
      throw new ProfileActionError(409, 'Stored safety limits are invalid; fix settings.safety first', {
        issues: safety.errors,
      });
    }
    const safetyIssues = validateProfileAgainstSafety(validation.value, safety.limits);
    if (safetyIssues.length > 0) {
      throw new ProfileActionError(422, 'Profile exceeds the current safety limits', { issues: safetyIssues });
    }

    const previousRef = previousId && previousId !== targetId ? profilesCol.doc(previousId) : null;
    const previousSnap = previousRef ? await tx.get(previousRef) : null;

    if (previousRef && previousSnap?.exists && previousSnap.data()?.status === 'active') {
      tx.update(previousRef, { status: 'superseded', superseded_at: now, updated_at: now, updated_by: actor.email });
    }
    tx.update(ref, {
      status: 'active',
      activated_at: now,
      activated_by: actor.email,
      activated_by_uid: actor.uid,
      validation: validationRecord(validation, now),
      updated_at: now,
      updated_by: actor.email,
    });
    // merge: true deep-merges the execution map, so execution.mode is preserved.
    tx.set(
      settingsRef,
      { execution: { active_profile_doc_id: targetId, updated_at: now, updated_by: actor.email } },
      { merge: true },
    );
    auditWrites(tx, db, actor, now, {
      action: options.rollback ? 'rollback' : 'activate',
      profileDocId: targetId,
      previousActiveDocId: previousId,
      details: {
        profile_id: data.profile_id,
        version: data.version,
        from_status: data.status,
        warnings: validation.warnings.length,
        safety_source: safety.source,
      },
    });

    return {
      docId: targetId,
      previousActiveDocId: previousId,
      notes: [
        'Open trades keep their frozen profile_snapshot. This change applies to new entries only.',
      ],
    };
  });
}

/** Maps a thrown error to a JSON response. Firestore abort and already-exists codes become 409. */
export function actionErrorResponse(err: unknown): NextResponse {
  if (err instanceof ProfileActionError) {
    return jsonError(err.message, err.status, err.extra);
  }
  const code = (err as { code?: unknown })?.code;
  if (code === 6 || code === 10 || code === 'aborted' || code === 'already-exists') {
    return jsonError('Concurrent change, retry the request', 409);
  }
  return jsonError('Write failed', 503);
}
