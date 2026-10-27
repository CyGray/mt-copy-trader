/**
 * adminCommands.ts
 *
 * Polls `admin_commands` for operator commands and executes them on the
 * AutoTrader (contracts §7). Only `close_all` is supported. A command is claimed
 * in a transaction (pending -> running), so it runs once even when several
 * pollers see it.
 *
 * close_all engages the kill switch first, then on each broker in use cancels
 * the pending orders and closes the positions that carry the EA magic. It never
 * touches anything else. Results are recorded per ticket, and affected trade
 * sets are marked so the lifecycle finalizes them with close_reason close_all.
 * Ambiguous broker outcomes are recorded and never retried here.
 */

import { hostname } from 'node:os';
import { raiseAlert } from './alerts';
import { getBroker, type BrokerMode } from './brokerRouter';
import {
  BrokerAmbiguousError,
  BrokerRejectedError,
  type BrokerAdapter,
  type BrokerOrder,
  type BrokerPosition,
} from './brokerTypes';
import { getExecutionControl, invalidateExecutionControl } from './executionControl';
import { logger } from './logger';
import { writeSystemLog } from './systemLog';
import { recordTradeEvent } from './tradeEvents';
import { listTradeSetsByState, requireFirestore, transitionTradeSet, updateTradeSet } from './tradeSetStore';
import type { TradeSetDoc, TradeState } from './tradeSetTypes';

const COMMAND_COLLECTION = 'admin_commands';
const POLL_LIMIT = 10;
const COMMAND_MAX_AGE_SEC = 300;
const CONFIRM_TEXT = 'CLOSE ALL';
const DEFAULT_INTERVAL_MS = 3000;
const NON_TERMINAL_STATES: readonly TradeState[] = [
  'CLAIMED',
  'SUBMITTING',
  'SUBMIT_UNKNOWN',
  'PENDING_ORDER',
  'OPEN',
  'PARTIALLY_CLOSED',
];

export interface CloseAllEntry {
  mode: BrokerMode;
  /** Absent for a read failure, which concerns the whole broker. */
  ticket?: number;
  kind: 'position' | 'order' | 'read' | 'mark';
  /** 1 for the first sweep, 2 for the sweep after the settle delay. */
  sweep: 1 | 2;
  ok: boolean;
  retcode?: number;
  error?: string;
}

/**
 * Wait between the two sweeps. Longer than the 8 s request lifetime, so an entry
 * already sent before the kill switch has either executed or expired at the EA.
 */
const DEFAULT_SETTLE_MS = 10_000;
let settleMs = DEFAULT_SETTLE_MS;

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Test seam: `ms` = 0 skips the settle wait. `null` restores the default. */
export function setCloseAllSettleMsForTests(ms: number | null): void {
  settleMs = ms ?? DEFAULT_SETTLE_MS;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isoNow(): string {
  return new Date().toISOString();
}

function runnerId(): string {
  return `${hostname()}:${process.pid}`;
}

async function notify(level: 'info' | 'warn' | 'error', event: string, details: Record<string, unknown>): Promise<void> {
  logger[level](event, details);
  await writeSystemLog(level, 'admin', event, details);
}

async function finish(id: string, status: 'done' | 'rejected' | 'failed', result: Record<string, unknown>): Promise<void> {
  await requireFirestore().collection(COMMAND_COLLECTION).doc(id).set(
    { status, finished_at: isoNow(), result },
    { merge: true },
  );
  const level = status === 'done' ? 'info' : status === 'rejected' ? 'warn' : 'error';
  await notify(level, 'admin_command_finished', { command_id: id, status, reason: result.reason ?? null });
}

/** Claims a pending command. Returns its data, or null when another runner won or it is no longer pending. */
async function claimCommand(id: string): Promise<Record<string, unknown> | null> {
  const firestore = requireFirestore();
  const ref = firestore.collection(COMMAND_COLLECTION).doc(id);
  try {
    return await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const data = snap.data() as Record<string, unknown>;
      if (data.status !== 'pending') return null;
      tx.set(ref, { status: 'running', started_at: isoNow(), runner: runnerId() }, { merge: true });
      return data;
    });
  } catch (err) {
    logger.warn('admin_command_claim_failed', { command_id: id, error: errorMessage(err) });
    return null;
  }
}

/** Claims and runs up to 10 pending commands. Returns how many this runner claimed. */
export async function runAdminCommands(): Promise<number> {
  let pending: { id: string; data: Record<string, unknown> }[];
  try {
    const snap = await requireFirestore()
      .collection(COMMAND_COLLECTION)
      .where('status', '==', 'pending')
      .limit(POLL_LIMIT)
      .get();
    pending = snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
  } catch (err) {
    logger.warn('admin_command_poll_failed', { error: errorMessage(err) });
    return 0;
  }

  let claimed = 0;
  for (const cmd of pending) {
    const data = await claimCommand(cmd.id);
    if (!data) continue;
    claimed++;
    try {
      await executeCommand(cmd.id, data);
    } catch (err) {
      await finish(cmd.id, 'failed', { reason: 'unexpected_error', error: errorMessage(err) }).catch(() => undefined);
    }
  }
  return claimed;
}

async function executeCommand(id: string, cmd: Record<string, unknown>): Promise<void> {
  if (cmd.type !== 'close_all') {
    return finish(id, 'rejected', { reason: 'unknown_type', type: String(cmd.type ?? '') });
  }
  if (cmd.confirm !== CONFIRM_TEXT) {
    return finish(id, 'rejected', { reason: 'confirm_mismatch' });
  }
  const requested = Date.parse(String(cmd.requested_at ?? ''));
  if (!Number.isFinite(requested)) {
    return finish(id, 'rejected', { reason: 'invalid_requested_at' });
  }
  if (Date.now() - requested > COMMAND_MAX_AGE_SEC * 1000) {
    return finish(id, 'rejected', { reason: 'expired' });
  }
  await closeAll(id);
}

function outcomeOf(err: unknown): { error: string; retcode?: number } {
  if (err instanceof BrokerAmbiguousError) return { error: 'ambiguous' };
  if (err instanceof BrokerRejectedError) return { error: err.message, retcode: err.retcode };
  return { error: errorMessage(err) };
}

async function closeAll(id: string): Promise<void> {
  // The kill switch goes first so no new entry is opened while positions close.
  try {
    await requireFirestore()
      .collection('settings')
      .doc('default')
      .set({ trading: { kill_switch: true } }, { merge: true });
  } catch (err) {
    await finish(id, 'failed', {
      reason: 'kill_switch_not_engaged',
      error: errorMessage(err),
      kill_switch_engaged: false,
    });
    await raiseAlert({
      type: 'close_all_failed',
      subject: id,
      severity: 'critical',
      source: 'autotrader',
      title: 'Close-all refused: kill switch could not be engaged',
      message: `Close-all ${id} did not start because the kill switch write failed: ${errorMessage(err)}. Nothing was closed.`,
      action: 'Close positions manually in MT5 if needed. Fix Firestore access, then retry close-all from the Admin page.',
    });
    return;
  }
  invalidateExecutionControl();
  await notify('warn', 'close_all_started', { command_id: id });

  const control = await getExecutionControl().catch(() => null);
  const results: CloseAllEntry[] = [];
  const trades = await listNonTerminal(results, 1);

  // paper is always included. demo and live only when they have open work or are the current mode.
  const modes: BrokerMode[] = ['paper'];
  const wanted = (m: BrokerMode): boolean => control?.mode === m || trades.some((t) => t.mode === m);
  if (wanted('demo')) modes.push('demo');
  if (wanted('live')) modes.push('live');

  // demo and live may share one MT5 broker instance: group modes by object identity.
  const groups: { modes: BrokerMode[]; broker: BrokerAdapter }[] = [];
  for (const mode of modes) {
    let broker: BrokerAdapter;
    try {
      broker = await getBroker(mode);
    } catch (err) {
      results.push({ mode, kind: 'read', sweep: 1, ok: false, error: `broker_unavailable: ${errorMessage(err)}` });
      continue;
    }
    const group = groups.find((g) => g.broker === broker);
    if (group) group.modes.push(mode);
    else groups.push({ modes: [mode], broker });
  }

  for (const group of groups) {
    await closeOnBroker(group.modes, group.broker, trades, results, 1);
  }

  // Entries that were in flight when the kill switch engaged resolve within the settle window.
  await notify('warn', 'close_all_settling', { command_id: id, settle_ms: settleMs });
  await sleep(settleMs);

  const later = await listNonTerminal(results, 2);
  await markInFlight(later, results);
  for (const group of groups) {
    await closeOnBroker(group.modes, group.broker, later, results, 2);
  }

  // A first-sweep failure that the second sweep clears is recorded but not counted.
  const failed = results.filter((r) => !r.ok && (r.sweep === 2 || r.kind === 'mark')).length;
  const status = failed === 0 ? 'done' : 'failed';
  const usedModes = groups.flatMap((g) => g.modes);
  await finish(id, status, {
    brokers: usedModes,
    results,
    sweeps: 2,
    kill_switch_engaged: true,
  });
  await notify(status === 'done' ? 'info' : 'error', 'close_all_finished', {
    command_id: id,
    status,
    ok_count: results.length - failed,
    failed_count: failed,
  });
  if (status === 'failed') {
    await raiseAlert({
      type: 'close_all_failed',
      subject: id,
      severity: 'critical',
      source: 'autotrader',
      title: 'Close-all left positions or orders open',
      message: `Close-all ${id} finished with ${failed} failure(s) after two sweeps. The kill switch is engaged.`,
      details: { failed_count: failed, brokers: usedModes },
    });
  }
}

/** Trade sets in a non-terminal state. A failed read is recorded and yields []. */
async function listNonTerminal(results: CloseAllEntry[], sweep: 1 | 2): Promise<TradeSetDoc[]> {
  try {
    return await listTradeSetsByState(NON_TERMINAL_STATES);
  } catch (err) {
    results.push({ mode: 'paper', kind: 'read', sweep, ok: false, error: `trade_listing_failed: ${errorMessage(err)}` });
    return [];
  }
}

/**
 * Flags in-flight entries (SUBMITTING, SUBMIT_UNKNOWN) so that the reconciler
 * closes them if they resolve to an open position. A failed flag is a failure.
 */
async function markInFlight(trades: TradeSetDoc[], results: CloseAllEntry[]): Promise<void> {
  for (const trade of trades) {
    if (trade.state !== 'SUBMITTING' && trade.state !== 'SUBMIT_UNKNOWN') continue;
    const mode = trade.mode;
    if (mode !== 'paper' && mode !== 'demo' && mode !== 'live') continue;
    try {
      await updateTradeSet(trade.trade_set_id, { close_requested_by: 'close_all' });
    } catch (err) {
      results.push({
        mode,
        kind: 'mark',
        sweep: 2,
        ok: false,
        error: `mark_failed:${trade.trade_set_id}: ${errorMessage(err)}`,
      });
    }
  }
}

async function closeOnBroker(
  modes: BrokerMode[],
  broker: BrokerAdapter,
  trades: TradeSetDoc[],
  results: CloseAllEntry[],
  sweep: 1 | 2,
): Promise<void> {
  const mode = modes[0];
  let orders: BrokerOrder[];
  let positions: BrokerPosition[];
  try {
    [orders, positions] = await Promise.all([broker.getOrders(), broker.getPositions()]);
  } catch (err) {
    results.push({ mode, kind: 'read', sweep, ok: false, error: errorMessage(err) });
    return;
  }

  const cancelled: number[] = [];
  for (const order of orders) {
    if (order.magic !== broker.magic) continue;
    try {
      const res = await broker.cancelOrder(order.ticket);
      cancelled.push(order.ticket);
      results.push({ mode, ticket: order.ticket, kind: 'order', sweep, ok: true, retcode: res.retcode });
    } catch (err) {
      results.push({ mode, ticket: order.ticket, kind: 'order', sweep, ok: false, ...outcomeOf(err) });
    }
  }

  // Positions whose close was sent (or may have happened) are marked for the lifecycle.
  const targeted: number[] = [];
  for (const pos of positions) {
    if (pos.magic !== broker.magic) continue;
    try {
      const res = await broker.closePosition(pos.ticket);
      targeted.push(pos.ticket);
      results.push({ mode, ticket: pos.ticket, kind: 'position', sweep, ok: true, retcode: res.retcode });
    } catch (err) {
      const outcome = outcomeOf(err);
      if (outcome.error === 'ambiguous') targeted.push(pos.ticket);
      results.push({ mode, ticket: pos.ticket, kind: 'position', sweep, ok: false, ...outcome });
    }
  }

  await markTradeSets(modes, trades, cancelled, targeted);
}

async function markTradeSets(
  modes: BrokerMode[],
  trades: TradeSetDoc[],
  cancelledOrders: number[],
  targetedPositions: number[],
): Promise<void> {
  for (const trade of trades) {
    if (!modes.includes(trade.mode as BrokerMode) || !trade.broker_refs) continue;
    const refs = trade.broker_refs;
    try {
      if (targetedPositions.includes(refs.position_ticket)) {
        await updateTradeSet(trade.trade_set_id, { close_requested_by: 'close_all' });
      }
      if (cancelledOrders.includes(refs.order_ticket) && trade.state === 'PENDING_ORDER') {
        const moved = await transitionTradeSet(trade.trade_set_id, ['PENDING_ORDER'], { state: 'CANCELLED' });
        if (moved) {
          await recordTradeEvent({
            tradeSetId: trade.trade_set_id,
            eventKey: 'pending_order_cancelled',
            type: 'pending_order_cancelled',
            mode: trade.mode,
            profileDocId: trade.profile?.doc_id ?? null,
            profileVersion: trade.profile?.version ?? null,
            orderTicket: refs.order_ticket,
            reasonCode: 'close_all',
          });
        }
      }
    } catch (err) {
      logger.warn('close_all_mark_failed', { trade_set_id: trade.trade_set_id, error: errorMessage(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export function startAdminCommandPoller(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (running) return;
  running = true;

  logger.info('admin_command_poller_started', { intervalMs });
  void writeSystemLog('info', 'admin', 'admin_command_poller_started', { intervalMs });

  const loop = (): void => {
    if (!running) return;
    void runAdminCommands()
      .catch((err: unknown) => {
        logger.warn('admin_command_poller_crashed', { error: errorMessage(err) });
      })
      .finally(() => {
        if (running) timer = setTimeout(loop, intervalMs);
      });
  };

  timer = setTimeout(loop, intervalMs);
}

export function stopAdminCommandPoller(): void {
  running = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  logger.info('admin_command_poller_stopped');
  void writeSystemLog('info', 'admin', 'admin_command_poller_stopped');
}

export function isAdminCommandPollerRunning(): boolean {
  return running;
}
