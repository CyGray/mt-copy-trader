'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { signOutUser } from '@/lib/auth';
import { useAuth } from '@/lib/useAuth';
import DashboardShell from '@/components/DashboardShell';
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { firestoreDb } from '@/lib/firebaseClient';

type TelegramStatus =
  | 'disconnected'
  | 'awaiting_code'
  | 'awaiting_password'
  | 'authorized'
  | 'error';

type TelegramStatusResponse = {
  status?: TelegramStatus;
  reauthRequired?: boolean;
  phone?: string | null;
  lastError?: string | null;
};

type RecentSystemLog = {
  id: string;
  timestamp?: string;
  message?: string;
  level?: string;
  component?: string;
};

type RecentTelegramLog = {
  id: string;
  timestamp?: string;
  text?: string;
  chat_id?: string;
};

export default function Home() {
  const { user, role, loading } = useAuth();
  const [workerStatus, setWorkerStatus] = useState<'pending' | 'ok' | 'error'>(
    'pending',
  );
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus>('disconnected');
  const [telegramReauthRequired, setTelegramReauthRequired] = useState(false);
  const [telegramPhone, setTelegramPhone] = useState<string | null>(null);
  const [telegramLastError, setTelegramLastError] = useState<string | null>(null);
  const [openPositions, setOpenPositions] = useState<number>(0);
  const [lastSignal, setLastSignal] = useState<{ symbol?: string; timestamp?: string } | null>(
    null,
  );
  const [statsError, setStatsError] = useState<string | null>(null);
  const [recentSystemLogs, setRecentSystemLogs] = useState<RecentSystemLog[]>([]);
  const [recentTelegramLogs, setRecentTelegramLogs] = useState<RecentTelegramLog[]>([]);

  useEffect(() => {
    let isMounted = true;
    const checkWorker = async () => {
      try {
        const response = await fetch('/api/worker/health', {
          method: 'GET',
          cache: 'no-store',
        });
        if (!response.ok) {
          if (isMounted) setWorkerStatus('error');
          return;
        }
        if (isMounted) setWorkerStatus('ok');
      } catch {
        if (isMounted) setWorkerStatus('error');
      }
    };

    checkWorker();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!firestoreDb) {
      setStatsError('Firestore not initialized.');
      return;
    }

    const db = firestoreDb;
    let cancelled = false;

    const loadStats = async () => {
      try {
        const activeStates = ['OPEN', 'PROTECTION_PLACED', 'ENTRY_PLACED'];
        const tradesQuery = query(
          collection(db, 'trade_sets'),
          where('state', 'in', activeStates),
        );
        const tradeSnapshot = await getDocs(tradesQuery);
        const openCount = tradeSnapshot.docs.length;

        const lastSignalQuery = query(
          collection(db, 'trade_sets'),
          orderBy('created_at', 'desc'),
          limit(1),
        );
        const lastSignalSnapshot = await getDocs(lastSignalQuery);
        const lastDoc = lastSignalSnapshot.docs[0]?.data() as
          | { symbol?: string; created_at?: string }
          | undefined;

        if (!cancelled) {
          setOpenPositions(openCount);
          setLastSignal(
            lastDoc
              ? { symbol: lastDoc.symbol, timestamp: lastDoc.created_at }
              : null,
          );
          setStatsError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setStatsError(error instanceof Error ? error.message : 'Failed to load stats.');
        }
      }
    };

    void loadStats();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!firestoreDb) return;
    const db = firestoreDb;
    let cancelled = false;

    const loadRecentLogs = async () => {
      try {
        const systemQuery = query(
          collection(db, 'system_logs'),
          orderBy('timestamp', 'desc'),
          limit(3),
        );
        const telegramQuery = query(
          collection(db, 'telegram_messages'),
          orderBy('timestamp', 'desc'),
          limit(3),
        );

        const [systemSnap, telegramSnap] = await Promise.all([
          getDocs(systemQuery),
          getDocs(telegramQuery),
        ]);

        if (!cancelled) {
          setRecentSystemLogs(
            systemSnap.docs.map((doc) => ({
              id: doc.id,
              ...(doc.data() as Omit<RecentSystemLog, 'id'>),
            })),
          );
          setRecentTelegramLogs(
            telegramSnap.docs.map((doc) => ({
              id: doc.id,
              ...(doc.data() as Omit<RecentTelegramLog, 'id'>),
            })),
          );
        }
      } catch {
        if (!cancelled) {
          setRecentSystemLogs([]);
          setRecentTelegramLogs([]);
        }
      }
    };

    void loadRecentLogs();

    return () => {
      cancelled = true;
    };
  }, []);

  const workerStatusLabel = useMemo(() => {
    if (workerStatus === 'ok') return 'Operational';
    if (workerStatus === 'error') return 'Unavailable';
    return 'Checking';
  }, [workerStatus]);

  const telegramHealth = useMemo(() => {
    if (telegramStatus === 'authorized') {
      return {
        color: 'bg-emerald-500',
        label: `Logged in as ${telegramPhone ?? 'linked account'}`,
      };
    }
    if (telegramStatus === 'error') {
      return {
        color: 'bg-red-500',
        label: `Error: ${telegramLastError ?? 'session unavailable'}`,
      };
    }
    return { color: 'bg-gray-400', label: 'Not logged in' };
  }, [telegramLastError, telegramPhone, telegramStatus]);

  useEffect(() => {
    let isMounted = true;
    const checkTelegram = async () => {
      try {
        const response = await fetch('/api/telegram/status', {
          method: 'GET',
          cache: 'no-store',
        });
        const data = (await response.json()) as TelegramStatusResponse;
        if (isMounted && data.status) {
          setTelegramStatus(data.status);
        }
        if (isMounted) {
          setTelegramReauthRequired(Boolean(data.reauthRequired));
          setTelegramPhone(data.phone ?? null);
          setTelegramLastError(data.lastError ?? null);
        }
      } catch {
        if (isMounted) setTelegramStatus('error');
      }
    };

    checkTelegram();
    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <DashboardShell
      active="dashboard"
      title="Overview"
    >
      <div className="flex items-center justify-end">
        {user ? (
          <button
            className="rounded-full border border-marine-navy/20 px-4 py-2 text-sm text-marine-navy hover:bg-marine-mist"
            onClick={() => signOutUser()}
          >
            Sign out
          </button>
        ) : (
          <Link
            className="rounded-full bg-marine-navy px-4 py-2 text-sm text-white shadow"
            href="/login"
          >
            Sign in
          </Link>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-2xl border border-marine-navy/10 bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">
            Worker status
          </p>
          <p className="mt-3 text-2xl font-semibold text-marine-navy">{workerStatusLabel}</p>
          <p className="mt-2 text-sm text-marine-navy/70">
            Web: ready · Firestore: connected
          </p>
        </div>
        <div className="rounded-2xl border border-marine-navy/10 bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">
            Open positions
          </p>
          <p className="mt-3 text-2xl font-semibold text-marine-navy">
            {statsError ? '—' : openPositions}
          </p>
          <p className="mt-2 text-sm text-marine-navy/70">Active trade sets</p>
        </div>
        <div className="rounded-2xl border border-marine-navy/10 bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">
            Running PnL
          </p>
          <p className="mt-3 text-2xl font-semibold text-marine-navy">—</p>
          <p className="mt-2 text-sm text-marine-navy/70">Awaiting trade PnL data</p>
        </div>
        <div className="rounded-2xl border border-marine-navy/10 bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">
            Last signal
          </p>
          <p className="mt-3 text-lg font-semibold text-marine-navy">
            {lastSignal?.symbol ?? '—'}
          </p>
          <p className="mt-2 text-sm text-marine-navy/70">
            {lastSignal?.timestamp ?? 'No signals yet'}
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-marine-navy">Session health</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-marine-navy/10 bg-marine-mist px-4 py-3">
            <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">
              Telegram
            </p>
            <div className="mt-2 flex items-center gap-2 text-sm text-marine-navy">
              <span className={`h-2.5 w-2.5 rounded-full ${telegramHealth.color}`} />
              <span className="font-medium">{telegramHealth.label}</span>
              {telegramStatus !== 'authorized' ? (
                <Link className="text-marine-navy/70 underline" href="/telegram">
                  Connect
                </Link>
              ) : null}
              {telegramReauthRequired ? (
                <span className="rounded-full bg-white px-2 py-0.5 text-xs text-marine-navy">
                  Re-auth required
                </span>
              ) : null}
            </div>
          </div>
          <div className="rounded-xl border border-marine-navy/10 bg-marine-mist px-4 py-3">
            <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">
              Worker link
            </p>
            <p className="mt-2 text-sm text-marine-navy/80">
              Keep the worker online to capture and execute incoming signals.
            </p>
          </div>
        </div>
        {statsError ? (
          <p className="mt-3 text-sm text-red-600">{statsError}</p>
        ) : null}
      </div>

      <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-marine-navy">Recent activity</h2>
            <p className="text-sm text-marine-navy/70">
              At-a-glance view of the latest Telegram signals and system logs.
            </p>
          </div>
          <Link className="text-sm text-marine-navy underline" href="/logs">
            View all logs
          </Link>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-marine-navy/10 bg-marine-mist p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">Telegram</p>
            <ul className="mt-3 space-y-2 text-sm text-marine-navy/80">
              {recentTelegramLogs.length === 0 ? (
                <li className="text-marine-navy/60">No recent Telegram logs.</li>
              ) : (
                recentTelegramLogs.map((log) => (
                  <li key={log.id} className="rounded-lg bg-white px-3 py-2">
                    <p className="text-xs text-marine-navy/60">{log.timestamp ?? '—'}</p>
                    <p className="text-sm text-marine-navy">{log.text ?? '—'}</p>
                  </li>
                ))
              )}
            </ul>
          </div>
          <div className="rounded-xl border border-marine-navy/10 bg-marine-mist p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">System</p>
            <ul className="mt-3 space-y-2 text-sm text-marine-navy/80">
              {recentSystemLogs.length === 0 ? (
                <li className="text-marine-navy/60">No recent system logs.</li>
              ) : (
                recentSystemLogs.map((log) => (
                  <li key={log.id} className="rounded-lg bg-white px-3 py-2">
                    <p className="text-xs text-marine-navy/60">{log.timestamp ?? '—'}</p>
                    <p className="text-sm text-marine-navy">
                      {log.component ? `${log.component}: ` : ''}{log.message ?? '—'}
                    </p>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
