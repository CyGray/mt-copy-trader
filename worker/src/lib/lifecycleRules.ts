/**
 * lifecycleRules.ts
 *
 * Pure decision rules for position lifecycle management (contracts §7):
 * checkpoint actions, close volumes, stop-loss candidates (after-checkpoint,
 * break-even, trailing), stop validity, best-price tracking and close-reason
 * classification. No I/O and no clock: callers pass `nowSec`.
 *
 * All distances and prices are in price units (no pips). Volumes use the
 * integer step arithmetic of positionSizing.ts.
 */

import type { BrokerDeal } from './brokerTypes';
import type { ExecutionProfile } from './executionProfile';
import { planCheckpoints, roundVolumeDown, type SizingSpec } from './positionSizing';
import type { CheckpointState } from './tradeSetTypes';

export type TradeDirection = 'buy' | 'sell';
export type CheckpointAction = 'mark_done' | 'send_close' | 'wait' | 'none';
export type StopReason = 'after_checkpoint' | 'break_even' | 'trailing';
export type CloseReason = 'sl' | 'tp' | 'manual';

const PRICE_EPS = 1e-9;

export function roundPrice(price: number, digits: number): number {
  return Number(price.toFixed(digits));
}

export function isCheckpointReached(direction: TradeDirection, closePrice: number, cpPrice: number): boolean {
  return direction === 'buy' ? closePrice >= cpPrice : closePrice <= cpPrice;
}

/**
 * Decides what one checkpoint needs this tick. A checkpoint whose target
 * remaining volume is already reached is done, whatever its recorded status:
 * the volume is the source of truth, which keeps repeated ticks from closing
 * twice.
 */
export function checkpointAction(
  cp: Pick<CheckpointState, 'status' | 'target_remaining_volume' | 'price' | 'ambiguous_until'>,
  positionVolume: number,
  closePrice: number,
  direction: TradeDirection,
  nowSec: number,
  step: number,
): CheckpointAction {
  if (cp.status === 'done') return 'none';
  if (positionVolume <= cp.target_remaining_volume + step / 2) return 'mark_done';
  if (cp.status === 'failed') return 'none';
  if (cp.status === 'closing' && nowSec <= (cp.ambiguous_until ?? 0)) return 'wait';
  if (!isCheckpointReached(direction, closePrice, cp.price)) return 'none';
  if (cp.status === 'pending' || cp.status === 'closing') return 'send_close';
  return 'none';
}

/** Volume to close so that `targetRemaining` is left. A zero target is a full close. */
export function closeVolumeFor(
  positionVolume: number,
  targetRemaining: number,
  step: number,
): { volume: number; full: boolean } {
  if (targetRemaining <= 0) return { volume: positionVolume, full: true };
  return { volume: roundVolumeDown(positionVolume - targetRemaining, step), full: false };
}

/** Lifecycle facts the stop rules need. `closePrice` is the broker's priceCurrent. */
export interface LifecycleView {
  direction: TradeDirection;
  entry: number;
  closePrice: number;
  checkpoints: Pick<CheckpointState, 'tp_index' | 'status' | 'price'>[];
}

function tpDone(checkpoints: LifecycleView['checkpoints'], tpIndex: number): boolean {
  return checkpoints.some((c) => c.tp_index === tpIndex && c.status === 'done');
}

function distanceReached(view: LifecycleView, distance: number): boolean {
  return view.direction === 'buy'
    ? view.closePrice - view.entry >= distance
    : view.entry - view.closePrice >= distance;
}

/** True when break-even is enabled and its trigger condition holds now. */
export function breakEvenTriggered(view: LifecycleView, profile: ExecutionProfile): boolean {
  const be = profile.break_even;
  if (!be.enabled) return false;
  if (be.trigger === 'price_distance') return distanceReached(view, be.trigger_value);
  return tpDone(view.checkpoints, be.trigger_value);
}

/** True when trailing is enabled and its activation condition holds now. */
export function trailingActivated(view: LifecycleView, profile: ExecutionProfile): boolean {
  const tr = profile.trailing;
  if (!tr.enabled) return false;
  if (tr.activation === 'price_distance') return distanceReached(view, tr.activation_value);
  return tpDone(view.checkpoints, tr.activation_value);
}

export interface FillReplanInput {
  direction: TradeDirection;
  entryPrice: number;
  filledVolume: number;
  profile: ExecutionProfile;
  spec: Pick<SizingSpec, 'volumeMin' | 'volumeStep'>;
  checkpoints: Pick<CheckpointState, 'tp_index' | 'price'>[];
}

/**
 * Checkpoint plan for the volume actually filled. Used when a fill differs from
 * the planned volume (partial fill), so "done" still means "closed". Returns null
 * when the split is infeasible at this size.
 */
export function replanCheckpoints(i: FillReplanInput): CheckpointState[] | null {
  const indices = [
    ...i.profile.take_profit.checkpoints.map((c) => c.tp_index),
    ...i.checkpoints.map((c) => c.tp_index),
  ];
  const takeProfits: number[] = new Array<number>(Math.max(0, ...indices)).fill(Number.NaN);
  for (const c of i.checkpoints) takeProfits[c.tp_index - 1] = c.price;
  const plan = planCheckpoints({
    totalVolume: i.filledVolume,
    direction: i.direction,
    entryPrice: i.entryPrice,
    takeProfits,
    takeProfit: i.profile.take_profit,
    spec: i.spec,
  });
  if (!plan.ok) return null;
  return plan.checkpoints.map((c) => ({
    tp_index: c.tpIndex,
    price: c.price,
    close_volume: c.closeVolume,
    target_remaining_volume: c.targetRemainingVolume,
    status: 'pending',
    attempts: 0,
  }));
}

/**
 * Checkpoints to use once a fill is known. A fill within half a step of the
 * planned volume keeps the checkpoints (copied). Otherwise they are re-planned for
 * the filled size. Returns null when the re-plan is infeasible.
 */
export function fillCheckpoints(
  i: Omit<FillReplanInput, 'checkpoints'> & { checkpoints: CheckpointState[]; plannedVolume: number | null | undefined },
): CheckpointState[] | null {
  const matchesPlan =
    i.plannedVolume === null ||
    i.plannedVolume === undefined ||
    Math.abs(i.filledVolume - i.plannedVolume) <= i.spec.volumeStep / 2;
  if (matchesPlan) return i.checkpoints.map((c) => ({ ...c }));
  return replanCheckpoints({ ...i, checkpoints: i.checkpoints });
}

export interface StopLossInput extends LifecycleView {
  profile: ExecutionProfile;
  currentSl: number;
  bestPrice: number;
  beApplied: boolean;
  trailingActive: boolean;
  digits: number;
}

export interface StopLossDecision {
  sl: number;
  reasons: StopReason[];
}

/**
 * Most protective stop-loss candidate that tightens the current stop, or null.
 * Candidates: after_checkpoint moves (only once the referenced checkpoint is
 * done), break-even (sticky once applied) and trailing (sticky once active).
 * A move driven only by trailing must improve the stop by at least step_price.
 */
export function desiredStopLoss(input: StopLossInput): StopLossDecision | null {
  const { direction, entry, profile, checkpoints, currentSl, digits } = input;
  const buy = direction === 'buy';
  const candidates: { reason: StopReason; sl: number }[] = [];

  const ordered = [...checkpoints].sort((a, b) => a.tp_index - b.tp_index);
  for (const rule of profile.stop_loss.after_checkpoint) {
    if (!tpDone(checkpoints, rule.after_tp_index)) continue;
    if (rule.move_to === 'entry') {
      candidates.push({ reason: 'after_checkpoint', sl: buy ? entry + rule.buffer_price : entry - rule.buffer_price });
      continue;
    }
    const idx = ordered.findIndex((c) => c.tp_index === rule.after_tp_index);
    if (idx < 0) continue;
    if (idx === 0) {
      // No earlier TP: behave like move_to 'entry' rather than placing the stop below entry.
      candidates.push({ reason: 'after_checkpoint', sl: buy ? entry + rule.buffer_price : entry - rule.buffer_price });
      continue;
    }
    // previous_tp leaves the buffer as room behind the level (BUY below it, SELL above it).
    const level = ordered[idx - 1].price;
    candidates.push({ reason: 'after_checkpoint', sl: buy ? level - rule.buffer_price : level + rule.buffer_price });
  }

  if (input.beApplied || breakEvenTriggered(input, profile)) {
    const buffer = profile.break_even.buffer_price;
    candidates.push({ reason: 'break_even', sl: buy ? entry + buffer : entry - buffer });
  }

  if (profile.trailing.enabled && (input.trailingActive || trailingActivated(input, profile))) {
    const distance = profile.trailing.distance_price;
    const best = input.bestPrice;
    candidates.push({ reason: 'trailing', sl: buy ? best - distance : best + distance });
  }

  if (candidates.length === 0) return null;

  const rounded = candidates.map((c) => ({ reason: c.reason, sl: roundPrice(c.sl, digits) }));
  let chosen = rounded[0].sl;
  for (const c of rounded) {
    if (buy ? c.sl > chosen : c.sl < chosen) chosen = c.sl;
  }
  if (!(chosen > 0)) return null;

  const tightens =
    currentSl <= 0 ? true : buy ? chosen > currentSl + PRICE_EPS : chosen < currentSl - PRICE_EPS;
  if (!tightens) return null;

  const reasons: StopReason[] = [];
  for (const c of rounded) {
    if (c.sl === chosen && !reasons.includes(c.reason)) reasons.push(c.reason);
  }

  if (reasons.length === 1 && reasons[0] === 'trailing' && currentSl > 0) {
    const improvement = buy ? chosen - currentSl : currentSl - chosen;
    if (improvement + PRICE_EPS < profile.trailing.step_price) return null;
  }

  return { sl: chosen, reasons };
}

/**
 * A stop is valid when it is on the correct side of the market and at least
 * max(stopsLevel, freezeLevel) points away from it.
 */
export function isStopModificationValid(
  direction: TradeDirection,
  newSl: number,
  bid: number,
  ask: number,
  stopsLevelPoints: number,
  freezeLevelPoints: number,
  point: number,
): boolean {
  if (!(newSl > 0) || !(point > 0)) return false;
  const minDist = Math.max(stopsLevelPoints, freezeLevelPoints) * point;
  return direction === 'buy' ? newSl < bid - minDist : newSl > ask + minDist;
}

/** Best price reached so far: highest for BUY, lowest for SELL. An unset best starts at the close price. */
export function updateBestPrice(direction: TradeDirection, best: number, closePrice: number): number {
  if (!(best > 0)) return closePrice;
  return direction === 'buy' ? Math.max(best, closePrice) : Math.min(best, closePrice);
}

function isExitDeal(d: Pick<BrokerDeal, 'entry'>): boolean {
  return d.entry === 'OUT' || d.entry === 'OUT_BY';
}

function byTimeThenTicket(
  a: Pick<BrokerDeal, 'time' | 'ticket'>,
  b: Pick<BrokerDeal, 'time' | 'ticket'>,
): number {
  return a.time - b.time || a.ticket - b.ticket;
}

/** The latest exit (OUT / OUT_BY) deal, or null when there is none. */
export function lastExitDeal<T extends Pick<BrokerDeal, 'entry' | 'time' | 'ticket'>>(deals: T[]): T | null {
  const exits = deals.filter(isExitDeal).sort(byTimeThenTicket);
  return exits.length > 0 ? exits[exits.length - 1] : null;
}

/** Close reason from the last exit deal: SL -> sl, TP -> tp, anything else -> manual. */
export function classifyCloseReason(deals: Pick<BrokerDeal, 'entry' | 'reason' | 'time' | 'ticket'>[]): CloseReason {
  const last = lastExitDeal(deals);
  if (!last) return 'manual';
  if (last.reason === 'SL') return 'sl';
  if (last.reason === 'TP') return 'tp';
  return 'manual';
}

/** Realized money of a position: exit deals only, including partial closes. */
export function realizedPnlFromDeals(
  deals: Pick<BrokerDeal, 'entry' | 'profit' | 'commission' | 'swap' | 'fee'>[],
): number {
  let total = 0;
  for (const d of deals) {
    if (isExitDeal(d)) total += d.profit + d.commission + d.swap + d.fee;
  }
  return Math.round(total * 100) / 100;
}
