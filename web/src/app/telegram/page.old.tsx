'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/useAuth';

type TelegramStatus =
  | 'disconnected'
  | 'awaiting_code'
  | 'awaiting_password'
  | 'authorized'
  | 'error';

type TelegramStatusResponse = {
  status: TelegramStatus;
  phone: string | null;
  lastError: string | null;
  reauthRequired?: boolean;
};

export default function TelegramPage() {
  const { user, loading: authLoading } = useAuth();
  const [status, setStatus] = useState<TelegramStatus>('disconnected');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reauthRequired, setReauthRequired] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/login');
    }
  }, [authLoading, user, router]);

  const refreshStatus = async () => {
    try {
      const response = await fetch('/api/telegram/status', { cache: 'no-store' });
      const data = (await response.json()) as TelegramStatusResponse;
      setStatus(data.status);
      setError(data.lastError ?? null);
      setReauthRequired(Boolean(data.reauthRequired));
    } catch {
      setStatus('error');
      setError('Worker unreachable');
      setReauthRequired(false);
    }
  };

  useEffect(() => {
    void refreshStatus();
  }, []);

  useEffect(() => {
    if (status === 'awaiting_code' || status === 'awaiting_password') {
      const interval = setInterval(async () => {
        const response = await fetch('/api/telegram/status', { cache: 'no-store' });
        const data = (await response.json()) as TelegramStatusResponse;
        setStatus(data.status);
        setError(data.lastError ?? null);
        setReauthRequired(Boolean(data.reauthRequired));
        if (data.status === 'authorized') {
          clearInterval(interval);
          // Redirect to dashboard after short delay
          setTimeout(() => router.push('/'), 1200);
        }
      }, 1200);
      return () => clearInterval(interval);
    }
  }, [status, router]);

  const startLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/telegram/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = (await response.json()) as TelegramStatusResponse & {
        error?: string;
      };
      if (!response.ok) {
        setError(data.error ?? 'Failed to start login');
      }
      setStatus(data.status ?? 'awaiting_code');
    } catch {
      setError('Worker unreachable');
    } finally {
      setLoading(false);
    }
  };

  const submitOtp = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/telegram/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: otp }),
      });
      const data = (await response.json()) as TelegramStatusResponse & {
        error?: string;
      };
      if (!response.ok) {
        setError(data.error ?? 'Invalid code');
      }
      setStatus(data.status ?? 'awaiting_password');
    } catch {
      setError('Worker unreachable');
    } finally {
      setLoading(false);
    }
  };

  const submitPassword = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/telegram/verify-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = (await response.json()) as TelegramStatusResponse & {
        error?: string;
      };
      if (!response.ok) {
        setError(data.error ?? 'Invalid password');
      }
      setStatus(data.status ?? 'authorized');
    } catch {
      setError('Worker unreachable');
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    setLoading(true);
    setError(null);
    try {
      await fetch('/api/telegram/logout', { method: 'POST' });
      await refreshStatus();
    } catch {
      setError('Worker unreachable');
    } finally {
      setLoading(false);
    }
  };

  if (authLoading || !user) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl items-center px-6 py-12">
        <div className="rounded-2xl border border-marine-navy/10 bg-white p-6 text-sm text-marine-navy/70 shadow-sm">
          Checking your session…
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <div className="rounded-2xl border border-marine-navy/10 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <img
              src="/logo.png"
              alt="Marine Trader logo"
              className="h-10 w-10 rounded-full bg-marine-mist object-contain"
            />
            <div>
              <h1 className="text-2xl font-semibold text-marine-navy">Telegram Onboarding</h1>
              <p className="text-sm text-marine-navy/70">
                Connect your Telegram user account to start listening to signals.
              </p>
            </div>
          </div>
          <Link className="text-sm text-marine-navy underline" href="/">
            Back to dashboard
          </Link>
        </div>

        <div className="mt-6 rounded-lg border border-marine-navy/10 bg-marine-mist p-4 text-sm text-marine-navy/80">
          <p>Status: {status}</p>
          {error ? <p className="mt-2 text-red-600">{error}</p> : null}
          {reauthRequired ? (
            <p className="mt-2 text-amber-600">
              Session expired. Please re-authenticate.
            </p>
          ) : null}
        </div>

        {status === 'disconnected' || status === 'error' ? (
          <div className="mt-6 space-y-3">
            <label className="block text-sm text-marine-navy/70">
              Phone number (with country code)
            </label>
            <input
              className="w-full rounded-lg border border-marine-navy/20 bg-white px-3 py-2 text-sm"
              placeholder="+65xxxxxxxx"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
            <button
              className="rounded-full bg-marine-navy px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              onClick={startLogin}
              disabled={loading || !phone}
            >
              {loading ? 'Sending code…' : 'Send code'}
            </button>
          </div>
        ) : null}

        {status === 'awaiting_code' ? (
          <div className="mt-6 space-y-3">
            <label className="block text-sm text-marine-navy/70">Enter OTP</label>
            <input
              className="w-full rounded-lg border border-marine-navy/20 bg-white px-3 py-2 text-sm"
              placeholder="12345"
              value={otp}
              onChange={(event) => setOtp(event.target.value)}
            />
            <button
              className="rounded-full bg-marine-navy px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              onClick={submitOtp}
              disabled={loading || !otp}
            >
              {loading ? 'Verifying…' : 'Verify OTP'}
            </button>
          </div>
        ) : null}

        {status === 'awaiting_password' ? (
          <div className="mt-6 space-y-3">
            <label className="block text-sm text-marine-navy/70">2FA Password</label>
            <input
              className="w-full rounded-lg border border-marine-navy/20 bg-white px-3 py-2 text-sm"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              className="rounded-full bg-marine-navy px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              onClick={submitPassword}
              disabled={loading || !password}
            >
              {loading ? 'Verifying…' : 'Submit password'}
            </button>
          </div>
        ) : null}

        {status === 'authorized' ? (
          <div className="mt-6 space-y-3">
            <p className="text-sm text-emerald-600">Telegram session active. Redirecting…</p>
            <button
              className="rounded-full border border-marine-navy/20 px-4 py-2 text-sm text-marine-navy"
              onClick={logout}
              disabled={loading}
            >
              Disconnect
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}
