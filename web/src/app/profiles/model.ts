import type { ProfilePreview } from '@/lib/profilePreview';

// Client-side model for the Profiles page. The server routes are the real gate.

export interface ValidationIssue {
  path: string;
  message: string;
  value?: unknown;
  limit?: unknown;
}

export interface ValidationRecord {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  validated_at: string | null;
}

export interface ProfileSummary {
  doc_id: string;
  profile_id: string | null;
  version: number | null;
  name: string | null;
  status: string | null;
  validation: { ok: boolean; error_count: number; warning_count: number; validated_at: string | null };
  created_at: string | null;
  approved_at: string | null;
  activated_at: string | null;
  superseded_at: string | null;
  updated_at: string | null;
}

export interface ProfileListResponse {
  profiles: ProfileSummary[];
  active_profile_doc_id: string | null;
}

export interface ProfileMeta {
  validation: ValidationRecord | null;
  created_at: string | null;
  created_by: string | null;
  updated_at: string | null;
  updated_by: string | null;
  approved_at: string | null;
  approved_by: string | null;
  activated_at: string | null;
  activated_by: string | null;
  superseded_at: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  rejected_reason: string | null;
}

export interface ProfileDetail {
  doc_id: string;
  status: string | null;
  profile: Record<string, unknown>;
  meta: ProfileMeta;
}

export interface ValidateResponse {
  validation: { ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] };
  safety: { source: 'stored' | 'default'; valid: boolean; errors: ValidationIssue[] };
  safetyIssues: ValidationIssue[];
  preview: ProfilePreview | null;
  notes: string[];
}

export interface AuditEntry {
  id: string;
  action: string | null;
  profile_doc_id: string | null;
  previous_active_doc_id: string | null;
  actor_email: string | null;
  at: string | null;
  details: Record<string, unknown> | null;
}

export interface PreviewForm {
  symbol: string;
  direction: 'buy' | 'sell';
  orderType: 'market' | 'buy_limit' | 'sell_limit' | 'buy_stop' | 'sell_stop';
  entryLow: string;
  entryHigh: string;
  stopLoss: string;
  takeProfits: string;
  bid: string;
  ask: string;
  equity: string;
  tickSize: string;
  tickValueLoss: string;
  volumeMin: string;
  volumeMax: string;
  volumeStep: string;
}

/**
 * XAUUSD-like symbol defaults. Real values come from the broker's SYMBOL_INFO at
 * execution time, so treat these as an illustration only.
 */
export const DEFAULT_PREVIEW_FORM: PreviewForm = {
  symbol: 'XAUUSD',
  direction: 'buy',
  orderType: 'market',
  entryLow: '2000',
  entryHigh: '2002',
  stopLoss: '1995',
  takeProfits: '2010, 2020, 2030',
  bid: '2001',
  ask: '2001.2',
  equity: '10000',
  tickSize: '0.01',
  tickValueLoss: '1',
  volumeMin: '0.01',
  volumeMax: '100',
  volumeStep: '0.01',
};

export type PreviewPayload = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

function toNumber(raw: string): number | null {
  if (raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Converts the preview form to the request payload. Every number is checked here and again on the server. */
export function toPreviewPayload(form: PreviewForm): PreviewPayload {
  const numeric: [string, string][] = [
    ['Entry low', form.entryLow],
    ['Entry high', form.entryHigh],
    ['Stop loss', form.stopLoss],
    ['Bid', form.bid],
    ['Ask', form.ask],
    ['Equity', form.equity],
    ['Tick size', form.tickSize],
    ['Tick value loss', form.tickValueLoss],
    ['Min volume', form.volumeMin],
    ['Max volume', form.volumeMax],
    ['Volume step', form.volumeStep],
  ];
  const values: number[] = [];
  for (const [label, raw] of numeric) {
    const value = toNumber(raw);
    if (value === null) return { ok: false, error: `${label} must be a number` };
    values.push(value);
  }

  const takeProfits: number[] = [];
  for (const part of form.takeProfits.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const value = toNumber(trimmed);
    if (value === null) return { ok: false, error: 'Take profits must be numbers separated by commas' };
    takeProfits.push(value);
  }

  const [entryLow, entryHigh, stopLoss, bid, ask, equity, tickSize, tickValueLoss, volumeMin, volumeMax, volumeStep] =
    values;
  return {
    ok: true,
    value: {
      signal: {
        symbol: form.symbol.trim().toUpperCase(),
        direction: form.direction,
        orderType: form.orderType,
        entryLow,
        entryHigh,
        stopLoss,
        takeProfits,
      },
      quote: { bid, ask },
      equity,
      spec: { tickSize, tickValueLoss, volumeMin, volumeMax, volumeStep },
    },
  };
}

export function formatIssue(issue: ValidationIssue): string {
  const parts = [issue.message];
  if (issue.value !== undefined) parts.push(`value ${JSON.stringify(issue.value)}`);
  if (issue.limit !== undefined) parts.push(`limit ${JSON.stringify(issue.limit)}`);
  return parts.join(' · ');
}

export function fmt(value: number | null | undefined, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

export function fmtMoney(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value >= 0 ? '' : '-'}$${Math.abs(value).toFixed(2)}` : '—';
}

export const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  draft: 'neutral',
  approved: 'info',
  active: 'success',
  superseded: 'warning',
  rejected: 'danger',
};

/** Parses the editor text. Returns the object or a readable JSON error. */
export function parseProfileText(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : 'parse error'}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'The profile must be one JSON object' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}
