'use client';

import { useEffect, useMemo, useState } from 'react';
import { DashboardLayout } from '@/components/layouts/DashboardLayout';
import { CompactTable } from '@/components/ui/CompactTable';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Button } from '@/components/ui/Button';
import { Search, Download, RefreshCw } from 'lucide-react';
import { collection, onSnapshot, orderBy, query, limit, doc } from 'firebase/firestore';
import { firestoreDb } from '@/lib/firebaseClient';
import { formatTimestamp } from '@/lib/format';

type LogTab = 'telegram' | 'system' | 'errors';

type TelegramLog = {
  id: string;
  timestamp: string;
  chatId: string;
  message: string;
  parsedOk: boolean;
  type: string;
};

type SystemLog = {
  id: string;
  timestamp: string;
  level: string;
  component: string;
  message: string;
};

export default function LogsPage() {
  const [activeTab, setActiveTab] = useState<LogTab>('telegram');
  const [searchQuery, setSearchQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const [telegramLogs, setTelegramLogs] = useState<TelegramLog[]>([]);
  const [systemLogs, setSystemLogs] = useState<SystemLog[]>([]);
  const [chatLabels, setChatLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!firestoreDb) return;

    const telegramQuery = query(
      collection(firestoreDb, 'telegram_messages'),
      orderBy('timestamp', 'desc'),
      limit(200),
    );

    const systemQuery = query(
      collection(firestoreDb, 'system_logs'),
      orderBy('timestamp', 'desc'),
      limit(200),
    );

    const unsubscribeTelegram = onSnapshot(telegramQuery, (snapshot) => {
      const nextLogs: TelegramLog[] = snapshot.docs.map((docSnap) => {
        const data = docSnap.data() as Record<string, unknown>;
        return {
          id: docSnap.id,
          timestamp: formatTimestamp(data.timestamp as string | undefined),
          chatId: String(data.chat_id ?? ''),
          message: String(data.text ?? ''),
          parsedOk: Boolean(data.parsed_ok),
          type: String(data.type ?? 'new'),
        };
      });
      setTelegramLogs(nextLogs);
    });

    const unsubscribeSystem = onSnapshot(systemQuery, (snapshot) => {
      const nextLogs: SystemLog[] = snapshot.docs.map((docSnap) => {
        const data = docSnap.data() as Record<string, unknown>;
        return {
          id: docSnap.id,
          timestamp: formatTimestamp(data.timestamp as string | undefined),
          level: String(data.level ?? 'info'),
          component: String(data.component ?? 'system'),
          message: String(data.message ?? ''),
        };
      });
      setSystemLogs(nextLogs);
    });

    const settingsRef = doc(firestoreDb, 'settings', 'default');
    const unsubscribeSettings = onSnapshot(settingsRef, (snap) => {
      const data = snap.data() as { telegram?: { chat_id_labels?: Record<string, string> } } | undefined;
      setChatLabels(data?.telegram?.chat_id_labels ?? {});
    });

    return () => {
      unsubscribeTelegram();
      unsubscribeSystem();
      unsubscribeSettings();
    };
  }, []);

  // Filter logs based on search
  const filteredTelegramLogs = useMemo(() => {
    let logs = telegramLogs;
    if (sourceFilter) {
      logs = logs.filter(
        (log) =>
          chatLabels[log.chatId] === sourceFilter ||
          log.chatId === sourceFilter
      );
    }
    if (!searchQuery.trim()) return logs;
    const q = searchQuery.toLowerCase();
    return logs.filter(
      (log) =>
        log.message.toLowerCase().includes(q) ||
        chatLabels[log.chatId]?.toLowerCase().includes(q)
    );
  }, [searchQuery, telegramLogs, chatLabels, sourceFilter]);

  const filteredSystemLogs = useMemo(() => {
    const baseLogs = activeTab === 'errors'
      ? systemLogs.filter((log) => log.level === 'error' || log.level === 'warn')
      : systemLogs;
      
    if (!searchQuery.trim()) return baseLogs;
    const q = searchQuery.toLowerCase();
    return baseLogs.filter(
      (log) =>
        log.message.toLowerCase().includes(q) ||
        log.component.toLowerCase().includes(q)
    );
  }, [searchQuery, activeTab, systemLogs]);

  const getLevelStatus = (level: string) => {
    switch (level) {
      case 'error':
        return 'danger';
      case 'warning':
      case 'warn':
        return 'warning';
      case 'info':
        return 'success';
      default:
        return 'neutral';
    }
  };


  const telegramCount = telegramLogs.length;
  const systemCount = systemLogs.length;
  const errorCount = systemLogs.filter((l) => l.level === 'error' || l.level === 'warn').length;

  return (
    <DashboardLayout
      title="Logs"
      subtitle="System and Telegram message logs"
      breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Logs' }]}
    >
      <div className="space-y-4">
        {/* Filters & Search */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-2 w-full">
            {/* Log Type Dropdown */}
            <select
              value={activeTab}
              onChange={e => {
                setActiveTab(e.target.value as LogTab);
                setSourceFilter('');
              }}
              className="rounded-lg border border-marine-navy/20 bg-white py-2 px-3 text-xs sm:text-sm text-marine-navy focus:border-marine-accent focus:outline-none focus:ring-2 focus:ring-marine-accent/20 w-1/2"
            >
              <option value="telegram">Telegram ({telegramCount})</option>
              <option value="system">System ({systemCount})</option>
              <option value="errors">Errors ({errorCount})</option>
            </select>
            {/* Source Filter Dropdown (only for Telegram tab) */}
            <select
              value={sourceFilter}
              onChange={e => setSourceFilter(e.target.value)}
              className={`rounded-lg border border-marine-navy/20 bg-white py-2 px-3 text-xs sm:text-sm text-marine-navy focus:border-marine-accent focus:outline-none focus:ring-2 focus:ring-marine-accent/20 w-1/2 ${activeTab !== 'telegram' ? 'opacity-50 pointer-events-none' : ''}`}
              disabled={activeTab !== 'telegram'}
            >
              <option value="">All Sources</option>
              {Array.from(
                new Set(
                  telegramLogs.map((log) => chatLabels[log.chatId] || log.chatId)
                )
              )
                .sort((a, b) => a.localeCompare(b))
                .map((labelOrId) => (
                  <option key={labelOrId} value={labelOrId}>
                    {labelOrId}
                  </option>
                ))}
            </select>
          </div>
          <div className="relative flex-1 sm:w-64 mt-2 sm:mt-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-marine-navy/40" />
            <input
              type="text"
              placeholder="Search logs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg border border-marine-navy/20 bg-white py-2 pl-9 pr-4 text-xs sm:text-sm text-marine-navy placeholder:text-marine-navy/40 focus:border-marine-accent focus:outline-none focus:ring-2 focus:ring-marine-accent/20"
            />
          </div>
        </div>

        {/* Log Tables */}
        <div className="overflow-x-auto rounded-lg border border-marine-navy/10 bg-white">
          {activeTab === 'telegram' ? (
            <>
              {/* Mobile: 1-col card layout */}
              <div className="block sm:hidden p-2">
                {filteredTelegramLogs.length === 0 ? (
                  <div className="text-[11px] text-marine-navy/50 py-6 text-center">No Telegram logs found</div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {filteredTelegramLogs.map((log) => (
                        <div
                          key={log.id}
                          className="w-full max-w-full mx-auto rounded-xl border border-marine-accent/20 bg-marine-accent/10 px-3 py-2 flex flex-col"
                          style={{ minWidth: 0, width: '100%' }}
                        >
                        <span className="text-[11px] font-semibold text-marine-accent mb-1 truncate">
                          {chatLabels[log.chatId] || log.chatId || 'Unknown'}
                        </span>
                        <span className="text-xs font-medium text-marine-navy break-words line-clamp-3" style={{display:'-webkit-box',WebkitLineClamp:3,WebkitBoxOrient:'vertical',overflow:'hidden'}}>
                          {log.message}
                        </span>
                        <span className="text-[10px] text-marine-navy/70 mt-1">{log.timestamp}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* Desktop: 4-col table */}
              <div className="hidden sm:block">
                <CompactTable
                  headers={['Time', 'Source', 'Message', 'Status']}
                  rows={filteredTelegramLogs.map((log) => ({
                    time: <span className="text-[11px] text-marine-navy/60">{log.timestamp}</span>,
                    source: (
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm text-marine-navy">
                          {chatLabels[log.chatId] || log.chatId || 'Unknown'}
                        </span>
                      </div>
                    ),
                    message: (
                      <span className="block max-w-md truncate text-sm text-marine-navy/80">
                        {log.message}
                      </span>
                    ),
                    status: (
                      <StatusBadge
                        status={log.parsedOk ? 'success' : 'warning'}
                        label={log.parsedOk ? 'Parsed' : 'Skipped'}
                        size="sm"
                      />
                    ),
                  }))}
                  maxHeight="calc(100vh - 280px)"
                  emptyMessage="No Telegram logs found"
                />
              </div>
            </>
          ) : (
            <CompactTable
              headers={['Time', 'Level', 'Component', 'Message']}
              rows={filteredSystemLogs.map((log) => ({
                time: <span className="text-[10px] sm:text-[11px] text-marine-navy/60">{log.timestamp}</span>,
                level: (
                  <StatusBadge
                    status={getLevelStatus(log.level)}
                    label={log.level.toUpperCase()}
                    size="sm"
                    pulse={log.level === 'error'}
                  />
                ),
                component: (
                  <span className="rounded bg-marine-mist px-2 py-0.5 text-[10px] sm:text-[11px] font-medium text-marine-navy/70">
                    {log.component}
                  </span>
                ),
                message: (
                  <span className="block max-w-[200px] sm:max-w-lg truncate text-xs sm:text-sm text-marine-navy/80">
                    {log.message}
                  </span>
                ),
              }))}
              maxHeight="calc(100vh - 280px)"
              emptyMessage="No system logs found"
            />
          )}
        </div>

        {/* Footer Stats */}
        <div className="flex items-center justify-between rounded-lg bg-marine-mist/50 px-4 py-2 text-[10px] text-marine-navy/50">
          <span>
            Showing{' '}
            {activeTab === 'telegram' ? filteredTelegramLogs.length : filteredSystemLogs.length}{' '}
            logs
          </span>
          <span>Last updated: Just now</span>
        </div>
      </div>
    </DashboardLayout>
  );
}
