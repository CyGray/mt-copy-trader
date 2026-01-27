'use client';

import { useEffect, useMemo, useState } from 'react';
import DashboardShell from '@/components/DashboardShell';
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  QueryDocumentSnapshot,
  DocumentData,
} from 'firebase/firestore';
import { firestoreDb } from '@/lib/firebaseClient';

const PAGE_SIZE = 20;

type TelegramMessageRow = {
  id: string;
  timestamp?: string;
  text?: string;
  type?: string;
  chat_id?: string;
  message_id?: string;
  parsed_ok?: boolean;
  parse_error?: string | null;
  parsed?: {
    symbol?: string;
    direction?: string;
    stopLoss?: number;
    takeProfits?: number[];
  } | null;
};

type SystemLogRow = {
  id: string;
  timestamp?: string;
  level?: string;
  component?: string;
  message?: string;
  details?: Record<string, unknown> | null;
};

type LogTab = 'telegram' | 'system';

export default function LogsPage() {
  const [activeTab, setActiveTab] = useState<LogTab>('telegram');
  const [telegramLogs, setTelegramLogs] = useState<TelegramMessageRow[]>([]);
  const [systemLogs, setSystemLogs] = useState<SystemLogRow[]>([]);
  const [telegramCursor, setTelegramCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(
    null,
  );
  const [systemCursor, setSystemCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const loadLogs = async (tab: LogTab, reset = false) => {
    if (!firestoreDb) {
      setError('Firestore not initialized.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const collectionName = tab === 'telegram' ? 'telegram_messages' : 'system_logs';
      const baseQuery = query(
        collection(firestoreDb, collectionName),
        orderBy('timestamp', 'desc'),
        limit(PAGE_SIZE),
      );

      const cursor = tab === 'telegram' ? telegramCursor : systemCursor;
      const nextQuery = !reset && cursor ? query(baseQuery, startAfter(cursor)) : baseQuery;
      const snapshot = await getDocs(nextQuery);
      const docs = snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) }));
      const nextCursor = snapshot.docs.length ? snapshot.docs[snapshot.docs.length - 1] : null;

      if (tab === 'telegram') {
        setTelegramLogs((prev) => (reset ? (docs as TelegramMessageRow[]) : [...prev, ...(docs as TelegramMessageRow[])]));
        setTelegramCursor(nextCursor);
      } else {
        setSystemLogs((prev) => (reset ? (docs as SystemLogRow[]) : [...prev, ...(docs as SystemLogRow[])]));
        setSystemCursor(nextCursor);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load logs.');
    } finally {
      setLoading(false);
    }
  };

  const filteredTelegramLogs = useMemo(() => {
    if (!filter.trim()) return telegramLogs;
    const needle = filter.toLowerCase();
    return telegramLogs.filter((row) =>
      [row.text, row.type, row.chat_id, row.message_id, row.parse_error]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [filter, telegramLogs]);

  const filteredSystemLogs = useMemo(() => {
    if (!filter.trim()) return systemLogs;
    const needle = filter.toLowerCase();
    return systemLogs.filter((row) =>
      [row.level, row.component, row.message]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [filter, systemLogs]);

  const logsToRender = activeTab === 'telegram' ? filteredTelegramLogs : filteredSystemLogs;

  useEffect(() => {
    if (activeTab === 'telegram' && telegramLogs.length === 0) {
      void loadLogs('telegram', true);
    }
    if (activeTab === 'system' && systemLogs.length === 0) {
      void loadLogs('system', true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  return (
    <DashboardShell
      active="logs"
      title="Logs"
      description="View Telegram messages and system logs from Firestore."
    >
      <header className="flex flex-col gap-3 rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2 text-sm">
            <button
              className={`rounded-full px-4 py-1.5 ${
                activeTab === 'telegram'
                  ? 'bg-marine-navy text-white'
                  : 'border border-marine-navy/20 text-marine-navy/70'
              }`}
              onClick={() => setActiveTab('telegram')}
            >
              Telegram
            </button>
            <button
              className={`rounded-full px-4 py-1.5 ${
                activeTab === 'system'
                  ? 'bg-marine-navy text-white'
                  : 'border border-marine-navy/20 text-marine-navy/70'
              }`}
              onClick={() => setActiveTab('system')}
            >
              System
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            className="flex-1 rounded-lg border border-marine-navy/20 bg-marine-mist px-3 py-2 text-sm text-marine-navy"
            placeholder="Filter logs"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="flex gap-2">
            <button
              className="rounded-lg border border-marine-navy/20 px-3 py-2 text-sm text-marine-navy"
              onClick={() => loadLogs(activeTab, true)}
              disabled={loading}
            >
              Refresh
            </button>
            <button
              className="rounded-lg bg-marine-navy px-3 py-2 text-sm text-white shadow disabled:opacity-60"
              onClick={() => loadLogs(activeTab)}
              disabled={loading}
            >
              Load more
            </button>
          </div>
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </header>

      <div className="overflow-hidden rounded-2xl border border-marine-navy/10 bg-white shadow-sm">
        <table className="w-full text-left text-xs text-marine-navy/80">
          <thead className="bg-marine-mist text-marine-navy/70">
            <tr>
              <th className="px-4 py-3">Timestamp</th>
              <th className="px-4 py-3">Message</th>
              <th className="px-4 py-3">Parsed signal</th>
            </tr>
          </thead>
          <tbody>
            {logsToRender.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-marine-navy/50" colSpan={3}>
                  No logs loaded. Click “Refresh” to fetch data.
                </td>
              </tr>
            ) : null}
            {activeTab === 'telegram'
              ? (logsToRender as TelegramMessageRow[]).map((row) => (
                  <tr key={row.id} className="border-t border-marine-navy/10">
                    <td className="px-4 py-3 text-marine-navy/60">
                      {row.timestamp ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-marine-navy">{row.text ?? '—'}</div>
                      <div className="mt-1 text-xs text-marine-navy/60">
                        {row.type ?? 'message'} · {row.chat_id ?? 'unknown'}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-marine-navy/70">
                      {row.parsed_ok && row.parsed ? (
                        <div className="space-y-1">
                          <div>
                            {row.parsed.symbol ?? '—'} · {row.parsed.direction ?? '—'}
                          </div>
                          <div>SL: {row.parsed.stopLoss ?? '—'}</div>
                          <div>
                            TP: {row.parsed.takeProfits?.join(', ') ?? '—'}
                          </div>
                        </div>
                      ) : (
                        row.parse_error ?? 'unparsed'
                      )}
                    </td>
                  </tr>
                ))
              : (logsToRender as SystemLogRow[]).map((row) => (
                  <tr key={row.id} className="border-t border-marine-navy/10">
                    <td className="px-4 py-3 text-marine-navy/60">
                      {row.timestamp ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      {row.message ?? '—'}
                      <div className="mt-1 text-xs text-marine-navy/60">
                        {row.level ?? 'info'} · {row.component ?? 'system'}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-marine-navy/70">
                      {row.details ? JSON.stringify(row.details) : '—'}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </DashboardShell>
  );
}
