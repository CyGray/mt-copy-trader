import admin from 'firebase-admin';

let firestore: FirebaseFirestore.Firestore | null = null;

export function initFirestore(): FirebaseFirestore.Firestore | null {
  if (firestore) return firestore;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

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
  return firestore;
}

export function getFirestore(): FirebaseFirestore.Firestore | null {
  return firestore;
}
