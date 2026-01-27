import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { firebaseAuth, firestoreDb } from './firebaseClient';

export type UserRole = 'admin' | 'viewer' | 'unknown';

async function fetchRoleFromApi(token: string): Promise<UserRole | null> {
  try {
    const response = await fetch('/api/admin/role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as { role?: UserRole };
    if (data.role === 'admin' || data.role === 'viewer') return data.role;
    return null;
  } catch {
    return null;
  }
}

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

      let resolvedRole: UserRole | null = null;

      if (firestoreDb) {
        try {
          const userRef = doc(firestoreDb, 'users', nextUser.uid);
          const snap = await getDoc(userRef);
          const role = snap.data()?.role as UserRole | undefined;
          if (role === 'admin' || role === 'viewer') {
            resolvedRole = role;
          }
        } catch (e) {
          console.error('Failed to fetch user role from Firestore:', e);
        }
      }

      if (!resolvedRole) {
        try {
          const token = await nextUser.getIdToken();
          resolvedRole = await fetchRoleFromApi(token);
        } catch (e) {
          console.error('Failed to fetch user role from API:', e);
        }
      }

      setRole(resolvedRole ?? 'viewer');
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  return { user, role, loading };
}
