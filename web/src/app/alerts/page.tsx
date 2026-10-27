'use client';

import { useCallback, useEffect, useState } from 'react';
import { DashboardLayout } from '@/components/layouts/DashboardLayout';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { authedFetch, errorMessage } from '@/lib/adminApi';
import { alertStatusTone, severityTone, toAlertRow, type AlertRow } from '@/lib/alertView';
import { formatTimestamp } from '@/lib/format';
import { useAuth } from '@/lib/useAuth';

// Operator alerts raised by the forwarder and the AutoTrader (worker/src/lib/alerts.ts).
// Mutations go through /api/alerts/[id] (admin only); the list refreshes every 15 s.

type View = 'active' | 'resolved';
const REFRESH_MS = 15_000;

export default function AlertsPage() {
  const { user, role } = useAuth();
  const [view, setView] = useState<View>('active');
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await authedFetch<{ alerts: Record<string, unknown>[] }>(`/api/alerts?view=${view}`);
      setRows(data.alerts.map(toAlertRow));
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Could not load alerts'));
    } finally {
      setLoaded(true);
    }
  }, [view]);

  useEffect(() => {
    if (!user) return;
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [user, load]);

  async function act(id: string, action: 'acknowledge' | 'resolve') {
    setBusy(`${id}:${action}`);
    try {
      await authedFetch(`/api/alerts/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ action }) });
      await load();
    } catch (err) {
      setError(errorMessage(err, `Could not ${action} the alert`));
    } finally {
      setBusy(null);
    }
  }

  const isAdmin = role === 'admin';

  return (
    <DashboardLayout title="Alerts" subtitle="Problems the services detected, with what to do about them">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex rounded-lg bg-marine-navy/5 p-1 text-sm">
            {(['active', 'resolved'] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`rounded-md px-3 py-1.5 capitalize ${view === v ? 'bg-white text-marine-navy shadow-sm' : 'text-marine-navy/60'}`}
                aria-pressed={view === v}
              >
                {v}
              </button>
            ))}
          </div>
          {!isAdmin ? <p className="text-xs text-marine-navy/60">Read-only: acknowledging and resolving need the admin role.</p> : null}
        </div>

        {error ? <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p> : null}

        {loaded && rows.length === 0 && !error ? (
          <p className="rounded-2xl border border-marine-navy/10 bg-white p-5 text-sm text-marine-navy/70 shadow-sm">
            {view === 'active' ? 'No open alerts.' : 'No resolved alerts.'}
          </p>
        ) : null}

        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.id} className="rounded-2xl border border-marine-navy/10 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={severityTone(row.severity)} label={row.severity} />
                    <StatusBadge status={alertStatusTone(row.status)} label={row.status} />
                    <span className="font-mono text-[11px] text-marine-navy/50">{row.type}</span>
                  </div>
                  <h2 className="mt-2 break-words text-base font-semibold text-marine-navy">{row.title}</h2>
                  {row.subject ? <p className="break-all font-mono text-[11px] text-marine-navy/50">{row.subject}</p> : null}
                </div>
                {isAdmin && row.status !== 'resolved' ? (
                  <div className="flex gap-2">
                    {row.status === 'open' ? (
                      <button
                        type="button"
                        onClick={() => void act(row.id, 'acknowledge')}
                        disabled={busy !== null}
                        className="rounded-lg border border-marine-navy/10 bg-marine-mist px-3 py-1.5 text-xs font-medium text-marine-navy disabled:opacity-50"
                      >
                        Acknowledge
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void act(row.id, 'resolve')}
                      disabled={busy !== null}
                      className="rounded-lg border border-marine-navy/10 bg-white px-3 py-1.5 text-xs font-medium text-marine-navy disabled:opacity-50"
                    >
                      Resolve
                    </button>
                  </div>
                ) : null}
              </div>
              <p className="mt-2 break-words text-sm text-marine-navy/80">{row.message}</p>
              {row.action ? (
                <p className="mt-2 rounded-lg border border-marine-navy/10 bg-marine-mist p-3 text-sm text-marine-navy">
                  <span className="font-semibold">What to do: </span>
                  {row.action}
                </p>
              ) : null}
              <p className="mt-2 text-xs text-marine-navy/50">
                Seen {row.count}× · first {formatTimestamp(row.first_seen_at)} · last {formatTimestamp(row.last_seen_at)} · from {row.source || '—'}
                {row.acknowledged_by ? ` · acknowledged by ${row.acknowledged_by}` : ''}
                {row.resolved_by ? ` · resolved by ${row.resolved_by}${row.resolution ? ` (${row.resolution})` : ''}` : ''}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </DashboardLayout>
  );
}
