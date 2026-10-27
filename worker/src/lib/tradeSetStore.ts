/**
 * tradeSetStore.ts
 *
 * Firestore access for `trade_sets/{chatId}_{messageId}` (schema 2). The only
 * module that writes trade set documents; the engine, lifecycle manager and
 * reconciler all go through it.
 *
 * Writes that must not run without persistence throw PersistenceUnavailableError
 * (no Firestore client). Nothing here swallows errors. Callers decide what a
 * failure means for broker state.
 *
 * `set(..., { merge: true })` replaces arrays and merges nested maps, so callers
 * pass whole `lifecycle` and `plan` objects.
 */

import { initFirestore } from './firestoreAdmin';
import type { TradeSetDoc, TradeState } from './tradeSetTypes';

const COLLECTION = 'trade_sets';
const ALREADY_EXISTS_CODE = 6;

export class PersistenceUnavailableError extends Error {
  constructor(message = 'Firestore is not configured or unavailable') {
    super(message);
    this.name = 'PersistenceUnavailableError';
  }
}

/** Returns the Firestore client, or throws PersistenceUnavailableError. */
export function requireFirestore(): FirebaseFirestore.Firestore {
  const firestore = initFirestore();
  if (!firestore) throw new PersistenceUnavailableError();
  return firestore;
}

/** Deep copy without undefined-valued keys. Arrays and plain objects are walked; null is kept. */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== undefined).map((item) => stripUndefined(item)) as unknown as T;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (inner !== undefined) out[key] = stripUndefined(inner);
    }
    return out as T;
  }
  return value;
}

function isAlreadyExists(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { code?: unknown }).code === ALREADY_EXISTS_CODE) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('ALREADY_EXISTS');
}

/** Returns the stored document as-is (schema-1 legacy documents included; callers check `schema`), or null. */
export async function getTradeSet(id: string): Promise<TradeSetDoc | null> {
  const snap = await requireFirestore().collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  return snap.data() as unknown as TradeSetDoc;
}

/** Atomic claim: 'created' on success, 'exists' when the document id is taken. Other errors throw. */
export async function createTradeSet(doc: TradeSetDoc): Promise<'created' | 'exists'> {
  const ref = requireFirestore().collection(COLLECTION).doc(doc.trade_set_id);
  try {
    await ref.create(stripUndefined(doc) as unknown as Record<string, unknown>);
    return 'created';
  } catch (err) {
    if (isAlreadyExists(err)) return 'exists';
    throw err;
  }
}

/** Merges `patch` into the document and stamps updated_at. Throws on failure. */
export async function updateTradeSet(id: string, patch: Record<string, unknown>): Promise<void> {
  await requireFirestore()
    .collection(COLLECTION)
    .doc(id)
    .set(stripUndefined({ ...patch, updated_at: new Date().toISOString() }), { merge: true });
}

/**
 * Compare-and-set on `state`: applies `patch` only if the document exists and its
 * current state is one of `fromStates`. Returns false otherwise, and does not write.
 */
export async function transitionTradeSet(
  id: string,
  fromStates: readonly TradeState[],
  patch: Record<string, unknown>,
): Promise<boolean> {
  const firestore = requireFirestore();
  const ref = firestore.collection(COLLECTION).doc(id);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const state = (snap.data() as { state?: TradeState } | undefined)?.state;
    if (state === undefined || !fromStates.includes(state)) return false;
    tx.set(ref, stripUndefined({ ...patch, updated_at: new Date().toISOString() }), { merge: true });
    return true;
  });
}

/** Schema-2 trade sets whose state is one of `states`. Empty `states` returns []. */
export async function listTradeSetsByState(states: readonly TradeState[]): Promise<TradeSetDoc[]> {
  if (states.length === 0) return [];
  const snap = await requireFirestore()
    .collection(COLLECTION)
    .where('schema', '==', 2)
    .where('state', 'in', [...states])
    .get();
  return snap.docs.map((doc) => doc.data() as unknown as TradeSetDoc);
}
