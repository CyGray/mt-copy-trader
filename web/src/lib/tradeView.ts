/**
 * tradeView.ts
 *
 * Pure mapping from stored trade documents to the rows and timeline entries the
 * Trades page renders. Schema-2 trade sets (contracts section 5) and legacy
 * schema-1 (Bybit-era) records share one list, so historical trades still
 * display. Kept free of React and Firebase so it can be unit tested.
 */

import type { TradeSetDoc } from '@shared/tradeSetTypes';

export type TradeFilter = 'all' | 'active' | 'closed' | 'issues';

export const ACTIVE_STATES = ['OPEN', 'PARTIALLY_CLOSED', 'PENDING_ORDER', 'PROTECTION_PLACED', 'ENTRY_PLACED'];
export const ISSUE_STATES = ['SKIPPED', 'REJECTED', 'ERROR', 'SUBMIT_UNKNOWN'];

export interface TradeRow {
  id: string;
  schema: 1 | 2;
  createdAt: string | null;
  symbol: string;
  direction: 'buy' | 'sell' | null;
  mode: string | null;
  state: string;
  profileLabel: string | null;
  volume: number | null;
  currentVolume: number | null;
  entryPrice: number | null;
  sl: number | null;
  realizedPnl: number | null;
  skipReason: string | null;
  error: string | null;
  t2: TradeSetDoc | null;
  legacy: Record<string, unknown> | null;
}

export interface TradeEventRow {
  id: string;
  type: string;
  timestamp: string | null;
  message: string | null;
  reasonCode: string | null;
  mode: string | null;
  profileDocId: string | null;
  price: number | null;
  volume: number | null;
  sl: number | null;
  tp: number | null;
  orderTicket: number | null;
  positionTicket: number | null;
  dealTicket: number | null;
  realizedPnl: number | null;
}


export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function price(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}

export function volume(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}

export function money(value: number | null): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}`;
}

export function sideLabel(direction: 'buy' | 'sell' | null): string {
  if (direction === 'buy') return 'BUY';
  if (direction === 'sell') return 'SELL';
  return '—';
}

export function sumOrNull(values: (number | undefined)[]): number | null {
  const present = values.filter((v): v is number => typeof v === 'number');
  return present.length > 0 ? present.reduce((total, v) => total + v, 0) : null;
}

export function toRow(id: string, data: Record<string, unknown>): TradeRow {
  if (data.schema === 2) {
    const t = data as unknown as TradeSetDoc;
    const checkpointPnl = sumOrNull((t.lifecycle?.checkpoints ?? []).map((cp) => cp.realized_pnl));
    return {
      id,
      schema: 2,
      createdAt: str(t.created_at),
      symbol: t.symbol ?? '—',
      direction: t.direction ?? null,
      mode: t.mode ?? null,
      state: t.state ?? 'UNKNOWN',
      profileLabel: t.profile ? `${t.profile.profile_id} v${t.profile.version}` : null,
      volume: t.plan?.volume ?? null,
      currentVolume: t.lifecycle?.current_volume ?? null,
      entryPrice: t.broker_refs?.fill_price ?? null,
      sl: t.lifecycle?.current_sl ?? t.plan?.sl ?? null,
      realizedPnl: t.result ? t.result.realized_pnl : checkpointPnl,
      skipReason: str(t.skip_reason),
      error: str(t.error),
      t2: t,
      legacy: null,
    };
  }

  const bybit = (data.bybit ?? {}) as Record<string, unknown>;
  const rawDirection = str(data.direction);
  return {
    id,
    schema: 1,
    createdAt: str(data.created_at),
    symbol: str(data.symbol) ?? '—',
    direction: rawDirection === 'LONG' ? 'buy' : rawDirection === 'SHORT' ? 'sell' : null,
    mode: null,
    state: str(data.state) ?? 'UNKNOWN',
    profileLabel: null,
    volume: num(bybit.qty ?? data.qty),
    currentVolume: null,
    entryPrice: num(bybit.avg_entry_price ?? data.entry_price ?? data.entry),
    sl: num(data.sl),
    realizedPnl: num(data.pnl_value ?? data.pnlValue ?? data.realized_pnl),
    skipReason: str(data.skip_reason),
    error: str(data.error),
    t2: null,
    legacy: data,
  };
}

export function toEvent(id: string, data: Record<string, unknown>): TradeEventRow {
  return {
    id,
    type: str(data.type) ?? str(data.event_type) ?? 'event',
    timestamp: str(data.timestamp),
    message: str(data.message),
    reasonCode: str(data.reason_code),
    mode: str(data.mode),
    profileDocId: str(data.profile_doc_id),
    price: num(data.price),
    volume: num(data.volume),
    sl: num(data.sl),
    tp: num(data.tp),
    orderTicket: num(data.order_ticket),
    positionTicket: num(data.position_ticket),
    dealTicket: num(data.deal_ticket),
    realizedPnl: num(data.realized_pnl),
  };
}

export function sortByTimestamp(items: TradeEventRow[]): TradeEventRow[] {
  return [...items].sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
}

export function stateTone(state: string, realizedPnl: number | null): 'success' | 'warning' | 'danger' | 'neutral' | 'info' {
  if (state === 'CLOSED') return realizedPnl !== null && realizedPnl < 0 ? 'danger' : 'success';
  if (ACTIVE_STATES.includes(state)) return 'info';
  if (state === 'CLAIMED' || state === 'SUBMITTING') return 'warning';
  if (state === 'REJECTED' || state === 'ERROR' || state === 'SUBMIT_UNKNOWN') return 'danger';
  return 'neutral';
}

export function modeTone(mode: string | null): 'success' | 'warning' | 'danger' | 'neutral' | 'info' {
  if (mode === 'live') return 'danger';
  if (mode === 'demo') return 'info';
  return 'neutral';
}

/** Rows shown under a filter tab. */
export function filterRows(rows: TradeRow[], filter: TradeFilter): TradeRow[] {
  if (filter === 'active') return rows.filter((row) => ACTIVE_STATES.includes(row.state));
  if (filter === 'closed') return rows.filter((row) => row.state === 'CLOSED');
  if (filter === 'issues') return rows.filter((row) => ISSUE_STATES.includes(row.state));
  return rows;
}
