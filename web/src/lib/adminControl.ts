import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { Firestore, WriteBatch } from 'firebase-admin/firestore';
import type { AuthenticatedUser } from './serverAuth';
import { getAdminApp } from './firebaseAdmin';

export const SETTINGS_COLLECTION = 'settings';
export const SETTINGS_DOC_ID = 'default';
export const AUDIT_COLLECTION = 'admin_audit';

/** Admin SDK Firestore, or null when firebase-admin is not configured. */
export function getAdminDb(): Firestore | null {
  return getAdminApp()?.firestore() ?? null;
}

export function jsonError(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

/** Parses a JSON object body. Returns null when the body is missing, malformed or not an object. */
export async function readJsonObject(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Writes the given changes and an admin_audit entry in one atomic batch.
 * `mergeFields` limits the write to the listed dotted paths, so sibling fields
 * (for example execution.active_profile_doc_id) are never wiped.
 */
export async function commitWithAudit(
  db: Firestore,
  actor: AuthenticatedUser,
  action: string,
  details: Record<string, unknown>,
  write: (batch: WriteBatch) => void,
): Promise<void> {
  const batch = db.batch();
  write(batch);
  batch.set(db.collection(AUDIT_COLLECTION).doc(), {
    action,
    actor_uid: actor.uid,
    actor_email: actor.email,
    at: new Date().toISOString(),
    details,
  });
  await batch.commit();
}

export function settingsRef(db: Firestore) {
  return db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC_ID);
}
