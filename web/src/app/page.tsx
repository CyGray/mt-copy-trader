'use client';

import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import { DashboardLayout } from '@/components/layouts/DashboardLayout';
import { MetricCard } from '@/components/ui/MetricCard';
import { ActivityFeed, type ActivityItem } from '@/components/ui/ActivityFeed';
import { StatusBar } from '@/components/dashboard/StatusBar';
import { QuickActionsPanel } from '@/components/dashboard/QuickActionsPanel';
import { Button } from '@/components/ui/Button';
import {
  TrendingUp,
  Layers,
  DollarSign,
  Zap,
  ArrowRight,
  BarChart3,
  MessageCircle,
} from 'lucide-react';
import Link from 'next/link';
import { collection, doc, onSnapshot, orderBy, query, limit, setDoc } from 'firebase/firestore';
import { firestoreDb } from '@/lib/firebaseClient';
import { formatTimestamp } from '@/lib/format';

type Trade = {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  state: string;
  createdAt?: string;
  pnlValue?: number;
  pnl?: string;
};

type SystemLogItem = {
  id: string;
  timestamp: string;
  message: string;
  level: 'info' | 'warn' | 'error' | string;
};

type TelegramMessage = {
  id: string;
  timestamp: string;
  rawTimestamp?: string;
  text: string;
  chatId?: string;
  parsedOk: boolean;
  parsedSymbol?: string;
};

type Settings = {
  trading: {
    paperMode: boolean;
    killSwitch: boolean;
  };
};

export default function DashboardPage() {
  const [killSwitch, setKillSwitch] = useState(false);
  const [paperMode, setPaperMode] = useState(false);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [systemLogs, setSystemLogs] = useState<SystemLogItem[]>([]);
  const [recentMessages, setRecentMessages] = useState<TelegramMessage[]>([]);
  const [lastSignal, setLastSignal] = useState<string | null>(null);
  const [workerStatus, setWorkerStatus] = useState<'online' | 'offline'>('offline');
  const [telegramStatus, setTelegramStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const [chatLabels, setChatLabels] = useState<Record<string, string>>({});
  const [messagesCursor, setMessagesCursor] = useState<any>(null);
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const loadingMoreRef = useRef(false);

  // Lazy load more messages
  const loadMoreMessages = useCallback(() => {
    if (!firestoreDb || !messagesCursor || loadingMoreRef.current || !hasMoreMessages) return;
    loadingMoreRef.current = true;
    import('firebase/firestore').then(({ collection, query, orderBy, startAfter, limit, getDocs }) => {
      if (!firestoreDb) {
        loadingMoreRef.current = false;
        return;
      }
      const moreQuery = query(
        collection(firestoreDb, 'telegram_messages'),
        orderBy('timestamp', 'desc'),
        startAfter(messagesCursor),
        limit(12),
      );
      getDocs(moreQuery).then((snapshot) => {
        const docs = snapshot.docs;
        const nextMessages: TelegramMessage[] = docs.map((docSnap) => {
          const data = docSnap.data() as Record<string, unknown>;
          return {
            id: docSnap.id,
            timestamp: formatTimestamp(data.timestamp as string | undefined),
            rawTimestamp: data.timestamp ? String(data.timestamp) : undefined,
            text: String(data.text ?? ''),
            chatId: data.chat_id ? String(data.chat_id) : undefined,
            parsedOk: Boolean(data.parsed_ok),
            parsedSymbol: (data.parsed as { symbol?: string } | null)?.symbol,
          };
        });
        setRecentMessages((prev) => [...prev, ...nextMessages]);
        setMessagesCursor(docs.length > 0 ? docs[docs.length - 1] : messagesCursor);
        setHasMoreMessages(docs.length === 12);
        loadingMoreRef.current = false;
      });
    });
  }, [firestoreDb, messagesCursor, hasMoreMessages]);

  const loaderRef = useInfiniteScroll(loadMoreMessages, hasMoreMessages, [messagesCursor]);

  useEffect(() => {
    if (!firestoreDb) return;

    const tradesQuery = query(
      collection(firestoreDb, 'trade_sets'),
      orderBy('created_at', 'desc'),
      limit(50),
    );

    const logsQuery = query(
      collection(firestoreDb, 'system_logs'),
      orderBy('timestamp', 'desc'),
      limit(10),
    );

    // Initial messages fetch
    const messagesQuery = query(
      collection(firestoreDb, 'telegram_messages'),
      orderBy('timestamp', 'desc'),
      limit(12),
    );

    const settingsRef = doc(firestoreDb, 'settings', 'default');

    const unsubscribeTrades = onSnapshot(tradesQuery, (snapshot) => {
      const nextTrades: Trade[] = snapshot.docs.map((docSnap) => {
        const data = docSnap.data() as Record<string, unknown>;
        const pnlValue = typeof data.pnl_value === 'number'
          ? data.pnl_value
          : typeof data.pnlValue === 'number'
            ? data.pnlValue
            : undefined;
        const pnl = typeof pnlValue === 'number'
          ? `${pnlValue >= 0 ? '+' : ''}$${pnlValue.toFixed(2)}`
          : undefined;
        return {
          id: docSnap.id,
          symbol: String(data.symbol ?? '—'),
          direction: ((data.direction as string) ?? 'LONG') as 'LONG' | 'SHORT',
          state: String(data.state ?? 'UNKNOWN'),
          createdAt: formatTimestamp(data.created_at as string | undefined),
          pnlValue,
          pnl,
        };
      });
      setTrades(nextTrades);
    });

    const unsubscribeLogs = onSnapshot(logsQuery, (snapshot) => {
      const nextLogs: SystemLogItem[] = snapshot.docs.map((docSnap) => {
        const data = docSnap.data() as Record<string, unknown>;
        return {
          id: docSnap.id,
          timestamp: formatTimestamp(data.timestamp as string | undefined),
          message: String(data.message ?? ''),
          level: String(data.level ?? 'info'),
        };
      });
      setSystemLogs(nextLogs);
    });

    let unsubMessages: (() => void) | null = null;
    const fetchInitialMessages = () => {
      if (unsubMessages) unsubMessages();
      unsubMessages = onSnapshot(messagesQuery, (snapshot) => {
        const docs = snapshot.docs;
        const nextMessages: TelegramMessage[] = docs.map((docSnap) => {
          const data = docSnap.data() as Record<string, unknown>;
          return {
            id: docSnap.id,
            timestamp: formatTimestamp(data.timestamp as string | undefined),
            rawTimestamp: data.timestamp ? String(data.timestamp) : undefined,
            text: String(data.text ?? ''),
            chatId: data.chat_id ? String(data.chat_id) : undefined,
            parsedOk: Boolean(data.parsed_ok),
            parsedSymbol: (data.parsed as { symbol?: string } | null)?.symbol,
          };
        });
        setRecentMessages(nextMessages);
        setMessagesCursor(docs.length > 0 ? docs[docs.length - 1] : null);
        setHasMoreMessages(docs.length === 12);

        const lastParsed = nextMessages.find((m) => m.parsedOk);
        if (lastParsed?.parsedSymbol) {
          setLastSignal(lastParsed.parsedSymbol);
        } else if (lastParsed?.text) {
          const words = lastParsed.text.split(/\s+/).slice(0, 3).join(' ');
          setLastSignal(words);
        }
      });
    };
    fetchInitialMessages();

    const unsubscribeSettings = onSnapshot(settingsRef, (snap) => {
      const data = snap.data() as {
        trading?: { paper_mode?: boolean; kill_switch?: boolean };
        telegram?: { chat_id_labels?: Record<string, string> };
      } | undefined;
      setPaperMode(Boolean(data?.trading?.paper_mode));
      setKillSwitch(Boolean(data?.trading?.kill_switch));
      setChatLabels(data?.telegram?.chat_id_labels ?? {});
    });

    return () => {
      unsubscribeTrades();
      unsubscribeLogs();
      if (unsubMessages) unsubMessages();
      unsubscribeSettings();
    };
  }, [firestoreDb]);

  useEffect(() => {
    let active = true;
    const fetchWorkerHealth = async () => {
      try {
        const response = await fetch('/api/worker/health', { cache: 'no-store' });
        if (!response.ok) return;
        const payload = (await response.json()) as { data?: { status?: string; telegram?: string } };
        if (!active) return;
        setWorkerStatus(payload.data?.status === 'ok' ? 'online' : 'offline');
        setTelegramStatus(payload.data?.telegram === 'authorized' ? 'connected' : 'disconnected');
      } catch {
        if (active) setWorkerStatus('offline');
      }
    };

    void fetchWorkerHealth();
    const interval = setInterval(fetchWorkerHealth, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const openTrades = useMemo(
    () => trades.filter((t) => t.state === 'OPEN' || t.state === 'PROTECTION_PLACED'),
    [trades],
  );

  const totalPnl = useMemo(() => {
    const pnlValues = trades.map((t) => t.pnlValue).filter((v): v is number => typeof v === 'number');
    return pnlValues.reduce((sum, v) => sum + v, 0);
  }, [trades]);

  const signalsToday = useMemo(() => {
    const today = new Date().toDateString();
    return recentMessages.filter((msg) => {
      if (!msg.rawTimestamp) return false;
      const date = new Date(msg.rawTimestamp);
      return !Number.isNaN(date.getTime()) && date.toDateString() === today;
    }).length;
  }, [recentMessages]);

  const activityItems: ActivityItem[] = useMemo(() => {
    return systemLogs.map((log) => ({
      id: log.id,
      timestamp: log.timestamp,
      message: log.message,
      type: log.level === 'error' ? 'error' : log.level === 'warn' ? 'warning' : 'info',
    }));
  }, [systemLogs]);

  const updateTradingFlag = async (field: 'kill_switch' | 'paper_mode', value: boolean) => {
    if (!firestoreDb) return;
    await setDoc(
      doc(firestoreDb, 'settings', 'default'),
      { trading: { [field]: value } },
      { merge: true },
    );
  };

  return (
    <DashboardLayout
      title="Overview"
      subtitle="Real-time trading dashboard"
      breadcrumbs={[{ label: 'Dashboard' }]}
    >
      <div className="space-y-2 sm:space-y-4 px-1 sm:px-0">
        {workerStatus === 'offline' && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-700">
            Worker is offline. Start the worker service (port 4000) or set WORKER_URL / WORKER_HEALTH_URL.
          </div>
        )}
        {/* Status Bar */}
        <StatusBar
          systemHealth={
            workerStatus === 'offline'
              ? 'offline'
              : telegramStatus === 'disconnected'
                ? 'degraded'
                : 'healthy'
          }
          activePositions={openTrades.length}
          lastSignal={lastSignal ?? undefined}
          telegramStatus={telegramStatus}
          workerStatus={workerStatus}
          compact
        />
        {/* Metrics Row */}
        <div className="grid gap-2 sm:gap-3 grid-cols-2 sm:grid-cols-4">
          <MetricCard
            label="Open Positions"
            value={openTrades.length}
            icon={<Layers className="h-4 w-4" />}
          />
          <MetricCard
            label="Signals Today"
            value={signalsToday}
            icon={<Zap className="h-4 w-4" />}
          />
          <MetricCard
            label="Total Trades"
            value={trades.length}
            icon={<TrendingUp className="h-4 w-4" />}
          />
          <MetricCard
            label="Total P&L"
            value={Number.isFinite(totalPnl) && trades.some((t) => typeof t.pnlValue === 'number')
              ? `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`
              : '—'}
            trend={trades.some((t) => typeof t.pnlValue === 'number') ? (totalPnl >= 0 ? 'up' : 'down') : 'neutral'}
            icon={<DollarSign className="h-4 w-4" />}
          />
        </div>
        {/* Two Column Layout */}
        <div className="grid gap-2 sm:gap-4 grid-cols-1 lg:grid-cols-[220px_1fr]">
          {/* Left Column - Quick Actions (hidden on mobile) */}
          <div className="hidden sm:block space-y-2 sm:space-y-4">
            <QuickActionsPanel
              killSwitchActive={killSwitch}
              paperModeActive={paperMode}
              onKillSwitch={() => {
                const next = !killSwitch;
                setKillSwitch(next);
                void updateTradingFlag('kill_switch', next);
              }}
              onPaperMode={() => {
                const next = !paperMode;
                setPaperMode(next);
                void updateTradingFlag('paper_mode', next);
              }}
              onRefresh={() => window.location.reload()}
            />
          </div>
          {/* Right Column - Activity Feed */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-marine-navy">Recent Activity</h2>
              <Link href="/logs">
                <Button variant="ghost" size="sm">
                  View All
                  <ArrowRight className="h-3 w-3" />
                </Button>
              </Link>
            </div>
            <ActivityFeed items={activityItems} maxItems={8} />
          </div>
        </div>
        {/* Recent Messages - Fixed height, scrollable, infinite scroll for both mobile and desktop */}
        <div className="rounded-lg border border-marine-navy/10 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-marine-navy/10 px-2 py-2">
            <div className="flex items-center gap-1">
              <MessageCircle className="h-3 w-3 text-marine-navy/40" />
              <h2 className="text-xs font-semibold text-marine-navy">Recent Messages</h2>
            </div>
            <Link href="/logs">
              <Button variant="ghost" size="sm">
                Logs
                <ArrowRight className="h-3 w-3" />
              </Button>
            </Link>
          </div>
          {/* Unified scrollable container for all breakpoints */}
          <div
            className="overflow-y-auto px-2 py-2 flex flex-col gap-2"
            style={{ maxHeight: 320, minHeight: 160 }}
          >
            {recentMessages.length === 0 ? (
              <div className="text-[11px] text-marine-navy/50 py-6 text-center">No messages yet</div>
            ) : (
              <>
                {recentMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className="w-full max-w-full mx-auto rounded-xl border border-marine-accent/20 bg-marine-accent/10 px-3 py-2 flex flex-col"
                    style={{ minWidth: 0, width: '100%' }}
                  >
                    <span className="text-[11px] font-semibold text-marine-accent mb-1 truncate">
                      {chatLabels[msg.chatId ?? ''] || msg.chatId || 'Unknown Chat'}
                    </span>
                    <span
                      className="text-xs font-medium text-marine-navy break-words line-clamp-3"
                      style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', width: '100%' }}
                    >
                      {msg.text || '—'}
                    </span>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[10px] text-marine-navy/70">{msg.timestamp}</span>
                      <span className="text-[10px] text-marine-navy/40 ml-2">{msg.parsedOk ? 'Parsed' : 'Unparsed'}</span>
                    </div>
                  </div>
                ))}
                {hasMoreMessages && (
                  <div ref={loaderRef} className="py-3 text-center text-xs text-marine-navy/40">Loading more…</div>
                )}
              </>
            )}
          </div>
        </div>
        {/* Recent Trades Preview */}
        <div className="rounded-xl border border-marine-navy/10 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-marine-navy/10 px-4 py-3">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-marine-navy/40" />
              <h2 className="text-sm font-semibold text-marine-navy">Recent Trades</h2>
            </div>
            <Link href="/trades">
              <Button variant="ghost" size="sm">
                View All
                <ArrowRight className="h-3 w-3" />
              </Button>
            </Link>
          </div>
          <div className="divide-y divide-marine-navy/5">
            {trades.slice(0, 3).map((trade) => (
              <div
                key={trade.id}
                className="flex items-center justify-between px-4 py-3 transition-colors hover:bg-marine-mist/30"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`
                      flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold
                      ${trade.direction === 'LONG'
                        ? 'bg-trade-up/10 text-trade-up'
                        : 'bg-trade-down/10 text-trade-down'
                      }
                    `}
                  >
                    {trade.direction === 'LONG' ? '↑' : '↓'}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-marine-navy">{trade.symbol}</p>
                    <p className="text-[10px] text-marine-navy/50">
                      {trade.direction} · {trade.state.replace('_', ' ')}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p
                    className={`text-sm font-semibold ${
                      typeof trade.pnlValue === 'number'
                        ? trade.pnlValue >= 0
                          ? 'text-trade-up'
                          : 'text-trade-down'
                        : 'text-marine-navy/60'
                    }`}
                  >
                    {trade.pnl ?? '—'}
                  </p>
                  <p className="text-[10px] text-marine-navy/50">{trade.createdAt ?? '—'}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
