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

  await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

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
