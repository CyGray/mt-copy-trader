import admin from 'firebase-admin';

const INIT_FAILURE_RETRY_MS = 60_000;

let firestore: FirebaseFirestore.Firestore | null = null;
let initFailedAt = 0;

/**
 * Returns the shared Firestore client, or null when not configured or when
 * initialisation failed. Never throws. A failed init is cached for 60 s so a
 * malformed credential does not re-run (and re-log) on every call.
 */
export function initFirestore(): FirebaseFirestore.Firestore | null {
  if (firestore) return firestore;
  if (initFailedAt && Date.now() - initFailedAt < INIT_FAILURE_RETRY_MS) return null;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
    }

    firestore = admin.firestore();
    initFailedAt = 0;
    return firestore;
  } catch (err) {
    initFailedAt = Date.now();
    const raw = err instanceof Error ? err.message : String(err);
    const message = raw.split(privateKey).join('[redacted]');
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'firestore_init_failed',
        payload: { error: message },
        timestamp: new Date().toISOString(),
      }),
    );
    return null;
  }
}

export function getFirestore(): FirebaseFirestore.Firestore | null {
  return firestore;
}
