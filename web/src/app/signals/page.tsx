'use client';

import { useCallback, useEffect, useState } from 'react';
import { DashboardLayout } from '@/components/layouts/DashboardLayout';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { authedFetch, errorMessage } from '@/lib/adminApi';
import { queueStatusTone } from '@/lib/alertView';
import { formatTimestamp } from '@/lib/format';
import { useAuth } from '@/lib/useAuth';

// The AutoTrader's durable signal queue (worker/src/lib/signalQueue.ts).
// Dead letters can be requeued (they run through every engine gate again,
// including the signal age limit) or discarded. Both need typed confirmation.

type View = 'dead_letter' | 'active' | 'discarded';
const REFRESH_MS = 15_000;
const CONFIRM: Record<'requeue' | 'discard', string> = { requeue: 'REQUEUE', discard: 'DISCARD' };

interface QueueState {
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  lease_owner: string | null;
  last_error?: string;
  reason?: string;
  dead_lettered_at?: string;
  history?: { attempt: number; at: string; result: string; detail?: string }[];
}

interface EventRow {
  id: string;
  chat_id: string | null;
  message_id: string | null;
  kind: string | null;
  message_type: string | null;
  cancel_reason: string | null;
  signal: { symbol?: string; direction?: string; stopLoss?: number; takeProfits?: number[] } | null;
  created_at: string | null;
  queue: QueueState | null;
}

export default function SignalsPage() {
  const { user, role } = useAuth();
  const [view, setView] = useState<View>('dead_letter');
  const [rows, setRows] = useState<EventRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; action: 'requeue' | 'discard' } | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await authedFetch<{ events: EventRow[] }>(`/api/signal-events?view=${view}`);
      setRows(data.events);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Could not load the signal queue'));
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

  async function submit() {
    if (!pending) return;
    setBusy(true);
    try {
      await authedFetch(`/api/signal-events/${encodeURIComponent(pending.id)}`, {
        method: 'POST',
        body: JSON.stringify({ action: pending.action, confirm: confirmText }),
      });
      setNotice(pending.action === 'requeue' ? 'Requeued. The AutoTrader picks it up on its next pass.' : 'Discarded.');
      setPending(null);
      setConfirmText('');
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Action failed'));
    } finally {
      setBusy(false);
    }
  }

  const isAdmin = role === 'admin';
  const tabs: { key: View; label: string }[] = [
    { key: 'dead_letter', label: 'Dead letters' },
    { key: 'active', label: 'In queue' },
    { key: 'discarded', label: 'Discarded' },
  ];

  return (
    <DashboardLayout title="Signal queue" subtitle="Durable hand-off from the forwarder to the AutoTrader">
      <div className="space-y-4">
        <div className="inline-flex rounded-lg bg-marine-navy/5 p-1 text-sm">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setView(t.key)}
              className={`rounded-md px-3 py-1.5 ${view === t.key ? 'bg-white text-marine-navy shadow-sm' : 'text-marine-navy/60'}`}
              aria-pressed={view === t.key}
            >
              {t.label}
            </button>
          ))}
        </div>

        {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{notice}</p> : null}
        {error ? <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p> : null}

        {loaded && rows.length === 0 && !error ? (
          <p className="rounded-2xl border border-marine-navy/10 bg-white p-5 text-sm text-marine-navy/70 shadow-sm">Nothing here.</p>
        ) : null}

        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.id} className="rounded-2xl border border-marine-navy/10 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={queueStatusTone(row.queue?.status)} label={row.queue?.status ?? 'unknown'} />
                    <span className="text-sm font-semibold text-marine-navy">
                      {row.kind === 'cancel' ? `Cancel (${row.cancel_reason ?? 'unlabelled'})` : `${row.signal?.direction?.toUpperCase() ?? ''} ${row.signal?.symbol ?? ''}`}
                    </span>
                    <span className="text-xs text-marine-navy/50">{row.message_type === 'edit' ? 'edit' : 'new'}</span>
                  </div>
                  <p className="mt-1 break-all font-mono text-[11px] text-marine-navy/50">{row.id}</p>
                  <p className="mt-1 text-xs text-marine-navy/60">
                    Created {formatTimestamp(row.created_at)} · attempts {row.queue?.attempts ?? 0}
                    {row.queue?.next_attempt_at && row.queue.status === 'retry_wait' ? ` · next ${formatTimestamp(row.queue.next_attempt_at)}` : ''}
                    {row.queue?.lease_owner ? ` · held by ${row.queue.lease_owner}` : ''}
                  </p>
                </div>
                {isAdmin && row.queue?.status === 'dead_letter' ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setPending({ id: row.id, action: 'requeue' });
                        setConfirmText('');
                      }}
                      className="rounded-lg border border-marine-navy/10 bg-marine-mist px-3 py-1.5 text-xs font-medium text-marine-navy"
                    >
                      Requeue
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPending({ id: row.id, action: 'discard' });
                        setConfirmText('');
                      }}
                      className="rounded-lg border border-marine-navy/10 bg-white px-3 py-1.5 text-xs font-medium text-marine-navy"
                    >
                      Discard
                    </button>
                  </div>
                ) : null}
              </div>
              {row.queue?.last_error ? (
                <p className="mt-2 break-words rounded-lg border border-red-200 bg-red-50 p-2 font-mono text-xs text-red-700">{row.queue.last_error}</p>
              ) : null}
              {row.queue?.history && row.queue.history.length > 0 ? (
                <details className="mt-2 text-xs text-marine-navy/70">
                  <summary className="cursor-pointer">Attempt history</summary>
                  <ul className="mt-1 space-y-0.5 font-mono">
                    {row.queue.history.map((h) => (
                      <li key={`${h.attempt}-${h.at}-${h.result}`} className="break-words">
                        #{h.attempt} {formatTimestamp(h.at)} {h.result}
                        {h.detail ? `: ${h.detail}` : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {pending?.id === row.id ? (
                <div className="mt-3 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                  <p className="text-amber-800">
                    {pending.action === 'requeue'
                      ? 'The event runs through every gate again. A signal older than the profile age limit is skipped, not executed. Refused if a later event of the same trade set was already handled.'
                      : 'The event is marked discarded and never executed.'}{' '}
                    Type <span className="font-mono font-semibold">{CONFIRM[pending.action]}</span> to confirm.
                  </p>
                  <input
                    type="text"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    className="w-full rounded border border-amber-300 bg-white px-3 py-2 font-mono text-sm"
                    aria-label="Confirmation text"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void submit()}
                      disabled={busy || confirmText !== CONFIRM[pending.action]}
                      className="rounded-lg bg-marine-navy px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Confirm {pending.action}
                    </button>
                    <button type="button" onClick={() => setPending(null)} className="rounded-lg px-3 py-1.5 text-xs text-marine-navy">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </DashboardLayout>
  );
}
