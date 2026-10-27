/**
 * lifecycleManager.ts
 *
 * Protective management of trade sets in OPEN, PARTIALLY_CLOSED and
 * PENDING_ORDER (contracts §7). Each tick:
 *   1. lists active schema-2 trade sets, groups them by mode, and reads one
 *      positions/orders snapshot per broker (paper: evaluate() first);
 *   2. resolves closed positions and pending orders from broker deals;
 *   3. runs TP checkpoints in order, at most one broker close per trade per
 *      tick, persisting intent before every close request;
 *   4. applies the most protective stop-loss candidate from the frozen
 *      profile snapshot.
 * Ownership is strict: only a position with the broker's magic and the trade's
 * recorded ticket is touched. A failed broker read changes no state. The kill
 * switch and mode 'disabled' do not stop this loop.
 */

import { raiseAlert, resolveAlert } from './alerts';
import { getBroker, type BrokerMode } from './brokerRouter';
import {
  BrokerRejectedError,
  type BrokerAdapter,
  type BrokerOrder,
  type BrokerPosition,
  type CloseResult,
  type SymbolInfo,
} from './brokerTypes';
import { logger } from './logger';
import {
  breakEvenTriggered,
  checkpointAction,
  classifyCloseReason,
  closeVolumeFor,
  desiredStopLoss,
  isStopModificationValid,
  lastExitDeal,
  fillCheckpoints,
  realizedPnlFromDeals,
  trailingActivated,
  updateBestPrice,
  type LifecycleView,
  type StopReason,
} from './lifecycleRules';
import { volumeDecimals } from './positionSizing';
import { writeSystemLog } from './systemLog';
import { recordTradeEvent } from './tradeEvents';
import type { TradeEventInput } from './tradeSetTypes';
import { listTradeSetsByState, transitionTradeSet, updateTradeSet } from './tradeSetStore';
import type {
  CheckpointState,
  TradeLifecycle,
  TradeResult,
  TradeSetDoc,
  TradeState,
} from './tradeSetTypes';

const ACTIVE_STATES: readonly TradeState[] = ['OPEN', 'PARTIALLY_CLOSED', 'PENDING_ORDER'];
const MAX_CLOSE_ATTEMPTS = 5;
const AMBIGUOUS_WINDOW_SEC = 15;
const LOOKBACK_SEC = 60;
const DEFAULT_INTERVAL_MS = 2000;
const PRICE_EPS = 1e-9;
const SL_FAILURES_BEFORE_ALERT = 3;
/** TRADE_RETCODE_MARKET_CLOSED (and the simulator's no-quote refusal). */
const RETCODE_MARKET_CLOSED = 10018;
const MARKET_CLOSED_RETRY_SEC = 60;
/** A pending entry still working this long after pending_expires_at is cancelled by the worker. */
const PENDING_EXPIRY_GRACE_SEC = 30;

export interface TickSummary {
  tradeSets: number;
  checked: number;
  skippedModes: string[];
  partialCloses: number;
  partialCloseRejected: number;
  closeAmbiguous: number;
  slModified: number;
  closed: number;
  pendingFilled: number;
  pendingCancelled: number;
  errors: number;
}

interface ModeSnapshot {
  broker: BrokerAdapter;
  positions: BrokerPosition[];
  orders: BrokerOrder[];
  symbols: Map<string, SymbolInfo | Error>;
}

/** A trade's lifecycle being updated during one tick. `savedJson` tracks what Firestore holds. */
interface Progress {
  trade: TradeSetDoc;
  lc: TradeLifecycle;
  savedJson: string;
}

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const warned = new Set<string>();
const modeDown = new Set<BrokerMode>();

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function isoNow(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function lookbackFrom(trade: TradeSetDoc): number {
  const ms = Date.parse(trade.created_at);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) - LOOKBACK_SEC : 0;
}

function isManagedMode(mode: string): mode is BrokerMode {
  return mode === 'paper' || mode === 'demo' || mode === 'live';
}

function hasEvaluate(broker: BrokerAdapter): broker is BrokerAdapter & { evaluate(): Promise<unknown> } {
  return typeof (broker as { evaluate?: unknown }).evaluate === 'function';
}

function warnOnce(key: string, event: string, payload: Record<string, unknown>): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(event, payload);
}

async function notify(level: 'info' | 'warn' | 'error', event: string, details: Record<string, unknown>): Promise<void> {
  logger[level](event, details);
  await writeSystemLog(level, 'lifecycle', event, details);
}

async function emit(
  trade: TradeSetDoc,
  e: Omit<TradeEventInput, 'tradeSetId' | 'mode' | 'profileDocId' | 'profileVersion'>,
): Promise<boolean> {
  return recordTradeEvent({
    tradeSetId: trade.trade_set_id,
    mode: trade.mode,
    profileDocId: trade.profile?.doc_id ?? null,
    profileVersion: trade.profile?.version ?? null,
    ...e,
  });
}

function emptySummary(): TickSummary {
  return {
    tradeSets: 0,
    checked: 0,
    skippedModes: [],
    partialCloses: 0,
    partialCloseRejected: 0,
    closeAmbiguous: 0,
    slModified: 0,
    closed: 0,
    pendingFilled: 0,
    pendingCancelled: 0,
    errors: 0,
  };
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function progressFor(trade: TradeSetDoc): Progress {
  if (!trade.lifecycle) throw new Error('missing_lifecycle');
  const lc = clone(trade.lifecycle);
  return { trade, lc, savedJson: JSON.stringify(lc) };
}

/**
 * Writes the lifecycle. OPEN moves to PARTIALLY_CLOSED once a checkpoint is done
 * and volume remains; the transition is a CAS on state, so a concurrent change
 * wins and only the lifecycle is written.
 */
async function saveProgress(p: Progress): Promise<void> {
  const { trade, lc } = p;
  if (trade.state === 'OPEN' && lc.current_volume > 0 && lc.checkpoints.some((c) => c.status === 'done')) {
    const moved = await transitionTradeSet(trade.trade_set_id, ['OPEN'], {
      state: 'PARTIALLY_CLOSED',
      lifecycle: lc,
    });
    if (moved) {
      trade.state = 'PARTIALLY_CLOSED';
      trade.lifecycle = lc;
      p.savedJson = JSON.stringify(lc);
      return;
    }
  }
  await updateTradeSet(trade.trade_set_id, { lifecycle: lc });
  trade.lifecycle = lc;
  p.savedJson = JSON.stringify(lc);
}

async function flushProgress(p: Progress): Promise<void> {
  if (JSON.stringify(p.lc) !== p.savedJson) await saveProgress(p);
}

// ---------------------------------------------------------------------------
// Broker reads
// ---------------------------------------------------------------------------

async function readBroker(mode: BrokerMode, group: TradeSetDoc[]): Promise<ModeSnapshot> {
  const broker = await getBroker(mode);
  if (hasEvaluate(broker)) {
    try {
      await broker.evaluate();
    } catch (err) {
      logger.warn('lifecycle_evaluate_failed', { mode, error: errorMessage(err) });
    }
  }
  const [positions, orders] = await Promise.all([broker.getPositions(), broker.getOrders()]);
  const symbols = new Map<string, SymbolInfo | Error>();
  const names = new Set(group.map((t) => t.broker_symbol).filter((s): s is string => !!s));
  for (const symbol of names) {
    try {
      symbols.set(symbol, await broker.getSymbolInfo(symbol));
    } catch (err) {
      symbols.set(symbol, err instanceof Error ? err : new Error(String(err)));
    }
  }
  return { broker, positions, orders, symbols };
}

function symbolInfoFor(snap: ModeSnapshot, trade: TradeSetDoc): SymbolInfo {
  if (!trade.broker_symbol) throw new Error('missing_broker_symbol');
  const info = snap.symbols.get(trade.broker_symbol);
  if (!info) throw new Error(`symbol_not_read:${trade.broker_symbol}`);
  if (info instanceof Error) throw info;
  return info;
}

/** Realized money of one close deal, or undefined when the deal cannot be read. */
async function closeDealPnl(
  broker: BrokerAdapter,
  trade: TradeSetDoc,
  positionTicket: number,
  dealTicket: number,
): Promise<number | undefined> {
  try {
    const deals = await broker.getDeals({ fromSec: lookbackFrom(trade), positionId: positionTicket });
    const deal = deals.find((d) => d.ticket === dealTicket);
    return deal ? realizedPnlFromDeals([deal]) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Per-trade processing
// ---------------------------------------------------------------------------

async function tickMode(mode: BrokerMode, group: TradeSetDoc[], summary: TickSummary): Promise<void> {
  let snap: ModeSnapshot;
  try {
    snap = await readBroker(mode, group);
  } catch (err) {
    summary.skippedModes.push(mode);
    if (!modeDown.has(mode)) {
      modeDown.add(mode);
      await notify('warn', 'lifecycle_mode_skipped', { mode, error: errorMessage(err), trade_sets: group.length });
    }
    return;
  }
  if (modeDown.delete(mode)) await notify('info', 'lifecycle_mode_recovered', { mode });

  for (const trade of group) {
    summary.checked++;
    try {
      await processTrade(snap, trade, summary);
    } catch (err) {
      summary.errors++;
      await recordTradeError(trade, err);
    }
  }
}

async function recordTradeError(trade: TradeSetDoc, err: unknown): Promise<void> {
  const message = errorMessage(err);
  logger.warn('lifecycle_trade_failed', { trade_set_id: trade.trade_set_id, error: message });
  const minute = Math.floor(Date.now() / 60000);
  const recorded = await emit(trade, {
    eventKey: `lifecycle_error_${minute}`,
    type: 'execution_error',
    reasonCode: 'lifecycle_error',
    message,
  });
  if (recorded) {
    await writeSystemLog('warn', 'lifecycle', 'lifecycle_trade_failed', {
      trade_set_id: trade.trade_set_id,
      error: message,
    });
  }
}

async function processTrade(snap: ModeSnapshot, trade: TradeSetDoc, summary: TickSummary): Promise<void> {
  if (trade.state === 'PENDING_ORDER') return managePending(snap, trade, summary);
  return manageOpen(snap, trade, summary);
}

async function manageOpen(snap: ModeSnapshot, trade: TradeSetDoc, summary: TickSummary): Promise<void> {
  const ref = trade.broker_refs;
  if (!ref || !(ref.position_ticket > 0)) throw new Error('missing_position_ref');
  if (!trade.profile_snapshot) throw new Error('missing_profile_snapshot');

  const p = progressFor(trade);
  const pos = snap.positions.find((x) => x.ticket === ref.position_ticket && x.magic === snap.broker.magic);
  if (!pos) return resolveMissingPosition(snap, p, summary);

  const sym = symbolInfoFor(snap, trade);
  const now = nowSec();
  let closeAttempted = false;
  for (const cp of [...p.lc.checkpoints].sort((a, b) => a.tp_index - b.tp_index)) {
    const action = checkpointAction(cp, pos.volume, pos.priceCurrent, trade.direction, now, sym.volumeStep);
    if (action === 'mark_done') {
      await markCheckpointDone(p, cp, pos.volume, pos.ticket);
      continue;
    }
    if (action === 'send_close') {
      // After a market-closed refusal the close is retried once a minute, not every tick.
      if ((marketClosedUntil.get(`${trade.trade_set_id}:${cp.tp_index}`) ?? 0) > now) break;
      await requestCheckpointClose(snap, p, cp, pos, sym.volumeStep, summary, now);
      closeAttempted = true;
      break;
    }
  }

  // The position snapshot is stale after a close; stop management waits for the next tick.
  if (!closeAttempted) await manageStops(snap, p, pos, sym, summary);
  await flushProgress(p);
}

async function markCheckpointDone(p: Progress, cp: CheckpointState, volume: number, positionTicket: number): Promise<void> {
  cp.status = 'done';
  cp.confirmed_at = isoNow();
  delete cp.ambiguous_until;
  p.lc.current_volume = volume;
  await saveProgress(p);
  await emit(p.trade, {
    eventKey: `tp${cp.tp_index}_partial_close_confirmed`,
    type: 'partial_close_confirmed',
    positionTicket,
    volume,
    reasonCode: 'volume_reached_target',
    details: { tp_index: cp.tp_index, target_remaining_volume: cp.target_remaining_volume },
  });
  await notify('info', 'lifecycle_checkpoint_confirmed', {
    trade_set_id: p.trade.trade_set_id,
    tp_index: cp.tp_index,
    position_volume: volume,
  });
}

/**
 * Sends one checkpoint close. The 'closing' intent is persisted first; if that
 * write fails, nothing is sent. Only a BrokerRejectedError is a definite refusal.
 * Any other failure leaves the checkpoint 'closing' until its window expires, and
 * the next volume check decides whether the close happened.
 */
async function requestCheckpointClose(
  snap: ModeSnapshot,
  p: Progress,
  cp: CheckpointState,
  pos: BrokerPosition,
  step: number,
  summary: TickSummary,
  now: number,
): Promise<void> {
  const { trade } = p;
  const n = cp.tp_index;
  const attempt = cp.attempts + 1;
  const { volume, full } = closeVolumeFor(pos.volume, cp.target_remaining_volume, step);
  if (!(volume > 0)) throw new Error(`checkpoint_close_volume_zero:tp${n}`);

  cp.status = 'closing';
  cp.attempts = attempt;
  cp.requested_at = isoNow();
  cp.ambiguous_until = now + AMBIGUOUS_WINDOW_SEC;
  await saveProgress(p);

  await emit(trade, {
    eventKey: `tp${n}_reached`,
    type: 'tp_checkpoint_reached',
    positionTicket: pos.ticket,
    price: cp.price,
    details: { tp_index: n, market_price: pos.priceCurrent },
  });
  await emit(trade, {
    eventKey: `tp${n}_partial_close_requested_${attempt}`,
    type: 'partial_close_requested',
    positionTicket: pos.ticket,
    volume,
    price: pos.priceCurrent,
    reasonCode: full ? 'final_full_close' : 'checkpoint_partial_close',
    details: { tp_index: n, attempt, full, target_remaining_volume: cp.target_remaining_volume },
  });
  await notify('info', 'lifecycle_partial_close_requested', {
    trade_set_id: trade.trade_set_id,
    tp_index: n,
    attempt,
    volume,
    full,
  });

  let result: CloseResult;
  try {
    result = await snap.broker.closePosition(pos.ticket, full ? undefined : volume);
  } catch (err) {
    await handleCloseFailure(p, cp, pos, volume, attempt, err, summary);
    return;
  }

  const pnl = await closeDealPnl(snap.broker, trade, pos.ticket, result.dealTicket);
  cp.status = 'done';
  cp.confirmed_at = isoNow();
  cp.deal_ticket = result.dealTicket;
  if (pnl !== undefined) cp.realized_pnl = pnl;
  delete cp.ambiguous_until;
  delete cp.last_error;
  p.lc.current_volume = Math.max(0, Number((pos.volume - result.closedVolume).toFixed(volumeDecimals(step))));
  await saveProgress(p);

  summary.partialCloses++;
  await emit(trade, {
    eventKey: `tp${n}_partial_close_confirmed`,
    type: 'partial_close_confirmed',
    positionTicket: pos.ticket,
    dealTicket: result.dealTicket,
    volume: result.closedVolume,
    price: result.price,
    realizedPnl: pnl,
    retcode: result.retcode,
    details: { tp_index: n, remaining_volume: p.lc.current_volume },
  });
  await notify('info', 'lifecycle_partial_close_confirmed', {
    trade_set_id: trade.trade_set_id,
    tp_index: n,
    deal_ticket: result.dealTicket,
    closed_volume: result.closedVolume,
    remaining_volume: p.lc.current_volume,
  });
}

async function handleCloseFailure(
  p: Progress,
  cp: CheckpointState,
  pos: BrokerPosition,
  volume: number,
  attempt: number,
  err: unknown,
  summary: TickSummary,
): Promise<void> {
  const { trade } = p;
  const n = cp.tp_index;
  const message = errorMessage(err);

  if (err instanceof BrokerRejectedError && err.retcode === RETCODE_MARKET_CLOSED) {
    // Market closed (session break, weekend): not the close's fault, so the attempt is not counted.
    cp.status = 'pending';
    cp.attempts = Math.max(0, attempt - 1);
    cp.last_error = message;
    delete cp.ambiguous_until;
    await saveProgress(p);
    marketClosedUntil.set(`${trade.trade_set_id}:${n}`, nowSec() + MARKET_CLOSED_RETRY_SEC);
    warnOnce(`market_closed:${trade.trade_set_id}:${n}`, 'lifecycle_partial_close_market_closed', {
      trade_set_id: trade.trade_set_id,
      tp_index: n,
      error: message,
    });
    return;
  }

  if (err instanceof BrokerRejectedError) {
    cp.status = attempt >= MAX_CLOSE_ATTEMPTS ? 'failed' : 'pending';
    cp.last_error = message;
    delete cp.ambiguous_until;
    await saveProgress(p);
    summary.partialCloseRejected++;
    await emit(trade, {
      eventKey: `tp${n}_partial_close_failed_${attempt}`,
      type: 'partial_close_failed',
      positionTicket: pos.ticket,
      volume,
      retcode: err.retcode,
      reasonCode: cp.status === 'failed' ? 'attempts_exhausted' : 'broker_rejected',
      message,
    });
    if (cp.status === 'failed') {
      await notify('error', 'lifecycle_partial_close_failed', {
        trade_set_id: trade.trade_set_id,
        tp_index: n,
        attempts: attempt,
        retcode: err.retcode,
        error: message,
      });
      await raiseAlert({
        type: 'partial_close_failed',
        subject: `${trade.trade_set_id}_tp${n}`,
        severity: 'error',
        source: 'autotrader',
        title: `TP${n} partial close failed`,
        message: `Closing ${volume} lots of position ${pos.ticket} (${trade.trade_set_id}) at TP${n} was rejected ${attempt} times (retcode ${err.retcode}): ${message}. The checkpoint is marked failed and not retried.`,
        details: { trade_set_id: trade.trade_set_id, tp_index: n, position_ticket: pos.ticket, volume, retcode: err.retcode },
      });
    } else {
      await notify('warn', 'lifecycle_partial_close_rejected', {
        trade_set_id: trade.trade_set_id,
        tp_index: n,
        attempt,
        retcode: err.retcode,
        error: message,
      });
    }
    return;
  }

  summary.closeAmbiguous++;
  cp.last_error = message;
  await saveProgress(p);
  await emit(trade, {
    eventKey: `tp${n}_partial_close_ambiguous_${attempt}`,
    type: 'execution_error',
    positionTicket: pos.ticket,
    volume,
    reasonCode: 'partial_close_ambiguous',
    message,
  });
  await notify('warn', 'lifecycle_partial_close_ambiguous', {
    trade_set_id: trade.trade_set_id,
    tp_index: n,
    attempt,
    error: message,
  });
}

/**
 * Position not found under this broker's magic and the recorded ticket. Only a
 * successful read that shows exit deals for that position closes the trade. No
 * exit deal means the record cannot be explained, so it is left alone.
 */
async function resolveMissingPosition(snap: ModeSnapshot, p: Progress, summary: TickSummary): Promise<void> {
  const { trade, lc } = p;
  const ref = trade.broker_refs;
  if (!ref) throw new Error('missing_position_ref');

  const deals = (
    await snap.broker.getDeals({ fromSec: lookbackFrom(trade), positionId: ref.position_ticket })
  ).filter((d) => d.positionId === ref.position_ticket);
  const last = lastExitDeal(deals);
  if (!last) {
    warnOnce(`no_exit:${trade.trade_set_id}`, 'lifecycle_position_missing_no_exit_deal', {
      trade_set_id: trade.trade_set_id,
      position_ticket: ref.position_ticket,
    });
    return;
  }

  // A TP exit reached the final checkpoint's price. A final close still marked
  // 'closing' that ends as our own deal also completed it.
  for (const cp of lc.checkpoints) {
    if (cp.target_remaining_volume !== 0 || cp.status === 'done') continue;
    if (last.reason === 'TP' || (last.reason === 'CLIENT' && cp.status === 'closing')) {
      cp.status = 'done';
      cp.confirmed_at = isoNow();
      cp.deal_ticket = last.ticket;
      delete cp.ambiguous_until;
    }
  }

  const allDone = lc.checkpoints.length > 0 && lc.checkpoints.every((c) => c.status === 'done');
  const closeReason: TradeResult['close_reason'] =
    trade.close_requested_by === 'close_all' ? 'close_all' : allDone ? 'checkpoints_complete' : classifyCloseReason(deals);
  const realized = realizedPnlFromDeals(deals);
  lc.current_volume = 0;

  const moved = await transitionTradeSet(trade.trade_set_id, ['OPEN', 'PARTIALLY_CLOSED'], {
    state: 'CLOSED',
    lifecycle: lc,
    result: { closed_at: isoNow(), close_reason: closeReason, realized_pnl: realized },
  });
  if (!moved) return;

  trade.state = 'CLOSED';
  summary.closed++;
  await emit(trade, {
    eventKey: 'position_closed',
    type: 'position_closed',
    positionTicket: ref.position_ticket,
    dealTicket: last.ticket,
    price: last.price,
    realizedPnl: realized,
    reasonCode: closeReason,
  });
  await notify('info', 'lifecycle_position_closed', {
    trade_set_id: trade.trade_set_id,
    position_ticket: ref.position_ticket,
    close_reason: closeReason,
    realized_pnl: realized,
  });
}

/** Consecutive failed stop moves per trade set; SL_FAILURES_BEFORE_ALERT in a row raise sl_modify_failed. */
const slFailures = new Map<string, number>();
/** `${tradeSetId}:${tpIndex}` → epoch sec before which a market-closed checkpoint close is not retried. */
const marketClosedUntil = new Map<string, number>();

async function noteSlFailure(trade: TradeSetDoc, pos: BrokerPosition, sl: number, kind: string, error: string): Promise<void> {
  const streak = (slFailures.get(trade.trade_set_id) ?? 0) + 1;
  slFailures.set(trade.trade_set_id, streak);
  if (streak < SL_FAILURES_BEFORE_ALERT) return;
  await raiseAlert({
    type: 'sl_modify_failed',
    subject: trade.trade_set_id,
    severity: 'error',
    source: 'autotrader',
    title: 'Stop-loss move keeps failing',
    message: `Moving the stop of position ${pos.ticket} (${trade.trade_set_id}) to ${sl} failed ${streak} times in a row (${kind}): ${error}. The current broker stop is ${pos.sl}.`,
    details: { trade_set_id: trade.trade_set_id, position_ticket: pos.ticket, target_sl: sl, current_sl: pos.sl, kind },
  });
}

async function noteSlSuccess(trade: TradeSetDoc): Promise<void> {
  if (!slFailures.has(trade.trade_set_id)) return;
  slFailures.delete(trade.trade_set_id);
  await resolveAlert('sl_modify_failed', trade.trade_set_id, 'stop_moved');
}

async function manageStops(
  snap: ModeSnapshot,
  p: Progress,
  pos: BrokerPosition,
  sym: SymbolInfo,
  summary: TickSummary,
): Promise<void> {
  const { trade, lc } = p;
  const profile = trade.profile_snapshot;
  if (!profile) throw new Error('missing_profile_snapshot');
  const ref = trade.broker_refs;
  if (!ref) throw new Error('missing_position_ref');
  const entry = ref.fill_price > 0 ? ref.fill_price : (trade.plan?.entry_ref_price ?? 0);
  if (!(entry > 0)) throw new Error('missing_entry_reference');

  const buy = trade.direction === 'buy';
  const view: LifecycleView = { direction: trade.direction, entry, closePrice: pos.priceCurrent, checkpoints: lc.checkpoints };
  const storedBest = lc.best_price > 0 ? lc.best_price : entry;
  const best = updateBestPrice(trade.direction, storedBest, pos.priceCurrent);
  const decision = desiredStopLoss({
    ...view,
    profile,
    currentSl: pos.sl,
    bestPrice: best,
    beApplied: lc.be_applied,
    trailingActive: lc.trailing_active,
    digits: sym.digits,
  });

  // Best price is persisted only when it moves by at least the trailing step.
  if (profile.trailing.enabled && best !== storedBest && Math.abs(best - storedBest) >= profile.trailing.step_price) {
    lc.best_price = best;
  }
  if (trailingActivated(view, profile)) lc.trailing_active = true;

  let effectiveSl = pos.sl;
  if (decision) {
    const valid = isStopModificationValid(
      trade.direction,
      decision.sl,
      sym.bid,
      sym.ask,
      sym.stopsLevelPoints,
      sym.freezeLevelPoints,
      sym.point,
    );
    if (!valid) {
      warnOnce(`stop_invalid:${trade.trade_set_id}:${decision.sl}`, 'lifecycle_stop_invalid_for_market', {
        trade_set_id: trade.trade_set_id,
        sl: decision.sl,
        bid: sym.bid,
        ask: sym.ask,
      });
    } else {
      let applied = false;
      try {
        await snap.broker.modifyPosition(pos.ticket, decision.sl, pos.tp);
        applied = true;
      } catch (err) {
        // Rejected: the stop is unchanged and the next tick decides again. Ambiguous: the next tick re-reads position.sl.
        const kind = err instanceof BrokerRejectedError ? 'rejected' : 'unconfirmed';
        warnOnce(`sl_${kind}:${trade.trade_set_id}:${decision.sl}`, 'lifecycle_sl_modify_failed', {
          trade_set_id: trade.trade_set_id,
          sl: decision.sl,
          kind,
          error: errorMessage(err),
        });
        if (!(err instanceof BrokerRejectedError && err.retcode === RETCODE_MARKET_CLOSED)) {
          await noteSlFailure(trade, pos, decision.sl, kind, errorMessage(err));
        }
      }
      if (applied) {
        await noteSlSuccess(trade);
        effectiveSl = decision.sl;
        lc.current_sl = decision.sl;
        lc.current_tp = pos.tp;
        if (decision.reasons.includes('break_even')) lc.be_applied = true;
        if (decision.reasons.includes('trailing')) lc.trailing_active = true;
        await saveProgress(p);
        summary.slModified++;
        await recordSlModification(trade, pos, decision.sl, decision.reasons, sym.digits);
      }
    }
  }

  // Break-even counts as applied once the stop sits at or beyond the break-even level.
  if (breakEvenTriggered(view, profile)) {
    const beLevel = buy ? entry + profile.break_even.buffer_price : entry - profile.break_even.buffer_price;
    const atBe = effectiveSl > 0 && (buy ? effectiveSl >= beLevel - PRICE_EPS : effectiveSl <= beLevel + PRICE_EPS);
    if (atBe) lc.be_applied = true;
  }
}

async function recordSlModification(
  trade: TradeSetDoc,
  pos: BrokerPosition,
  sl: number,
  reasons: StopReason[],
  digits: number,
): Promise<void> {
  const slKey = sl.toFixed(digits);
  await emit(trade, {
    eventKey: `sl_modified_${slKey}`,
    type: 'sl_modified',
    positionTicket: pos.ticket,
    sl,
    tp: pos.tp,
    price: pos.priceCurrent,
    reasonCode: reasons.join('+'),
    details: { reasons },
  });
  if (reasons.includes('break_even')) {
    await emit(trade, {
      eventKey: 'break_even_applied',
      type: 'break_even_applied',
      positionTicket: pos.ticket,
      sl,
      price: pos.priceCurrent,
    });
  }
  if (reasons.includes('trailing')) {
    await emit(trade, {
      eventKey: `trailing_updated_${slKey}`,
      type: 'trailing_updated',
      positionTicket: pos.ticket,
      sl,
      tp: pos.tp,
      price: pos.priceCurrent,
    });
  }
  await notify('info', 'lifecycle_sl_modified', {
    trade_set_id: trade.trade_set_id,
    position_ticket: pos.ticket,
    sl,
    reasons,
  });
}

/**
 * Pending order: still resting means nothing to do (the broker expires it).
 * Gone with a position carrying the trade's comment means filled. Gone with
 * neither means cancelled, unless deals show it filled and already closed.
 */
/**
 * A pending entry still resting after its planned expiry is cancelled. This
 * covers a broker that did not accept ORDER_TIME_SPECIFIED (the order became
 * good-till-cancelled) and any late broker-side expiry. Cancelling only reduces
 * exposure, so it runs regardless of the kill switch. A failed or ambiguous
 * cancel is retried on a later tick; the next read decides.
 */
async function cancelIfExpired(snap: ModeSnapshot, trade: TradeSetDoc, ticket: number): Promise<void> {
  const expiresAt = trade.submission?.pending_expires_at;
  if (!expiresAt || nowSec() <= expiresAt + PENDING_EXPIRY_GRACE_SEC) return;
  try {
    await snap.broker.cancelOrder(ticket);
  } catch (err) {
    warnOnce(`pending_expiry_cancel:${trade.trade_set_id}`, 'lifecycle_pending_expiry_cancel_failed', {
      trade_set_id: trade.trade_set_id,
      order_ticket: ticket,
      error: errorMessage(err),
    });
    return;
  }
  await emit(trade, {
    eventKey: 'pending_order_expired_by_worker',
    type: 'pending_order_cancelled',
    orderTicket: ticket,
    reasonCode: 'expired',
    message: `pending order still working ${PENDING_EXPIRY_GRACE_SEC}s after its expiry; cancelled by the worker`,
    details: { pending_expires_at: expiresAt, expiration_applied: trade.broker_refs?.expiration_applied ?? null },
  });
  await notify('warn', 'lifecycle_pending_expired_cancelled', { trade_set_id: trade.trade_set_id, order_ticket: ticket });
}

async function managePending(snap: ModeSnapshot, trade: TradeSetDoc, summary: TickSummary): Promise<void> {
  const ref = trade.broker_refs;
  if (!ref || !(ref.order_ticket > 0)) throw new Error('missing_order_ref');
  if (!trade.lifecycle) throw new Error('missing_lifecycle');

  const order = snap.orders.find((o) => o.ticket === ref.order_ticket && o.magic === snap.broker.magic);
  if (order) {
    await cancelIfExpired(snap, trade, order.ticket);
    return;
  }

  const pos = snap.positions.find((x) => x.magic === snap.broker.magic && x.comment === trade.correlation_comment);
  if (pos) {
    const deals = await snap.broker.getDeals({ fromSec: lookbackFrom(trade), positionId: pos.ticket }).catch(() => []);
    const entryDeal = deals.find((d) => d.entry === 'IN' && d.positionId === pos.ticket);
    const fillPrice = entryDeal?.price ?? pos.openPrice;
    const lc = clone(trade.lifecycle);
    lc.current_volume = pos.volume;
    const sym = symbolInfoFor(snap, trade);
    const fitted = trade.profile_snapshot
      ? fillCheckpoints({
          plannedVolume: trade.plan?.volume,
          direction: trade.direction,
          entryPrice: fillPrice,
          filledVolume: pos.volume,
          profile: trade.profile_snapshot,
          spec: sym,
          checkpoints: lc.checkpoints,
        })
      : lc.checkpoints;
    const replanFailed = fitted === null;
    if (fitted) lc.checkpoints = fitted;
    const moved = await transitionTradeSet(trade.trade_set_id, ['PENDING_ORDER'], {
      state: 'OPEN',
      broker_refs: {
        order_ticket: ref.order_ticket,
        position_ticket: pos.ticket,
        deal_ticket: entryDeal?.ticket ?? 0,
        fill_price: fillPrice,
        filled_volume: pos.volume,
      },
      lifecycle: lc,
    });
    if (!moved) return;
    trade.state = 'OPEN';
    trade.lifecycle = lc;
    summary.pendingFilled++;
    if (replanFailed) {
      await emit(trade, {
        eventKey: 'partial_fill_replan_infeasible',
        type: 'execution_error',
        positionTicket: pos.ticket,
        volume: pos.volume,
        reasonCode: 'partial_fill_replan_infeasible',
        message: 'filled volume cannot be split into feasible checkpoints; original checkpoints kept',
      });
    }
    await emit(trade, {
      eventKey: 'pending_order_filled',
      type: 'pending_order_filled',
      orderTicket: ref.order_ticket,
      positionTicket: pos.ticket,
      dealTicket: entryDeal?.ticket,
      volume: pos.volume,
      price: entryDeal?.price ?? pos.openPrice,
    });
    await emit(trade, {
      eventKey: 'entry_confirmed',
      type: 'entry_confirmed',
      orderTicket: ref.order_ticket,
      positionTicket: pos.ticket,
      dealTicket: entryDeal?.ticket,
      volume: pos.volume,
      price: entryDeal?.price ?? pos.openPrice,
    });
    await notify('info', 'lifecycle_pending_filled', {
      trade_set_id: trade.trade_set_id,
      order_ticket: ref.order_ticket,
      position_ticket: pos.ticket,
    });
    return;
  }

  const deals = await snap.broker.getDeals({ fromSec: lookbackFrom(trade) });
  const entryDeal = deals.find((d) => d.entry === 'IN' && d.comment === trade.correlation_comment);
  if (entryDeal) {
    const exits = deals.filter((d) => d.positionId === entryDeal.positionId);
    const last = lastExitDeal(exits);
    if (!last) {
      warnOnce(`filled_no_exit:${trade.trade_set_id}`, 'lifecycle_pending_filled_no_exit_deal', {
        trade_set_id: trade.trade_set_id,
        position_id: entryDeal.positionId,
      });
      return;
    }
    const realized = realizedPnlFromDeals(exits);
    const closeReason = classifyCloseReason(exits);
    const moved = await transitionTradeSet(trade.trade_set_id, ['PENDING_ORDER'], {
      state: 'CLOSED',
      broker_refs: {
        order_ticket: ref.order_ticket,
        position_ticket: entryDeal.positionId,
        deal_ticket: entryDeal.ticket,
        fill_price: entryDeal.price,
        filled_volume: entryDeal.volume,
      },
      result: { closed_at: isoNow(), close_reason: closeReason, realized_pnl: realized },
    });
    if (!moved) return;
    trade.state = 'CLOSED';
    summary.closed++;
    await emit(trade, {
      eventKey: 'pending_order_filled',
      type: 'pending_order_filled',
      orderTicket: ref.order_ticket,
      positionTicket: entryDeal.positionId,
      dealTicket: entryDeal.ticket,
      price: entryDeal.price,
    });
    await emit(trade, {
      eventKey: 'position_closed',
      type: 'position_closed',
      positionTicket: entryDeal.positionId,
      dealTicket: last.ticket,
      price: last.price,
      realizedPnl: realized,
      reasonCode: closeReason,
    });
    await notify('info', 'lifecycle_position_closed', {
      trade_set_id: trade.trade_set_id,
      position_ticket: entryDeal.positionId,
      close_reason: closeReason,
      realized_pnl: realized,
    });
    return;
  }

  const moved = await transitionTradeSet(trade.trade_set_id, ['PENDING_ORDER'], { state: 'CANCELLED' });
  if (!moved) return;
  trade.state = 'CANCELLED';
  summary.pendingCancelled++;
  await emit(trade, {
    eventKey: 'pending_order_cancelled',
    type: 'pending_order_cancelled',
    orderTicket: ref.order_ticket,
    reasonCode: 'broker_expired_or_removed',
  });
  await notify('info', 'lifecycle_pending_cancelled', {
    trade_set_id: trade.trade_set_id,
    order_ticket: ref.order_ticket,
    reason: 'broker_expired_or_removed',
  });
}

// ---------------------------------------------------------------------------
// Tick and loop
// ---------------------------------------------------------------------------

/** One lifecycle pass over all active trade sets. Never throws. */
export async function runLifecycleTick(): Promise<TickSummary> {
  const summary = emptySummary();
  let trades: TradeSetDoc[];
  try {
    trades = await listTradeSetsByState(ACTIVE_STATES);
  } catch (err) {
    logger.warn('lifecycle_list_failed', { error: errorMessage(err) });
    return summary;
  }
  summary.tradeSets = trades.length;

  const groups = new Map<BrokerMode, TradeSetDoc[]>();
  for (const trade of trades) {
    if (!isManagedMode(trade.mode)) {
      warnOnce(`mode:${trade.trade_set_id}`, 'lifecycle_unmanaged_mode', {
        trade_set_id: trade.trade_set_id,
        mode: trade.mode,
      });
      continue;
    }
    const list = groups.get(trade.mode) ?? [];
    list.push(trade);
    groups.set(trade.mode, list);
  }

  for (const [mode, group] of groups) {
    await tickMode(mode, group, summary);
  }
  return summary;
}

export function startLifecycleManager(intervalMs = Number(process.env.LIFECYCLE_INTERVAL_MS) || DEFAULT_INTERVAL_MS): void {
  if (running) return;
  running = true;

  logger.info('lifecycle_manager_started', { intervalMs });
  void writeSystemLog('info', 'lifecycle', 'manager_started', { intervalMs });

  const loop = (): void => {
    if (!running) return;
    void runLifecycleTick()
      .catch((err: unknown) => {
        logger.warn('lifecycle_tick_crashed', { error: errorMessage(err) });
      })
      .finally(() => {
        if (running) timer = setTimeout(loop, intervalMs);
      });
  };

  timer = setTimeout(loop, intervalMs);
}

export function stopLifecycleManager(): void {
  running = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  logger.info('lifecycle_manager_stopped');
  void writeSystemLog('info', 'lifecycle', 'manager_stopped');
}

export function isLifecycleManagerRunning(): boolean {
  return running;
}

/** Test seam: clears the once-per-process warning latches and mode-outage state. */
export function _resetLifecycleManagerForTests(): void {
  warned.clear();
  modeDown.clear();
  slFailures.clear();
  marketClosedUntil.clear();
}
