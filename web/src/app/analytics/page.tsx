'use client';

import { useEffect, useMemo, useState } from 'react';
import DashboardShell from '@/components/DashboardShell';
import { collection, getDocs, query } from 'firebase/firestore';
import { firestoreDb } from '@/lib/firebaseClient';

type TradeSet = {
  id: string;
  state?: string;
  outcome?: string;
  created_at?: string;
  updated_at?: string;
};

export default function AnalyticsPage() {
  const [trades, setTrades] = useState<TradeSet[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadAnalytics = async () => {
    if (!firestoreDb) {
      setError('Firestore not initialized.');
      return;
    }
    const db = firestoreDb;

    try {
      const snapshot = await getDocs(query(collection(db, 'trade_sets')));
      const rows = snapshot.docs.map((doc) => {
        const data = doc.data() as Omit<TradeSet, 'id'>;
        return { id: doc.id, ...data };
      });
      setTrades(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics.');
    }
  };

  useEffect(() => {
    void loadAnalytics();
  }, []);

  const metrics = useMemo(() => {
    const total = trades.length;
    const open = trades.filter((trade) => ['OPEN', 'PROTECTION_PLACED', 'ENTRY_PLACED'].includes(trade.state ?? '')).length;
    const closed = trades.filter((trade) => trade.state === 'CLOSED').length;
    const wins = trades.filter((trade) => trade.outcome === 'FULL_TP' || trade.outcome === 'PARTIAL_TP').length;
    const winRate = total ? Math.round((wins / total) * 100) : 0;

    return { total, open, closed, wins, winRate };
  }, [trades]);

  return (
    <DashboardShell
      active="analytics"
      title="Analytics"
      description="Track performance summaries and signal execution quality."
    >
      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-2xl border border-marine-navy/10 bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">Total trades</p>
          <p className="mt-3 text-2xl font-semibold text-marine-navy">{metrics.total}</p>
        </div>
        <div className="rounded-2xl border border-marine-navy/10 bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">Open trades</p>
          <p className="mt-3 text-2xl font-semibold text-marine-navy">{metrics.open}</p>
        </div>
        <div className="rounded-2xl border border-marine-navy/10 bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">Closed trades</p>
          <p className="mt-3 text-2xl font-semibold text-marine-navy">{metrics.closed}</p>
        </div>
        <div className="rounded-2xl border border-marine-navy/10 bg-white p-4 shadow-sm">
          <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">Win rate</p>
          <p className="mt-3 text-2xl font-semibold text-marine-navy">{metrics.winRate}%</p>
        </div>
      </div>

      <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-marine-navy">Performance notes</h2>
          <button
            className="rounded-full border border-marine-navy/20 px-4 py-2 text-sm text-marine-navy"
            onClick={loadAnalytics}
          >
            Refresh
          </button>
        </div>
        <p className="mt-3 text-sm text-marine-navy/70">
          Analytics currently summarize trade state and outcomes recorded in Firestore. Add PnL and latency metrics once trade events are fully populated.
        </p>
        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      </div>
    </DashboardShell>
  );
}
