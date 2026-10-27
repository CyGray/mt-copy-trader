'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { authedFetch } from '@/lib/adminApi';
import { openCounts, toAlertRow } from '@/lib/alertView';
import { useAuth } from '@/lib/useAuth';

const REFRESH_MS = 30_000;

/** Overview banner: open operator alerts by severity, linking to /alerts. Renders nothing when clear. */
export function AlertBanner() {
  const { user } = useAuth();
  const [counts, setCounts] = useState<ReturnType<typeof openCounts> | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      try {
        const data = await authedFetch<{ alerts: Record<string, unknown>[] }>('/api/alerts?view=open');
        if (!cancelled) setCounts(openCounts(data.alerts.map(toAlertRow)));
      } catch {
        if (!cancelled) setCounts(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [user]);

  if (!counts) return null;
  const total = counts.critical + counts.error + counts.warning + counts.info;
  if (total === 0) return null;
  const urgent = counts.critical + counts.error > 0;

  return (
    <Link
      href="/alerts"
      className={`block rounded-xl border px-4 py-3 text-sm ${
        urgent ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800'
      }`}
    >
      <span className="font-semibold">{total} open alert{total === 1 ? '' : 's'}</span>
      {counts.critical > 0 ? ` · ${counts.critical} critical` : ''}
      {counts.error > 0 ? ` · ${counts.error} error` : ''}
      {counts.warning > 0 ? ` · ${counts.warning} warning` : ''}
      {counts.info > 0 ? ` · ${counts.info} info` : ''}
      <span className="ml-2 underline">Review</span>
    </Link>
  );
}
