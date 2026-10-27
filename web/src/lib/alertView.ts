/**
 * alertView.ts
 *
 * Display helpers for operator alerts and the signal queue (pure, testable).
 */

import type { AlertSeverity } from '@shared/alertTypes';

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

export interface AlertRow {
  id: string;
  type: string;
  subject: string;
  severity: AlertSeverity;
  status: 'open' | 'acknowledged' | 'resolved';
  title: string;
  message: string;
  action: string;
  source: string;
  count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  acknowledged_by: string | null;
  resolved_by: string | null;
  resolution: string | null;
}

export function severityTone(severity: string): Tone {
  if (severity === 'critical' || severity === 'error') return 'danger';
  if (severity === 'warning') return 'warning';
  return 'info';
}

export function alertStatusTone(status: string): Tone {
  if (status === 'open') return 'danger';
  if (status === 'acknowledged') return 'warning';
  return 'success';
}

export function queueStatusTone(status: string | null | undefined): Tone {
  if (status === 'dead_letter') return 'danger';
  if (status === 'retry_wait' || status === 'processing') return 'warning';
  if (status === 'done') return 'success';
  if (status === 'pending') return 'info';
  return 'neutral';
}

/** Normalises an alert document from /api/alerts for display. Unknown fields get safe defaults. */
export function toAlertRow(raw: Record<string, unknown>): AlertRow {
  const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
  const nullable = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const severity = str(raw.severity, 'info');
  const status = str(raw.status, 'open');
  return {
    id: str(raw.id),
    type: str(raw.type, 'unknown'),
    subject: str(raw.subject),
    severity: (['critical', 'error', 'warning', 'info'].includes(severity) ? severity : 'info') as AlertSeverity,
    status: (['open', 'acknowledged', 'resolved'].includes(status) ? status : 'open') as AlertRow['status'],
    title: str(raw.title, str(raw.type, 'Alert')),
    message: str(raw.message),
    action: str(raw.action),
    source: str(raw.source),
    count: typeof raw.count === 'number' ? raw.count : 1,
    first_seen_at: nullable(raw.first_seen_at),
    last_seen_at: nullable(raw.last_seen_at),
    acknowledged_by: nullable(raw.acknowledged_by),
    resolved_by: nullable(raw.resolved_by),
    resolution: nullable(raw.resolution),
  };
}

/** Counts of open alerts by severity, for the overview banner. */
export function openCounts(rows: AlertRow[]): Record<AlertSeverity, number> {
  const counts: Record<AlertSeverity, number> = { critical: 0, error: 0, warning: 0, info: 0 };
  for (const row of rows) if (row.status === 'open') counts[row.severity] += 1;
  return counts;
}
