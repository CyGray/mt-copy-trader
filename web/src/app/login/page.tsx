'use client';

import { signInWithGoogle } from '@/lib/auth';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  'auth/configuration-not-found':
    'Firebase Auth is not configured for this project. Double-check your Firebase config and enabled providers.',
  'auth/unauthorized-domain':
    'This domain is not authorized for Firebase Auth. Add localhost to Authorized domains in Firebase Console.',
};

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSignIn = async () => {
    setError(null);
    setLoading(true);
    try {
      await signInWithGoogle();
      router.replace('/');
    } catch (err) {
      const code =
        typeof err === 'object' && err && 'code' in err
          ? String((err as { code?: unknown }).code)
          : 'unknown';
      setError(AUTH_ERROR_MESSAGES[code] ?? 'Sign-in failed. Check console for details.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <div className="rounded-2xl border border-marine-navy/10 bg-white p-8 shadow-sm">
        <div className="flex items-center gap-3">
          <img
            src="/logo.png"
            alt="Marine Trader logo"
            className="h-12 w-12 rounded-full bg-marine-mist object-contain"
          />
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-marine-navy/60">Marine Trader</p>
            <h1 className="text-2xl font-semibold text-marine-navy">Sign in</h1>
          </div>
        </div>
        <p className="mt-3 text-sm text-marine-navy/70">
          Sign in with Google to access the Marine Trader command dashboard.
        </p>
      {error ? (
          <div className="mt-6 rounded border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600">
            {error}
          </div>
      ) : null}
        <button
          className="mt-6 w-full rounded-full bg-marine-navy px-4 py-2 text-sm font-medium text-white shadow disabled:cursor-not-allowed disabled:opacity-70"
          onClick={handleSignIn}
          disabled={loading}
        >
          {loading ? 'Signing in…' : 'Continue with Google'}
        </button>
      </div>
    </main>
  );
}
