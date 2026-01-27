'use client';

import { useEffect, useMemo, useState } from 'react';
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

const PAGE_SIZE = 50;

type TradeSet = {
  id: string;
  symbol?: string;
  direction?: string;
  state?: string;
  created_at?: string;
  updated_at?: string;
  sl?: number;
  tp1?: number;
  tp2?: number;
  tp3?: number;
  qty?: number;
};

type TradeEvent = {
  id: string;
  event_type?: string;
  timestamp?: string;
  details?: Record<string, unknown> | null;
};

export default function TradeHistoryPage() {
  const [trades, setTrades] = useState<TradeSet[]>([]);
  const [events, setEvents] = useState<TradeEvent[]>([]);
  const [selectedTrade, setSelectedTrade] = useState<TradeSet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');

  const loadTrades = async () => {
    if (!firestoreDb) {
      setError('Firestore not initialized.');
      return;
    }
    const db = firestoreDb;
    setLoading(true);
    setError(null);

    try {
      const baseQuery = query(
        collection(db, 'trade_sets'),
        orderBy('created_at', 'desc'),
        limit(PAGE_SIZE),
      );
      const snapshot = await getDocs(baseQuery);
      const rows = snapshot.docs.map((doc) => {
        const data = doc.data() as Omit<TradeSet, 'id'>;
        return { id: doc.id, ...data };
      });
      setTrades(rows);
      if (rows.length > 0) {
        setSelectedTrade(rows[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trades.');
    } finally {
      setLoading(false);
    }
  };

  const loadEvents = async (tradeSetId: string) => {
    if (!firestoreDb) return;
    const db = firestoreDb;
    try {
      const eventsQuery = query(
        collection(db, 'trade_events'),
        where('trade_set_id', '==', tradeSetId),
        orderBy('timestamp', 'desc'),
        limit(30),
      );
      const snapshot = await getDocs(eventsQuery);
      const rows = snapshot.docs.map((doc) => {
        const data = doc.data() as Omit<TradeEvent, 'id'>;
        return { id: doc.id, ...data };
      });
      setEvents(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trade events.');
    }
  };

  useEffect(() => {
    void loadTrades();
  }, []);

  useEffect(() => {
    if (selectedTrade?.id) {
      void loadEvents(selectedTrade.id);
    } else {
      setEvents([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTrade?.id]);

  const filteredTrades = useMemo(() => {
    return trades.filter((trade) => {
      const symbolMatch = symbolFilter
        ? (trade.symbol ?? '').toLowerCase().includes(symbolFilter.toLowerCase())
        : true;
      const stateMatch = stateFilter
        ? (trade.state ?? '').toLowerCase().includes(stateFilter.toLowerCase())
        : true;
      return symbolMatch && stateMatch;
    });
  }, [trades, symbolFilter, stateFilter]);

  return (
    <DashboardShell
      active="trades"
      title="Trade History"
      description="Review executed trades, state transitions, and event timelines."
    >
      <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <input
              className="rounded-lg border border-marine-navy/20 bg-white px-3 py-2 text-sm"
              placeholder="Filter by symbol"
              value={symbolFilter}
              onChange={(event) => setSymbolFilter(event.target.value)}
            />
            <input
              className="rounded-lg border border-marine-navy/20 bg-white px-3 py-2 text-sm"
              placeholder="Filter by state"
              value={stateFilter}
              onChange={(event) => setStateFilter(event.target.value)}
            />
          </div>
          <button
            className="rounded-full border border-marine-navy/20 px-4 py-2 text-sm text-marine-navy"
            onClick={loadTrades}
            disabled={loading}
          >
            Refresh list
          </button>
        </div>
        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="overflow-hidden rounded-2xl border border-marine-navy/10 bg-white shadow-sm">
          <table className="w-full text-left text-xs text-marine-navy/80">
            <thead className="bg-marine-mist text-marine-navy/70">
              <tr>
                <th className="px-4 py-3">Symbol</th>
                <th className="px-4 py-3">Direction</th>
                <th className="px-4 py-3">State</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {filteredTrades.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-center text-marine-navy/50" colSpan={4}>
                    No trades found.
                  </td>
                </tr>
              ) : null}
              {filteredTrades.map((trade) => (
                <tr
                  key={trade.id}
                  className={`border-t border-marine-navy/10 ${
                    trade.id === selectedTrade?.id ? 'bg-marine-mist' : ''
                  }`}
                >
                  <td className="px-4 py-3">
                    <button
                      className="text-left text-sm font-medium text-marine-navy"
                      onClick={() => setSelectedTrade(trade)}
                    >
                      {trade.symbol ?? '—'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-sm text-marine-navy/70">
                    {trade.direction ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-marine-navy/70">
                    {trade.state ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-marine-navy/60">
                    {trade.created_at ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-marine-navy">Event timeline</h2>
          {selectedTrade ? (
            <div className="mt-4 space-y-3 text-sm">
              <div className="rounded-lg border border-marine-navy/10 bg-marine-mist px-3 py-2">
                <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">
                  {selectedTrade.symbol} · {selectedTrade.direction}
                </p>
                <p className="mt-1 text-sm text-marine-navy/80">
                  SL {selectedTrade.sl ?? '—'} · TP {selectedTrade.tp1 ?? '—'} / {selectedTrade.tp2 ?? '—'} / {selectedTrade.tp3 ?? '—'}
                </p>
              </div>
              {events.length === 0 ? (
                <p className="text-marine-navy/60">No events recorded for this trade yet.</p>
              ) : (
                <ul className="space-y-2">
                  {events.map((event) => (
                    <li key={event.id} className="rounded-lg border border-marine-navy/10 bg-white px-3 py-2">
                      <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">
                        {event.event_type ?? 'event'}
                      </p>
                      <p className="text-sm text-marine-navy/80">
                        {event.timestamp ?? '—'}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="mt-4 text-sm text-marine-navy/60">Select a trade to view events.</p>
          )}
        </div>
      </div>
    </DashboardShell>
  );
}
