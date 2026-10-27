import { signInWithPopup, signOut } from 'firebase/auth';
import { firebaseAuth, googleProvider } from './firebaseClient';

export async function signInWithGoogle(): Promise<void> {
  if (!firebaseAuth || !googleProvider) {
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

  // First sign-in: the server creates users/{uid} as viewer if it is missing.
  // Client writes to users/ are denied by firestore.rules.
  const ensureResponse = await fetch('/api/users/ensure', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!ensureResponse.ok) {
    const data = (await ensureResponse.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? 'Could not create the user profile.');
  }
}

export async function signOutUser(): Promise<void> {
  await fetch('/api/session', { method: 'DELETE' });
  if (firebaseAuth) {
    await signOut(firebaseAuth);
  }
}
