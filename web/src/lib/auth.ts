import { signInWithPopup, signOut } from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { firebaseAuth, firestoreDb, googleProvider } from './firebaseClient';

export async function signInWithGoogle(): Promise<void> {
  if (!firebaseAuth || !googleProvider || !firestoreDb) {
    throw new Error('Firebase not initialized');
  }

  const result = await signInWithPopup(firebaseAuth, googleProvider);
  const user = result.user;
  const token = await user.getIdToken();

  const sessionResponse = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  if (!sessionResponse.ok) {
    if (firebaseAuth) {
      await signOut(firebaseAuth);
    }
    const data = (await sessionResponse.json()) as { error?: string };
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.error('[signInWithGoogle] Access denied for email:', user.email, data?.error);
    }
    const message = data.error ?? 'Access denied.';
    const error = new Error(message);
    (error as { code?: string }).code = 'auth/access-denied';
    throw error;
  }

  const userRef = doc(firestoreDb, 'users', user.uid);
  const snap = await getDoc(userRef);

  if (!snap.exists()) {
    await setDoc(userRef, {
      uid: user.uid,
      email: user.email ?? null,
      role: 'viewer',
      created_at: serverTimestamp(),
    });
  }
}

export async function signOutUser(): Promise<void> {
  await fetch('/api/session', { method: 'DELETE' });
  if (firebaseAuth) {
    await signOut(firebaseAuth);
  }
}
