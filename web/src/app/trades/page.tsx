'use client';

import { useEffect, useMemo, useState } from 'react';
import { DashboardLayout } from '@/components/layouts/DashboardLayout';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Button } from '@/components/ui/Button';
import { MetricCard } from '@/components/ui/MetricCard';
import {
  ChevronDown,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  X,
  DollarSign,
  BarChart3,
  Target,
} from 'lucide-react';
import { collection, onSnapshot, orderBy, query, limit } from 'firebase/firestore';
import { firestoreDb } from '@/lib/firebaseClient';
import { formatTimestamp } from '@/lib/format';

type TradeFilter = 'all' | 'open' | 'closed';

interface Trade {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  state: string;
  entry?: number;
  tp1?: number;
  tp2?: number;
  tp3?: number;
  sl?: number;
  pnl?: string;
  pnlValue?: number;
  createdAt?: string;
  qty?: number;
  events?: TradeEvent[];
}

type TradeEvent = {
  id: string;
  tradeSetId: string;
  timestamp?: string;
  eventType?: string;
  details?: Record<string, unknown> | null;
};

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function TradeCard({ trade, isExpanded, onToggle }: { trade: Trade; isExpanded: boolean; onToggle: () => void }) {
  const isLong = trade.direction === 'LONG';
  const isOpen = trade.state === 'OPEN' || trade.state === 'PROTECTION_PLACED';
  const isProfitable = typeof trade.pnlValue === 'number' ? trade.pnlValue >= 0 : null;

  const getStateStatus = (state: string) => {
    switch (state) {
      case 'OPEN':
        return 'info';
      case 'PROTECTION_PLACED':
        return 'success';
      case 'CLOSED':
        return typeof trade.pnlValue === 'number' && trade.pnlValue >= 0 ? 'success' : 'danger';
      default:
        return 'neutral';
    }
  };

  const getStateLabel = (state: string) => {
    switch (state) {
      case 'PROTECTION_PLACED':
        return 'Protected';
      default:
        return state;
    }
  };

  return (
    <div
      className={`
        overflow-hidden rounded-xl border transition-all duration-200
        ${isOpen ? 'border-marine-accent/30 bg-marine-accent/5' : 'border-marine-navy/10 bg-white'}
      `}
    >
      {/* Header */}
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between p-4 text-left transition-colors hover:bg-marine-mist/50"
      >
        <div className="flex items-center gap-3">
          {/* Direction indicator */}
          <div
            className={`
              flex h-10 w-10 items-center justify-center rounded-lg
              ${isLong ? 'bg-trade-up/10' : 'bg-trade-down/10'}
            `}
          >
            {isLong ? (
              <TrendingUp className="h-5 w-5 text-trade-up" />
            ) : (
              <TrendingDown className="h-5 w-5 text-trade-down" />
            )}
          </div>

          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-marine-navy">{trade.symbol}</span>
              <span
                className={`text-xs font-medium ${isLong ? 'text-trade-up' : 'text-trade-down'}`}
              >
                {trade.direction}
              </span>
            </div>
            <p className="text-xs text-marine-navy/50">{trade.createdAt}</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <StatusBadge status={getStateStatus(trade.state)} label={getStateLabel(trade.state)} size="sm" />
          
          {/* P&L */}
          <div className="text-right">
            <p
              className={`font-semibold ${
                isProfitable === null
                  ? 'text-marine-navy/60'
                  : isProfitable
                    ? 'text-trade-up'
                    : 'text-trade-down'
              }`}
            >
              {trade.pnl ?? '—'}
            </p>
            <p className="text-[10px] text-marine-navy/50">P&L</p>
          </div>

          <ChevronDown
            className={`h-5 w-5 text-marine-navy/40 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          />
        </div>
      </button>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="border-t border-marine-navy/10 bg-marine-mist/30 p-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-marine-navy/50">Entry</p>
              <p className="font-mono text-sm text-marine-navy">
                {typeof trade.entry === 'number' ? `$${trade.entry.toLocaleString()}` : '—'}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-marine-navy/50">Stop Loss</p>
              <p className="font-mono text-sm text-trade-down">
                {typeof trade.sl === 'number' ? `$${trade.sl.toLocaleString()}` : '—'}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-marine-navy/50">Quantity</p>
              <p className="font-mono text-sm text-marine-navy">
                {typeof trade.qty === 'number' ? trade.qty : '—'}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-marine-navy/50">Risk/Reward</p>
              <p className="font-mono text-sm text-marine-navy">
                {typeof trade.tp1 === 'number' && typeof trade.entry === 'number' && typeof trade.sl === 'number'
                  ? `${((trade.tp1 - trade.entry) / Math.abs(trade.entry - trade.sl)).toFixed(2)}R`
                  : '—'}
              </p>
            </div>
          </div>

          {/* Take Profits */}
          <div className="mt-4">
            <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-marine-navy/50">
              Take Profit Levels
            </p>
            <div className="flex gap-2">
              {[trade.tp1, trade.tp2, trade.tp3].map((tp, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-lg border border-trade-up/20 bg-trade-up/5 p-2 text-center"
                >
                  <p className="text-[10px] text-marine-navy/50">TP{i + 1}</p>
                  <p className="font-mono text-xs font-medium text-trade-up">
                    {typeof tp === 'number' ? `$${tp.toLocaleString()}` : '—'}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Trade Events Timeline */}
          <div className="mt-4">
            <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-marine-navy/50">
              Trade Events
            </p>
            <div className="space-y-1">
              {trade.events?.length ? (
                trade.events.slice(0, 3).map((event) => (
                  <div
                    key={event.id}
                    className="flex items-center gap-2 text-xs text-marine-navy/60"
                  >
                    <div className="h-1.5 w-1.5 rounded-full bg-marine-accent" />
                    <span className="text-marine-navy/40">{event.timestamp ?? '—'}</span>
                    <span>{event.eventType?.replace(/_/g, ' ') ?? 'EVENT'}</span>
                  </div>
                ))
              ) : (
                <p className="text-xs text-marine-navy/40">No recent events</p>
              )}
            </div>
          </div>

          {/* Actions */}
          {isOpen && (
            <div className="mt-4 flex gap-2">
              <Button variant="danger" size="sm">
                <X className="mr-1 h-3 w-3" />
                Close Position
              </Button>
              <Button variant="secondary" size="sm">
                Move SL to BE
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function TradesPage() {
  const [filter, setFilter] = useState<TradeFilter>('all');
  const [expandedTrade, setExpandedTrade] = useState<string | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [eventsByTrade, setEventsByTrade] = useState<Record<string, TradeEvent[]>>({});

  useEffect(() => {
    if (!firestoreDb) return;

    const tradeQuery = query(
      collection(firestoreDb, 'trade_sets'),
      orderBy('created_at', 'desc'),
      limit(100),
    );

    const unsubscribeTrades = onSnapshot(tradeQuery, (snapshot) => {
      const nextTrades: Trade[] = snapshot.docs.map((docSnap) => {
        const data = docSnap.data() as Record<string, unknown>;
        const bybit = (data.bybit ?? {}) as Record<string, unknown>;
        const pnlValue = toNumber(data.pnl_value ?? data.pnlValue ?? data.realized_pnl);
        const pnl = typeof pnlValue === 'number' ? `${pnlValue >= 0 ? '+' : ''}$${pnlValue.toFixed(2)}` : undefined;

        return {
          id: docSnap.id,
          symbol: (data.symbol as string) ?? '—',
          direction: ((data.direction as string) ?? 'LONG') as 'LONG' | 'SHORT',
          state: (data.state as string) ?? 'UNKNOWN',
          entry: toNumber(bybit.avg_entry_price ?? data.entry_price ?? data.entry),
          sl: toNumber(data.sl),
          tp1: toNumber(data.tp1),
          tp2: toNumber(data.tp2),
          tp3: toNumber(data.tp3),
          qty: toNumber(bybit.qty ?? data.qty),
          pnl,
          pnlValue,
          createdAt: formatTimestamp(data.created_at as string | undefined),
        };
      });
      setTrades(nextTrades);
    });

    const eventQuery = query(
      collection(firestoreDb, 'trade_events'),
      orderBy('timestamp', 'desc'),
      limit(300),
    );

    const unsubscribeEvents = onSnapshot(eventQuery, (snapshot) => {
      const nextEventsByTrade: Record<string, TradeEvent[]> = {};
      snapshot.docs.forEach((docSnap) => {
        const data = docSnap.data() as Record<string, unknown>;
        const tradeSetId = (data.trade_set_id as string) ?? '';
        if (!tradeSetId) return;
        const event: TradeEvent = {
          id: docSnap.id,
          tradeSetId,
          timestamp: formatTimestamp(data.timestamp as string | undefined),
          eventType: (data.event_type as string) ?? 'EVENT',
          details: (data.details as Record<string, unknown>) ?? null,
        };
        if (!nextEventsByTrade[tradeSetId]) {
          nextEventsByTrade[tradeSetId] = [];
        }
        nextEventsByTrade[tradeSetId].push(event);
      });
      setEventsByTrade(nextEventsByTrade);
    });

    return () => {
      unsubscribeTrades();
      unsubscribeEvents();
    };
  }, []);

  const filteredTrades = useMemo(() => {
    if (filter === 'all') return trades;
    if (filter === 'open') {
      return trades.filter((t) => t.state === 'OPEN' || t.state === 'PROTECTION_PLACED');
    }
    return trades.filter((t) => t.state === 'CLOSED');
  }, [filter, trades]);

  // Calculate summary stats
  const stats = useMemo(() => {
    const openTrades = trades.filter((t) => t.state !== 'CLOSED');
    const closedTrades = trades.filter((t) => t.state === 'CLOSED');
    const pnlValues = trades.map((t) => t.pnlValue).filter((v): v is number => typeof v === 'number');
    const totalPnl = pnlValues.reduce((sum, v) => sum + v, 0);
    const winTrades = closedTrades.filter((t) => typeof t.pnlValue === 'number' && t.pnlValue > 0);
    const winRate = closedTrades.length > 0 ? (winTrades.length / closedTrades.length) * 100 : 0;

    return {
      openPositions: openTrades.length,
      totalPnl,
      hasPnl: pnlValues.length > 0,
      winRate: winRate.toFixed(0),
      totalTrades: trades.length,
    };
  }, [trades]);

  const filters: { key: TradeFilter; label: string }[] = [
    { key: 'all', label: 'All Trades' },
    { key: 'open', label: 'Open' },
    { key: 'closed', label: 'Closed' },
  ];

  return (
    <DashboardLayout
      title="Trades"
      subtitle="View and manage your positions"
      breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Trades' }]}
    >
      <div className="space-y-4">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard
            label="Open Positions"
            value={stats.openPositions.toString()}
            icon={<Target className="h-4 w-4" />}
          />
          <MetricCard
            label="Total P&L"
            value={stats.hasPnl ? `${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(2)}` : '—'}
            trend={stats.hasPnl ? (stats.totalPnl >= 0 ? 'up' : 'down') : 'neutral'}
            icon={<DollarSign className="h-4 w-4" />}
          />
          <MetricCard
            label="Win Rate"
            value={`${stats.winRate}%`}
            icon={<BarChart3 className="h-4 w-4" />}
          />
          <MetricCard
            label="Total Trades"
            value={stats.totalTrades.toString()}
            icon={<TrendingUp className="h-4 w-4" />}
          />
        </div>

        {/* Filters */}
        <div className="flex items-center justify-between">
          <div className="flex gap-1 rounded-lg bg-marine-mist p-1">
            {filters.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`
                  rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150
                  ${filter === f.key
                    ? 'bg-white text-marine-navy shadow-sm'
                    : 'text-marine-navy/60 hover:text-marine-navy'
                  }
                `}
              >
                {f.label}
              </button>
            ))}
          </div>

          <Button variant="secondary" size="sm">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        {/* Trade Cards */}
        <div className="space-y-3">
          {filteredTrades.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-marine-navy/20 py-12">
              <BarChart3 className="h-8 w-8 text-marine-navy/30" />
              <p className="mt-2 text-sm text-marine-navy/50">No trades found</p>
            </div>
          ) : (
            filteredTrades.map((trade) => (
              <TradeCard
                key={trade.id}
                trade={{
                  ...trade,
                  events: eventsByTrade[trade.id] ?? [],
                }}
                isExpanded={expandedTrade === trade.id}
                onToggle={() => setExpandedTrade(expandedTrade === trade.id ? null : trade.id)}
              />
            ))
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
