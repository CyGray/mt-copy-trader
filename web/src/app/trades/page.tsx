'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DashboardLayout } from '@/components/layouts/DashboardLayout';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { MetricCard } from '@/components/ui/MetricCard';
import { BarChart3, DollarSign, Target, TrendingDown, TrendingUp } from 'lucide-react';
import { collection, getDocs, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { authedFetch, errorMessage } from '@/lib/adminApi';
import { firestoreDb } from '@/lib/firebaseClient';
import { formatTimestamp } from '@/lib/format';
import { useAuth } from '@/lib/useAuth';
import {
  ACTIVE_STATES,
  filterRows,
  modeTone,
  money,
  num,
  price,
  sideLabel,
  sortByTimestamp,
  stateTone,
  toEvent,
  toRow,
  volume,
  type TradeEventRow,
  type TradeFilter,
  type TradeRow,
} from '@/lib/tradeView';

// Read-only view. Schema-2 trade sets (contracts section 5) and legacy schema-1 records share the list.

interface EventState {
  tradeId: string;
  items: TradeEventRow[];
  sortedLocally: boolean;
  error: string | null;
}

function ModeBadge({ mode }: { mode: string | null }) {
  return <StatusBadge status={modeTone(mode)} label={mode ?? 'legacy'} size="sm" />;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-marine-navy/5 py-1.5 text-sm last:border-b-0">
      <span className="text-marine-navy/60">{label}</span>
      <span className="text-right font-mono text-xs text-marine-navy sm:text-sm">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-marine-navy/10 p-3">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-marine-navy/50">{title}</p>
      {children}
    </div>
  );
}

function TradeDetail({
  row,
  events,
  eventsLoading,
}: {
  row: TradeRow;
  events: EventState | null;
  eventsLoading: boolean;
}) {
  const t = row.t2;
  const legacy = row.legacy;

  return (
    <section className="space-y-4 rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">Trade detail</p>
          <h2 className="mt-1 text-lg font-semibold text-marine-navy">
            {row.symbol} <span className="text-sm font-medium">{sideLabel(row.direction)}</span>
          </h2>
          <p className="break-all font-mono text-[11px] text-marine-navy/50">{row.id}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ModeBadge mode={row.mode} />
          <StatusBadge status={stateTone(row.state, row.realizedPnl)} label={row.state} size="sm" />
        </div>
      </div>

      {row.skipReason ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Skipped: <span className="font-mono">{row.skipReason}</span>
        </p>
      ) : null}
      {row.error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Error: <span className="break-words font-mono">{row.error}</span>
        </p>
      ) : null}

      {row.state === 'SUBMIT_UNKNOWN' ? <ResolveUnknownPanel tradeId={row.id} /> : null}

      {t ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Section title="Plan">
            <DetailRow label="Profile" value={row.profileLabel ?? '—'} />
            <DetailRow label="Snapshot name" value={t.profile_snapshot?.name ?? '—'} />
            <DetailRow label="Order type" value={t.order_type ?? '—'} />
            <DetailRow label="Planned volume" value={volume(t.plan?.volume ?? null)} />
            <DetailRow label="Entry reference" value={price(t.plan?.entry_ref_price ?? null)} />
            <DetailRow label="Order price" value={price(t.plan?.order_price ?? null)} />
            <DetailRow label="Stop loss" value={price(t.plan?.sl ?? null)} />
            <DetailRow label="Broker TP" value={price(t.plan?.broker_tp ?? null)} />
            <DetailRow
              label="Risk"
              value={t.plan ? `$${t.plan.risk_money.toFixed(2)} (${t.plan.risk_percent.toFixed(3)}%)` : '—'}
            />
            <DetailRow label="Correlation" value={t.correlation_comment ?? '—'} />
          </Section>

          <Section title="Broker references">
            <DetailRow label="Order ticket" value={t.broker_refs ? String(t.broker_refs.order_ticket) : '—'} />
            <DetailRow label="Position ticket" value={t.broker_refs ? String(t.broker_refs.position_ticket) : '—'} />
            <DetailRow label="Deal ticket" value={t.broker_refs ? String(t.broker_refs.deal_ticket) : '—'} />
            <DetailRow label="Fill price" value={price(t.broker_refs?.fill_price ?? null)} />
            <DetailRow label="Filled volume" value={volume(t.broker_refs?.filled_volume ?? null)} />
            <DetailRow label="Current volume" value={volume(t.lifecycle?.current_volume ?? null)} />
            <DetailRow label="Current SL / TP" value={`${price(t.lifecycle?.current_sl ?? null)} / ${price(t.lifecycle?.current_tp ?? null)}`} />
            <DetailRow label="Break-even applied" value={t.lifecycle ? (t.lifecycle.be_applied ? 'yes' : 'no') : '—'} />
            <DetailRow label="Trailing active" value={t.lifecycle ? (t.lifecycle.trailing_active ? 'yes' : 'no') : '—'} />
            <DetailRow label="Best price" value={price(t.lifecycle?.best_price ?? null)} />
          </Section>
        </div>
      ) : null}

      {t ? (
        <div className="rounded-lg border border-marine-navy/10 p-3">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-marine-navy/50">Checkpoints</p>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-xs">
              <thead className="text-marine-navy/50">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">TP</th>
                  <th className="py-1.5 pr-3 font-medium">Price</th>
                  <th className="py-1.5 pr-3 font-medium">Close volume</th>
                  <th className="py-1.5 pr-3 font-medium">Target remaining</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                  <th className="py-1.5 pr-3 font-medium">Deal</th>
                  <th className="py-1.5 pr-3 font-medium">Realized</th>
                </tr>
              </thead>
              <tbody>
                {(t.lifecycle?.checkpoints ?? []).map((cp) => (
                  <tr key={cp.tp_index} className="border-t border-marine-navy/10 font-mono">
                    <td className="py-1.5 pr-3">TP{cp.tp_index}</td>
                    <td className="py-1.5 pr-3">{price(cp.price)}</td>
                    <td className="py-1.5 pr-3">{volume(cp.close_volume)}</td>
                    <td className="py-1.5 pr-3">{volume(cp.target_remaining_volume)}</td>
                    <td className="py-1.5 pr-3">
                      {cp.status}
                      {cp.attempts > 0 ? <span className="ml-1 text-marine-navy/50">({cp.attempts} tries)</span> : null}
                      {cp.last_error ? <p className="font-sans text-[11px] text-red-600">{cp.last_error}</p> : null}
                    </td>
                    <td className="py-1.5 pr-3">{cp.deal_ticket ?? '—'}</td>
                    <td className="py-1.5 pr-3">{money(cp.realized_pnl ?? null)}</td>
                  </tr>
                ))}
                {(t.lifecycle?.checkpoints ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-2 font-sans text-marine-navy/50">
                      No lifecycle checkpoints yet. Planned checkpoints: {t.plan?.checkpoints.length ?? 0}.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {t ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Section title="Result">
            <DetailRow label="Closed at" value={formatTimestamp(t.result?.closed_at ?? null)} />
            <DetailRow label="Close reason" value={t.result?.close_reason ?? '—'} />
            <DetailRow label="Realized P&L" value={money(row.realizedPnl)} />
          </Section>
          <Section title="Signal">
            <DetailRow label="Symbol" value={t.signal.symbol} />
            <DetailRow label="Direction" value={t.signal.direction} />
            <DetailRow label="Order type" value={t.signal.orderType} />
            <DetailRow label="Entry range" value={`${price(t.signal.entryLow)} – ${price(t.signal.entryHigh)}`} />
            <DetailRow label="Stop loss" value={price(t.signal.stopLoss)} />
            <DetailRow label="Take profits" value={t.signal.takeProfits.map((tp) => price(tp)).join(', ') || '—'} />
          </Section>
        </div>
      ) : null}

      {t && t.signal_revisions.length > 0 ? (
        <Section title="Signal revisions">
          <div className="space-y-1.5">
            {t.signal_revisions.map((rev) => (
              <div key={rev.event_id} className="flex flex-wrap gap-x-3 text-xs text-marine-navy/70">
                <span className="text-marine-navy/50">{formatTimestamp(rev.received_at)}</span>
                <span className={rev.outcome === 'applied' ? 'text-trade-up' : 'text-marine-navy/60'}>{rev.outcome}</span>
                <span>{rev.reason}</span>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {legacy ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Section title="Legacy record (schema 1)">
            <DetailRow label="Entry" value={price(row.entryPrice)} />
            <DetailRow label="Stop loss" value={price(row.sl)} />
            <DetailRow label="TP1 / TP2 / TP3" value={`${price(num(legacy.tp1))} / ${price(num(legacy.tp2))} / ${price(num(legacy.tp3))}`} />
            <DetailRow label="Quantity" value={volume(row.volume)} />
            <DetailRow label="Created" value={formatTimestamp(row.createdAt)} />
          </Section>
          <p className="text-xs text-marine-navy/60 md:self-center">
            Legacy records are shown for history only. They are not managed by the MT5 lifecycle.
          </p>
        </div>
      ) : null}

      <Section title="Trade events">
        {eventsLoading || !events ? (
          <p className="text-xs text-marine-navy/50">Loading events…</p>
        ) : events.error ? (
          <p className="text-xs text-red-600">Could not load events: {events.error}</p>
        ) : events.items.length === 0 ? (
          <p className="text-xs text-marine-navy/50">No events recorded for this trade set.</p>
        ) : (
          <>
            {events.sortedLocally ? (
              <p className="mb-2 text-[11px] text-amber-700">
                The ordered event query needs a Firestore composite index (trade_events: trade_set_id, timestamp). Showing the
                same events sorted in the browser until it is deployed.
              </p>
            ) : null}
            <ol className="space-y-2">
              {events.items.map((event) => (
                <li key={event.id} className="border-l-2 border-marine-accent/40 pl-3 text-xs">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-marine-navy/50">{formatTimestamp(event.timestamp)}</span>
                    <span className="font-mono font-medium text-marine-navy">{event.type}</span>
                    {event.reasonCode ? <span className="font-mono text-marine-navy/60">{event.reasonCode}</span> : null}
                  </div>
                  {event.message ? <p className="text-marine-navy/70">{event.message}</p> : null}
                  <p className="font-mono text-[11px] text-marine-navy/50">
                    {[
                      event.price !== null ? `price ${price(event.price)}` : null,
                      event.volume !== null ? `vol ${volume(event.volume)}` : null,
                      event.sl !== null ? `sl ${price(event.sl)}` : null,
                      event.tp !== null ? `tp ${price(event.tp)}` : null,
                      event.dealTicket !== null ? `deal ${event.dealTicket}` : null,
                      event.realizedPnl !== null ? `pnl ${money(event.realizedPnl)}` : null,
                      event.mode ? `mode ${event.mode}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </li>
              ))}
            </ol>
          </>
        )}
      </Section>
    </section>
  );
}

/**
 * Operator resolution of an entry the reconciler cannot settle (POST /api/trades/[id]/resolve).
 * Changes only the stored state; nothing is sent to the broker.
 */
function ResolveUnknownPanel({ tradeId }: { tradeId: string }) {
  const { role } = useAuth();
  const [resolution, setResolution] = useState<'not_executed' | 'handled_manually'>('not_executed');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const required = `RESOLVE ${tradeId}`;

  if (role !== 'admin') {
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        Outcome unknown. The reconciler resolves it from broker state; if it cannot, an admin resolves it here.
      </p>
    );
  }

  async function submit() {
    setBusy(true);
    try {
      await authedFetch(`/api/trades/${encodeURIComponent(tradeId)}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolution, confirm }),
      });
      setMessage('Resolved.');
    } catch (err) {
      setMessage(errorMessage(err, 'Could not resolve'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <p>
        Outcome unknown. Check MT5 for this trade (comment in Plan → Correlation, or the tickets listed in the alert)
        before resolving. Resolving only changes the record; it never sends anything to the broker.
      </p>
      <div className="flex flex-wrap gap-3 text-xs">
        <label className="flex items-center gap-1">
          <input type="radio" checked={resolution === 'not_executed'} onChange={() => setResolution('not_executed')} />
          Did not execute
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={resolution === 'handled_manually'} onChange={() => setResolution('handled_manually')} />
          Executed; handled manually in MT5
        </label>
      </div>
      <p className="text-xs">
        Type <span className="font-mono font-semibold">{required}</span> to confirm.
      </p>
      <input
        type="text"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        className="w-full rounded border border-amber-300 bg-white px-3 py-2 font-mono text-xs"
        aria-label="Resolution confirmation"
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || confirm !== required}
        className="rounded-lg bg-marine-navy px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
      >
        Resolve
      </button>
      {message ? <p className="text-xs">{message}</p> : null}
    </div>
  );
}

export default function TradesPage() {
  const [rows, setRows] = useState<TradeRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TradeFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<EventState | null>(null);

  useEffect(() => {
    if (!firestoreDb) {
      return;
    }
    const tradeQuery = query(collection(firestoreDb, 'trade_sets'), orderBy('created_at', 'desc'), limit(200));
    return onSnapshot(
      tradeQuery,
      (snapshot) => {
        setRows(snapshot.docs.map((docSnap) => toRow(docSnap.id, docSnap.data() as Record<string, unknown>)));
        setLoaded(true);
        setError(null);
      },
      (err) => setError(err.message),
    );
  }, []);

  useEffect(() => {
    if (!selectedId || !firestoreDb) return;
    const db = firestoreDb;
    let cancelled = false;

    const loadEvents = async () => {
      const byTrade = where('trade_set_id', '==', selectedId);
      try {
        const snap = await getDocs(query(collection(db, 'trade_events'), byTrade, orderBy('timestamp', 'asc'), limit(200)));
        if (!cancelled) {
          setEvents({
            tradeId: selectedId,
            items: snap.docs.map((d) => toEvent(d.id, d.data() as Record<string, unknown>)),
            sortedLocally: false,
            error: null,
          });
        }
      } catch (err) {
        if (cancelled) return;
        const code = (err as { code?: unknown })?.code;
        const message = err instanceof Error ? err.message : 'Query failed';
        if (code !== 'failed-precondition') {
          setEvents({ tradeId: selectedId, items: [], sortedLocally: false, error: message });
          return;
        }
        // Composite index missing: query by trade id only and order in the browser.
        try {
          const snap = await getDocs(query(collection(db, 'trade_events'), byTrade, limit(200)));
          if (!cancelled) {
            setEvents({
              tradeId: selectedId,
              items: sortByTimestamp(snap.docs.map((d) => toEvent(d.id, d.data() as Record<string, unknown>))),
              sortedLocally: true,
              error: null,
            });
          }
        } catch (fallbackErr) {
          if (!cancelled) {
            setEvents({
              tradeId: selectedId,
              items: [],
              sortedLocally: false,
              error: fallbackErr instanceof Error ? fallbackErr.message : 'Query failed',
            });
          }
        }
      }
    };

    void loadEvents();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const filteredRows = useMemo(() => filterRows(rows, filter), [filter, rows]);

  const stats = useMemo(() => {
    const active = rows.filter((row) => ACTIVE_STATES.includes(row.state)).length;
    const pnlValues = rows.map((row) => row.realizedPnl).filter((v): v is number => v !== null);
    const closed = rows.filter((row) => row.state === 'CLOSED' && row.realizedPnl !== null);
    const wins = closed.filter((row) => (row.realizedPnl ?? 0) > 0).length;
    return {
      active,
      totalPnl: pnlValues.reduce((total, v) => total + v, 0),
      hasPnl: pnlValues.length > 0,
      winRate: closed.length > 0 ? Math.round((wins / closed.length) * 100) : null,
      total: rows.length,
    };
  }, [rows]);

  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const selectedEvents = events && events.tradeId === selectedId ? events : null;

  const filters: { key: TradeFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'closed', label: 'Closed' },
    { key: 'issues', label: 'Skipped / errors' },
  ];

  return (
    <DashboardLayout
      title="Trades"
      subtitle="MT5 trade sets with lifecycle and events (read-only)"
      breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Trades' }]}
    >
      <div className="space-y-4">
        {error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            Could not read trade_sets: {error}
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard label="Active" value={stats.active.toString()} icon={<Target className="h-4 w-4" />} />
          <MetricCard
            label="Realized P&L"
            value={stats.hasPnl ? money(stats.totalPnl) : '—'}
            trend={stats.hasPnl ? (stats.totalPnl >= 0 ? 'up' : 'down') : 'neutral'}
            icon={<DollarSign className="h-4 w-4" />}
          />
          <MetricCard
            label="Win rate (closed)"
            value={stats.winRate === null ? '—' : `${stats.winRate}%`}
            icon={<BarChart3 className="h-4 w-4" />}
          />
          <MetricCard label="Trade sets" value={stats.total.toString()} icon={<TrendingUp className="h-4 w-4" />} />
        </div>

        <div className="flex flex-wrap gap-1 rounded-lg bg-marine-mist p-1 sm:w-fit">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150 ${
                filter === f.key ? 'bg-white text-marine-navy shadow-sm' : 'text-marine-navy/60 hover:text-marine-navy'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="grid gap-6 xl:grid-cols-5">
          <div className="min-w-0 xl:col-span-3">
            {!loaded ? (
              <p className="rounded-xl border border-marine-navy/10 bg-white p-6 text-sm text-marine-navy/60">Loading trades…</p>
            ) : filteredRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-marine-navy/20 py-12">
                <BarChart3 className="h-8 w-8 text-marine-navy/30" />
                <p className="mt-2 text-sm text-marine-navy/50">No trades found</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-marine-navy/10 bg-white shadow-sm">
                <table className="min-w-full text-left text-xs">
                  <thead className="bg-marine-mist/60 uppercase tracking-wider text-marine-navy/60">
                    <tr>
                      <th className="px-3 py-2 font-medium">Created</th>
                      <th className="px-3 py-2 font-medium">Symbol</th>
                      <th className="px-3 py-2 font-medium">Side</th>
                      <th className="px-3 py-2 font-medium">Mode</th>
                      <th className="px-3 py-2 font-medium">State</th>
                      <th className="px-3 py-2 font-medium">Profile</th>
                      <th className="px-3 py-2 font-medium">Volume</th>
                      <th className="px-3 py-2 font-medium">Fill</th>
                      <th className="px-3 py-2 font-medium">SL</th>
                      <th className="px-3 py-2 font-medium">Realized</th>
                      <th className="px-3 py-2 font-medium">Skip / error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((row) => {
                      const isSelected = row.id === selectedId;
                      return (
                        <tr
                          key={row.id}
                          onClick={() => setSelectedId(row.id)}
                          className={`cursor-pointer border-t border-marine-navy/10 align-top transition-colors hover:bg-marine-mist/50 ${
                            isSelected ? 'bg-marine-accent/10' : ''
                          }`}
                        >
                          <td className="whitespace-nowrap px-3 py-2 text-marine-navy/70">{formatTimestamp(row.createdAt)}</td>
                          <td className="px-3 py-2 font-semibold text-marine-navy">{row.symbol}</td>
                          <td className="px-3 py-2">
                            <span className={`inline-flex items-center gap-1 font-medium ${row.direction === 'buy' ? 'text-trade-up' : row.direction === 'sell' ? 'text-trade-down' : 'text-marine-navy/50'}`}>
                              {row.direction === 'buy' ? <TrendingUp className="h-3 w-3" /> : row.direction === 'sell' ? <TrendingDown className="h-3 w-3" /> : null}
                              {sideLabel(row.direction)}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <ModeBadge mode={row.mode} />
                          </td>
                          <td className="px-3 py-2">
                            <StatusBadge status={stateTone(row.state, row.realizedPnl)} label={row.state} size="sm" />
                          </td>
                          <td className="px-3 py-2 font-mono text-[11px] text-marine-navy/70">{row.profileLabel ?? '—'}</td>
                          <td className="whitespace-nowrap px-3 py-2 font-mono">
                            {row.schema === 2 ? `${volume(row.volume)} / ${volume(row.currentVolume)}` : volume(row.volume)}
                          </td>
                          <td className="px-3 py-2 font-mono">{price(row.entryPrice)}</td>
                          <td className="px-3 py-2 font-mono">{price(row.sl)}</td>
                          <td className={`px-3 py-2 font-mono font-medium ${row.realizedPnl === null ? '' : row.realizedPnl >= 0 ? 'text-trade-up' : 'text-trade-down'}`}>
                            {money(row.realizedPnl)}
                          </td>
                          <td className="max-w-[12rem] px-3 py-2 text-[11px] text-marine-navy/60">
                            {row.skipReason ?? row.error ?? '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="min-w-0 xl:col-span-2">
            {selected ? (
              <TradeDetail row={selected} events={selectedEvents} eventsLoading={selectedEvents === null} />
            ) : (
              <div className="rounded-xl border border-dashed border-marine-navy/20 bg-white p-6 text-center text-sm text-marine-navy/50">
                Select a trade to see its plan, checkpoints and events.
              </div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
