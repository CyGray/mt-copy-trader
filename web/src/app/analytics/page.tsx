'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import DashboardShell from '@/components/DashboardShell';
import { collection, getDocs, limit, orderBy, query } from 'firebase/firestore';
import { firestoreDb } from '@/lib/firebaseClient';
import type { TradeSetDoc } from '@shared/tradeSetTypes';

// Summary of trade_sets: schema-2 MT5 lifecycle plus a count of legacy schema-1 records.

const STATE_ORDER = [
  'CLAIMED',
  'SUBMITTING',
  'SUBMIT_UNKNOWN',
  'PENDING_ORDER',
  'OPEN',
  'PARTIALLY_CLOSED',
  'CLOSED',
  'CANCELLED',
  'SKIPPED',
  'REJECTED',
  'ERROR',
];
const LEGACY_STATES = ['DETECTED', 'ENTRY_PLACED', 'PROTECTION_PLACED', 'CANCEL_REQUESTED'];
const MODES = ['live', 'demo', 'paper', 'disabled'];

type Row = Record<string, unknown> & { id: string };

function money(value: number): string {
  return `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}`;
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-marine-navy/70">{title}</h2>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export default function AnalyticsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!firestoreDb) {
      setError('Firestore not initialized.');
      return;
    }
    const db = firestoreDb;
    let cancelled = false;

    const load = async () => {
      try {
        const snapshot = await getDocs(query(collection(db, 'trade_sets'), orderBy('created_at', 'desc'), limit(1000)));
        if (cancelled) return;
        setRows(snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) })));
        setError(null);
        setLoaded(true);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load analytics.');
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const summary = useMemo(() => {
    const schema2 = rows.filter((row) => row.schema === 2) as (Row & TradeSetDoc)[];
    const legacyCount = rows.length - schema2.length;

    const stateCounts = new Map<string, number>();
    for (const row of rows) {
      const state = typeof row.state === 'string' ? row.state : 'UNKNOWN';
      stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
    }
    const knownStates = [...STATE_ORDER, ...LEGACY_STATES];
    const stateList = [
      ...knownStates.filter((state) => stateCounts.has(state)).map((state) => [state, stateCounts.get(state) ?? 0] as const),
      ...[...stateCounts.entries()].filter(([state]) => !knownStates.includes(state)),
    ];
    const maxState = Math.max(1, ...stateList.map(([, count]) => count));

    const skipReasons = new Map<string, number>();
    for (const row of schema2) {
      if (row.state === 'SKIPPED') {
        const reason = row.skip_reason ?? 'unspecified';
        skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
      }
    }
    const topSkips = [...skipReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

    const byMode = new Map<string, { closed: number; wins: number; pnl: number }>();
    for (const row of schema2) {
      if (row.state !== 'CLOSED' || !row.result) continue;
      const mode = row.mode ?? 'unknown';
      const entry = byMode.get(mode) ?? { closed: 0, wins: 0, pnl: 0 };
      entry.closed += 1;
      entry.pnl += row.result.realized_pnl;
      if (row.result.realized_pnl > 0) entry.wins += 1;
      byMode.set(mode, entry);
    }
    const modeTotal = [...byMode.values()].reduce(
      (total, entry) => ({ closed: total.closed + entry.closed, pnl: total.pnl + entry.pnl }),
      { closed: 0, pnl: 0 },
    );

    const checkpointDone = new Map<number, number>();
    const checkpointTotal = new Map<number, number>();
    for (const row of schema2) {
      for (const cp of row.lifecycle?.checkpoints ?? []) {
        checkpointTotal.set(cp.tp_index, (checkpointTotal.get(cp.tp_index) ?? 0) + 1);
        if (cp.status === 'done') checkpointDone.set(cp.tp_index, (checkpointDone.get(cp.tp_index) ?? 0) + 1);
      }
    }
    const tpIndexes = [...new Set([1, 2, 3, ...checkpointTotal.keys()])].sort((a, b) => a - b);

    const modeRows = [...byMode.entries()].sort(
      ([a], [b]) => (MODES.indexOf(a) === -1 ? MODES.length : MODES.indexOf(a)) - (MODES.indexOf(b) === -1 ? MODES.length : MODES.indexOf(b)),
    );

    return {
      schema2Count: schema2.length,
      legacyCount,
      stateList,
      maxState,
      topSkips,
      modeRows,
      modeTotal,
      tpIndexes,
      checkpointDone,
      checkpointTotal,
    };
  }, [rows]);

  return (
    <DashboardShell
      active="analytics"
      title="Analytics"
      description="Trade lifecycle counts, realized P&L by mode, and checkpoint hits from trade_sets."
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-marine-navy/10 bg-white p-4 shadow-sm">
        <p className="text-sm text-marine-navy/70">
          {loaded
            ? `${summary.schema2Count} MT5 trade sets (schema 2), ${summary.legacyCount} legacy records. Up to the 1,000 most recent are included.`
            : 'Loading…'}
        </p>
        <button
          type="button"
          className="rounded-full border border-marine-navy/20 px-4 py-2 text-sm text-marine-navy hover:bg-marine-mist"
          onClick={() => setRefreshKey((key) => key + 1)}
        >
          Refresh
        </button>
      </div>

      {error ? <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p> : null}

      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Trades by state">
          {summary.stateList.length === 0 ? (
            <p className="text-sm text-marine-navy/60">No trade sets yet.</p>
          ) : (
            <ul className="space-y-2">
              {summary.stateList.map(([state, count]) => (
                <li key={state} className="text-sm">
                  <div className="flex justify-between text-marine-navy">
                    <span className="font-mono text-xs">{state}</span>
                    <span className="font-semibold">{count}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-marine-mist">
                    <div className="h-1.5 rounded-full bg-marine-accent" style={{ width: `${(count / summary.maxState) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Top skip reasons">
          {summary.topSkips.length === 0 ? (
            <p className="text-sm text-marine-navy/60">No skipped trades.</p>
          ) : (
            <ul className="divide-y divide-marine-navy/10 text-sm">
              {summary.topSkips.map(([reason, count]) => (
                <li key={reason} className="flex justify-between gap-3 py-2">
                  <span className="font-mono text-xs text-marine-navy/80">{reason}</span>
                  <span className="font-semibold text-marine-navy">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Realized P&L (closed, by mode)">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-marine-navy/50">
              <tr>
                <th className="py-1.5 font-medium">Mode</th>
                <th className="py-1.5 font-medium">Closed</th>
                <th className="py-1.5 font-medium">Win rate</th>
                <th className="py-1.5 text-right font-medium">Realized</th>
              </tr>
            </thead>
            <tbody>
              {summary.modeRows.map(([mode, entry]) => (
                <tr key={mode} className="border-t border-marine-navy/10">
                  <td className="py-2 font-mono text-xs">{mode}</td>
                  <td className="py-2">{entry.closed}</td>
                  <td className="py-2">{entry.closed ? `${Math.round((entry.wins / entry.closed) * 100)}%` : '—'}</td>
                  <td className={`py-2 text-right font-mono ${entry.pnl >= 0 ? 'text-trade-up' : 'text-trade-down'}`}>
                    {money(entry.pnl)}
                  </td>
                </tr>
              ))}
              {summary.modeRows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-2 text-marine-navy/60">
                    No closed MT5 trades yet.
                  </td>
                </tr>
              ) : (
                <tr className="border-t-2 border-marine-navy/20 font-semibold">
                  <td className="py-2">Total</td>
                  <td className="py-2">{summary.modeTotal.closed}</td>
                  <td className="py-2" />
                  <td className={`py-2 text-right font-mono ${summary.modeTotal.pnl >= 0 ? 'text-trade-up' : 'text-trade-down'}`}>
                    {money(summary.modeTotal.pnl)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-marine-navy/50">
            Legacy schema-1 records are not included: their P&L fields predate the MT5 lifecycle.
          </p>
        </Card>

        <Card title="Checkpoint hits">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-marine-navy/50">
              <tr>
                <th className="py-1.5 font-medium">Checkpoint</th>
                <th className="py-1.5 font-medium">Done</th>
                <th className="py-1.5 text-right font-medium">Of tracked</th>
              </tr>
            </thead>
            <tbody>
              {summary.tpIndexes.map((index) => (
                <tr key={index} className="border-t border-marine-navy/10">
                  <td className="py-2 font-mono text-xs">TP{index}</td>
                  <td className="py-2 font-semibold text-marine-navy">{summary.checkpointDone.get(index) ?? 0}</td>
                  <td className="py-2 text-right text-marine-navy/70">{summary.checkpointTotal.get(index) ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-marine-navy/50">
            Done counts checkpoints whose partial close is confirmed. Tracked counts checkpoints in trades that have a lifecycle.
          </p>
        </Card>
      </div>
    </DashboardShell>
  );
}
