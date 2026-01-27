import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { firebaseAuth, firestoreDb } from './firebaseClient';

export type UserRole = 'admin' | 'viewer' | 'unknown';

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<UserRole>('unknown');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Firebase not initialized (SSR or init failure)
    if (!firebaseAuth) {
      setLoading(false);
      return;
    }

    const unsubscribe = onAuthStateChanged(firebaseAuth, async (nextUser) => {
      setUser(nextUser);

      if (!nextUser) {
        setRole('unknown');
        setLoading(false);
        return;
      }

      if (!firestoreDb) {
        setRole('viewer');
        setLoading(false);
        return;
      }

      try {
        const userRef = doc(firestoreDb, 'users', nextUser.uid);
        const snap = await getDoc(userRef);
        setRole((snap.data()?.role as UserRole) ?? 'viewer');
      } catch (e) {
        console.error('Failed to fetch user role:', e);
        setRole('viewer');
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  return { user, role, loading };
}
