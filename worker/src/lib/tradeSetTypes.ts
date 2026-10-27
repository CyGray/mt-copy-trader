/**
 * tradeSetTypes.ts
 *
 * Types and pure helpers for the Vantage AutoTrader data model
 * (contracts §5): `trade_sets/{chatId}_{messageId}` (schema 2) and
 * `trade_events/{trade_set_id}__{event_key}`. Stored fields are snake_case.
 */

import { createHash } from 'node:crypto';
import type { BrokerOrderType } from './brokerTypes';
import type { EffectiveLimits, ExecutionProfile } from './executionProfile';
import type { PlannedCheckpoint } from './positionSizing';
import type { GoldSignal } from './vipSignalParser';

export type TradeState =
  | 'CLAIMED'
  | 'SKIPPED'
  | 'SUBMITTING'
  | 'SUBMIT_UNKNOWN'
  | 'PENDING_ORDER'
  | 'OPEN'
  | 'PARTIALLY_CLOSED'
  | 'CLOSED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'ERROR';

export const ACTIVE_TRADE_STATES = ['OPEN', 'PARTIALLY_CLOSED', 'PENDING_ORDER'] as const;
export const IN_FLIGHT_TRADE_STATES = ['CLAIMED', 'SUBMITTING', 'SUBMIT_UNKNOWN'] as const;
/** Not in the contract text; derived from the TradeState comments (no further lifecycle). */
export const TERMINAL_TRADE_STATES = ['SKIPPED', 'CLOSED', 'CANCELLED', 'REJECTED', 'ERROR'] as const;

export interface CheckpointState {
  tp_index: number;
  price: number;
  close_volume: number;
  target_remaining_volume: number;
  status: 'pending' | 'closing' | 'done' | 'failed';
  attempts: number;
  requested_at?: string;
  ambiguous_until?: number;
  confirmed_at?: string;
  deal_ticket?: number;
  realized_pnl?: number;
  last_error?: string;
}

export interface TradeLifecycle {
  checkpoints: CheckpointState[];
  current_volume: number;
  current_sl: number;
  current_tp: number;
  be_applied: boolean;
  trailing_active: boolean;
  best_price: number;
}

export interface TradePlan {
  volume: number;
  entry_ref_price: number;
  order_price: number;
  sl: number;
  broker_tp: number;
  risk_money: number;
  risk_percent: number;
  checkpoints: PlannedCheckpoint[];
}

export interface BrokerRefs {
  order_ticket: number;
  position_ticket: number;
  deal_ticket: number;
  fill_price: number;
  filled_volume: number;
  /** Pending orders: false when the broker ignored the expiry (order is GTC; the worker cancels it). */
  expiration_applied?: boolean;
}

export interface TradeResult {
  closed_at: string;
  close_reason: 'tp' | 'sl' | 'manual' | 'close_all' | 'cancel' | 'checkpoints_complete' | 'unknown';
  realized_pnl: number;
}

export interface TradeSetDoc {
  schema: 2;
  trade_set_id: string;
  chat_id: string;
  message_id: string;
  event_id: string;
  signal: GoldSignal;
  signal_revisions: {
    event_id: string;
    text_hash: string;
    received_at: string;
    outcome: 'applied' | 'ignored';
    reason: string;
  }[];
  symbol: string;
  broker_symbol: string | null;
  direction: 'buy' | 'sell';
  order_type: BrokerOrderType | null;
  mode: 'paper' | 'demo' | 'live' | 'disabled';
  broker: 'mt5' | 'simulated' | null;
  profile: { doc_id: string; profile_id: string; version: number } | null;
  profile_snapshot: ExecutionProfile | null;
  limits_snapshot: EffectiveLimits | null;
  state: TradeState;
  skip_reason?: string;
  error?: string;
  correlation_comment: string;
  claim: { attempts: number; claimed_at: string; owner: string };
  plan: TradePlan | null;
  /**
   * expires_at: GMT sec after which the EA refuses the request. pending_expires_at:
   * GMT sec when a pending entry should no longer be working (profile pending_expiry_minutes).
   */
  submission: { submitted_at: string; expires_at: number; request_id: string; pending_expires_at?: number } | null;
  broker_refs: BrokerRefs | null;
  lifecycle: TradeLifecycle | null;
  result: TradeResult | null;
  cancel_requested?: { reason: 'unparseable_edit' | 'explicit_cancel'; at: string; event_id: string };
  /** Set by the admin close-all sweep; the lifecycle and reconciler close or classify accordingly. */
  close_requested_by?: 'close_all';
  created_at: string;
  updated_at: string;
}

export type TradeEventType =
  | 'signal_received'
  | 'signal_validated'
  | 'execution_skipped'
  | 'entry_submitted'
  | 'entry_confirmed'
  | 'entry_rejected'
  | 'entry_unknown'
  | 'pending_order_placed'
  | 'pending_order_filled'
  | 'pending_order_cancelled'
  | 'protection_confirmed'
  | 'tp_checkpoint_reached'
  | 'partial_close_requested'
  | 'partial_close_confirmed'
  | 'partial_close_failed'
  | 'sl_modified'
  | 'break_even_applied'
  | 'trailing_updated'
  | 'position_closed'
  | 'signal_revision_applied'
  | 'signal_revision_ignored'
  | 'cancel_requested'
  | 'reconciliation'
  | 'execution_error';

export interface TradeEventInput {
  tradeSetId: string;
  eventKey: string;
  type: TradeEventType;
  mode?: string;
  profileDocId?: string | null;
  profileVersion?: number | null;
  reasonCode?: string;
  message?: string;
  orderTicket?: number;
  positionTicket?: number;
  dealTicket?: number;
  volume?: number;
  price?: number;
  sl?: number;
  tp?: number;
  realizedPnl?: number;
  retcode?: number;
  details?: Record<string, unknown>;
}

export function tradeSetIdFor(chatId: string, messageId: string): string {
  return `${chatId}_${messageId}`;
}

export function correlationComment(tradeSetId: string): string {
  return 'BT-' + createHash('sha256').update(tradeSetId).digest('hex').slice(0, 12);
}
