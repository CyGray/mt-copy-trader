/**
 * mt5TradeEngine.ts
 *
 * Trade engine for the Vantage AutoTrader (contracts §6). Consumes one signal
 * event at a time and decides whether a broker order may be sent.
 *
 * Safety rules implemented here:
 *  - The trade set is claimed with an atomic create() before any gate runs.
 *    The doc id (`${chatId}_${messageId}`) makes the claim idempotent.
 *  - Gates run in order; any refusal records SKIPPED with a stable reason code.
 *  - Intent is persisted (SUBMITTING, with plan, profile snapshot and checkpoints)
 *    before placeOrder. If the write fails, nothing is sent.
 *  - An ambiguous send becomes SUBMIT_UNKNOWN and is never resent.
 *  - Revisions and cancels act on the stored profile_snapshot and the stored
 *    trade set mode, never on the currently active profile or mode.
 *  - Kill switch and mode checks block new entries only. Revisions and cancels
 *    of existing trades do not consult execution control.
 *
 * Deviations from contracts §6 (see VANTAGE_IMPLEMENTATION_PROGRESS.md):
 *  - Sizing and checkpoint planning run before the position and risk limits,
 *    because the total-risk check needs the new trade's risk.
 *  - The SL side and distance check runs after the entry decision, because it
 *    needs entry_ref_price, which the decision produces.
 *  - A same-event redelivery while the claim is fresh returns `retry`
 *    instead of entering the revision path.
 *  - A message date more than 30 s in the future is `signal_missing_date`
 *    (clock skew makes it unusable), not `signal_too_old`.
 *  - A cancel without cancelReason is treated as unparseable_edit (never closes).
 *  - Verification of a fill that cannot see its position is recorded as
 *    `protection_unverified` (not in the contract's reason list).
 *  - Checkpoint warnings and the tickValue fallback are stored in plan.warnings
 *    (TradePlan in tradeSetTypes.ts has no such field yet).
 *  - Gate 5 also skips `clock_skew` (MT5 broker only) when the EA's TimeGMT() and
 *    the worker clock differ by more than MAX_CLOCK_SKEW_SEC, and the router
 *    refuses non-hedging accounts (`account_netting`).
 *  - Gate 13 also skips `symbol_volume_limit` when SYMBOL_VOLUME_LIMIT would be exceeded.
 *  - Gate 8 also skips `quote_stale` when the symbol's last tick is older than
 *    MAX_QUOTE_AGE_SEC (closed market or frozen feed; added in the hardening pass).
 *  - Control is re-read (cache bypassed) after the gates and before SUBMITTING.
 *    A kill switch, mode or active profile change skips with the fresh reason.
 *  - A partial fill re-plans lifecycle.checkpoints for the filled volume
 *    (`partial_fill_replanned`, or `partial_fill_replan_infeasible` with the
 *    original checkpoints kept). plan keeps the sized plan; the filled volume is
 *    in broker_refs.filled_volume and lifecycle.current_volume.
 */

import { hostname } from 'node:os';
import { raiseAlert } from './alerts';
import {
  effectiveLimits,
  resolveBrokerSymbol,
  validateProfile,
  validateProfileAgainstSafety,
  validateSafetyLimits,
} from './executionProfile';
import type { EffectiveLimits, ExecutionProfile, SafetyLimits, ValidationIssue } from './executionProfile';
import { canOpenNewEntries, getExecutionControl, invalidateExecutionControl } from './executionControl';
import type { ExecutionControl } from './executionControl';
import { maxClockSkewSec } from './bridgeHealth';
import { getBroker, verifyAccountForMode } from './brokerRouter';
import type { BrokerMode } from './brokerRouter';
import {
  BrokerAmbiguousError,
  BrokerRejectedError,
  BrokerUnavailableError,
} from './brokerTypes';
import type { BrokerAdapter, CloseResult, PlaceOrderRequest, PlaceOrderResult, SymbolInfo } from './brokerTypes';
import { decideEntry, validateStopLoss } from './entryPolicy';
import type { EntryDecision } from './entryPolicy';
import { fillCheckpoints } from './lifecycleRules';
import { getCachedGmtSkewSec } from './mt5Client';
import { computeVolume, planCheckpoints } from './positionSizing';
import type { CheckpointPlanResult, PlannedCheckpoint, SizingResult, SizingSpec } from './positionSizing';
import { logger } from './logger';
import { recordTradeEvent } from './tradeEvents';
import {
  createTradeSet,
  getTradeSet,
  listTradeSetsByState,
  requireFirestore,
  stripUndefined,
  transitionTradeSet,
  updateTradeSet,
} from './tradeSetStore';
import { correlationComment, tradeSetIdFor } from './tradeSetTypes';
import type {
  CheckpointState,
  TradeLifecycle,
  TradePlan,
  TradeSetDoc,
  TradeState,
  TradeEventType,
} from './tradeSetTypes';
import { writeSystemLog } from './systemLog';
import type { GoldSignal } from './vipSignalParser';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SignalEventInput {
  eventId: string;
  chatId: string;
  messageId: string;
  /** ISO string of the Telegram message date; null when unknown. */
  messageDate: string | null;
  messageType: 'new' | 'edit';
  kind: 'signal' | 'cancel';
  signal: GoldSignal | null;
  cancelReason?: 'unparseable_edit' | 'explicit_cancel';
  textHash?: string;
}

export interface HandleResult {
  outcome: 'created' | 'skipped' | 'submitted' | 'revision' | 'cancel' | 'noop' | 'retry';
  state?: TradeState;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

/** Request lifetime sent to the bridge (contracts §1, AD-3). */
const SUBMIT_TTL_SEC = 8;
const CLAIM_STALE_MS = 60_000;
const MAX_CLAIM_ATTEMPTS = 3;
const CLOCK_SKEW_SEC = 30;
const DEFAULT_MAX_QUOTE_AGE_SEC = 60;
const PRICE_EPS = 1e-9;
const IN_FLIGHT_STATES: readonly TradeState[] = ['SUBMITTING', 'SUBMIT_UNKNOWN'];
const OPEN_RISK_STATES: readonly TradeState[] = [
  'OPEN',
  'PARTIALLY_CLOSED',
  'PENDING_ORDER',
  'SUBMITTING',
  'SUBMIT_UNKNOWN',
];

type AuditLevel = 'info' | 'warn' | 'error';

/** Thrown inside the gate chain to record a SKIPPED trade set with a reason code. */
class SkipSignal extends Error {
  readonly reason: string;

  constructor(reason: string, detail: string) {
    super(detail);
    this.name = 'SkipSignal';
    this.reason = reason;
  }
}

function skip(reason: string, detail: string): SkipSignal {
  return new SkipSignal(reason, detail);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summarize(issues: ValidationIssue[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** MAX_QUOTE_AGE_SEC (default 60): an entry is skipped as quote_stale when the last tick is older. */
function maxQuoteAgeMs(): number {
  const n = Number(process.env.MAX_QUOTE_AGE_SEC);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_QUOTE_AGE_SEC) * 1000;
}

function startOfUtcDaySec(ms: number): number {
  const d = new Date(ms);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

function isStaleClaim(claimedAt: string | undefined, now: number): boolean {
  const at = claimedAt ? Date.parse(claimedAt) : NaN;
  return !Number.isFinite(at) || now - at > CLAIM_STALE_MS;
}

/** Writes a structured log line and the system_logs entry for a significant path. */
async function audit(level: AuditLevel, event: string, details: Record<string, unknown>): Promise<void> {
  logger[level](event, details);
  await writeSystemLog(level, 'mt5_engine', event, stripUndefined(details));
}

function tradeEvent(
  tradeSetId: string,
  mode: string,
  eventKey: string,
  type: TradeEventType,
  extra: {
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
  } = {},
): Promise<boolean> {
  return recordTradeEvent({ tradeSetId, eventKey, type, mode, ...extra });
}

function toLifecycleCheckpoints(planned: PlannedCheckpoint[]): CheckpointState[] {
  return planned.map((c): CheckpointState => ({
    tp_index: c.tpIndex,
    price: c.price,
    close_volume: c.closeVolume,
    target_remaining_volume: c.targetRemainingVolume,
    status: 'pending',
    attempts: 0,
  }));
}

/** Checkpoint prices must lie beyond the entry and move monotonically in the trade direction. */
function ladderValid(prices: number[], direction: 'buy' | 'sell', entry: number): boolean {
  for (let k = 0; k < prices.length; k++) {
    const p = prices[k];
    if (!Number.isFinite(p)) return false;
    if (direction === 'buy' ? !(p > entry) : !(p < entry)) return false;
    if (k > 0) {
      const prev = prices[k - 1];
      if (direction === 'buy' ? !(p > prev) : !(p < prev)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Entry: claim, gates, persist intent, send
// ---------------------------------------------------------------------------

interface GateContext {
  brokerSymbol?: string;
}

interface Prepared {
  mode: BrokerMode;
  broker: BrokerAdapter;
  direction: 'buy' | 'sell';
  profile: ExecutionProfile;
  profileDocId: string;
  limits: EffectiveLimits;
  brokerSymbol: string;
  spec: SymbolInfo;
  decision: Extract<EntryDecision, { ok: true }>;
  sized: Extract<SizingResult, { ok: true }>;
  checkpoints: PlannedCheckpoint[];
  brokerTp: number;
  sl: number;
  request: PlaceOrderRequest;
  equity: number;
  warnings: string[];
}

export async function handleSignalEvent(ev: SignalEventInput): Promise<HandleResult> {
  try {
    return ev.kind === 'cancel' ? await handleCancel(ev) : await handleSignal(ev);
  } catch (err) {
    // Unexpected failure. Re-delivery is safe: a claimed set is retried, and any
    // later state makes the event a no-op or a revision, never a second order.
    await audit('error', 'signal_event_failed', { eventId: ev.eventId, error: errorMessage(err) });
    return { outcome: 'retry', reason: 'unexpected_error' };
  }
}

async function handleSignal(ev: SignalEventInput): Promise<HandleResult> {
  if (!ev.signal) {
    await audit('warn', 'signal_event_without_signal', { eventId: ev.eventId });
    return { outcome: 'noop', reason: 'missing_signal' };
  }

  const tradeSetId = tradeSetIdFor(ev.chatId, ev.messageId);
  const corr = correlationComment(tradeSetId);
  const control = await getExecutionControl();
  const nowIso = new Date().toISOString();

  let claim: 'created' | 'exists';
  try {
    claim = await createTradeSet({
      schema: 2,
      trade_set_id: tradeSetId,
      chat_id: ev.chatId,
      message_id: ev.messageId,
      event_id: ev.eventId,
      signal: ev.signal,
      signal_revisions: [],
      symbol: ev.signal.symbol,
      broker_symbol: null,
      direction: ev.signal.direction,
      order_type: null,
      mode: control.mode,
      broker: null,
      profile: null,
      profile_snapshot: null,
      limits_snapshot: null,
      state: 'CLAIMED',
      correlation_comment: corr,
      claim: { attempts: 1, claimed_at: nowIso, owner: `${hostname()}:${process.pid}` },
      plan: null,
      submission: null,
      broker_refs: null,
      lifecycle: null,
      result: null,
      created_at: nowIso,
      updated_at: nowIso,
    });
  } catch (err) {
    return transientRetry(tradeSetId, 'claim_failed', err);
  }

  if (claim === 'exists') {
    let existing: TradeSetDoc | null;
    try {
      existing = await getTradeSet(tradeSetId);
    } catch (err) {
      return transientRetry(tradeSetId, 'claim_read_failed', err);
    }
    if (!existing) return transientRetry(tradeSetId, 'claim_vanished', 'trade set disappeared after create');

    if (existing.event_id === ev.eventId) {
      // Same event delivered again (restart or retry). Never enter the revision path.
      if (existing.state !== 'CLAIMED') {
        return { outcome: 'noop', state: existing.state, reason: 'already_processed' };
      }
      if (!isStaleClaim(existing.claim?.claimed_at, Date.now())) {
        return { outcome: 'retry', state: 'CLAIMED', reason: 'claim_in_progress' };
      }
      if ((existing.claim?.attempts ?? 0) >= MAX_CLAIM_ATTEMPTS) {
        return { outcome: 'noop', state: 'CLAIMED', reason: 'claim_attempts_exhausted' };
      }
      const reclaimed = await reclaimTradeSet(tradeSetId, ev.eventId, control.mode, existing.claim);
      if (!reclaimed) return { outcome: 'retry', reason: 'reclaim_lost_race' };
    } else {
      return handleRevision(ev, existing);
    }
  }

  const mode = control.mode;
  await tradeEvent(tradeSetId, mode, 'signal_received', 'signal_received', {
    details: { event_id: ev.eventId, message_type: ev.messageType },
  });

  const gate: GateContext = {};
  let prepared: Prepared;
  try {
    prepared = await runGates(ev, control, tradeSetId, corr, gate);
  } catch (err) {
    if (err instanceof SkipSignal) return recordSkip(tradeSetId, mode, err, gate, ev);
    return transientRetry(tradeSetId, 'gate_error', err);
  }

  await tradeEvent(tradeSetId, prepared.mode, 'signal_validated', 'signal_validated', {
    profileDocId: prepared.profileDocId,
    profileVersion: prepared.profile.version,
    volume: prepared.sized.volume,
    sl: prepared.sl,
    tp: prepared.brokerTp,
    details: {
      order_type: prepared.decision.orderType,
      entry_ref_price: prepared.decision.entryRefPrice,
      risk_money: prepared.sized.riskMoney,
      warnings: prepared.warnings,
    },
  });

  // Last check before the intent is written. The gates may have read a cached control.
  invalidateExecutionControl();
  const recheck = entryRecheck(prepared, await getExecutionControl());
  if (recheck) return recordSkip(tradeSetId, mode, recheck, gate, ev);

  return persistAndSend(tradeSetId, corr, prepared);
}

/** Refusal from a fresh control read, or null. Mode and active profile must still match the gates. */
function entryRecheck(p: Prepared, fresh: ExecutionControl): SkipSignal | null {
  const allowed = canOpenNewEntries(fresh);
  if (allowed.allowed === false) {
    return skip(allowed.reason, `execution control refused entries before send: ${allowed.reason}`);
  }
  if (fresh.mode !== p.mode) {
    return skip('mode_changed', `mode changed from ${p.mode} to ${fresh.mode} before send`);
  }
  if (fresh.activeProfileDocId !== p.profileDocId) {
    return skip(
      'profile_changed',
      `active profile changed from ${p.profileDocId} to ${fresh.activeProfileDocId ?? 'none'} before send`,
    );
  }
  return null;
}

async function reclaimTradeSet(
  tradeSetId: string,
  eventId: string,
  mode: string,
  previousClaim: TradeSetDoc['claim'] | undefined,
): Promise<boolean> {
  const firestore = requireFirestore();
  const ref = firestore.collection('trade_sets').doc(tradeSetId);
  const nowIso = new Date().toISOString();
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const current = snap.data() as unknown as TradeSetDoc;
    if (current.schema !== 2 || current.state !== 'CLAIMED' || current.event_id !== eventId) return false;
    if (!isStaleClaim(current.claim?.claimed_at, Date.now())) return false;
    if ((current.claim?.attempts ?? 0) >= MAX_CLAIM_ATTEMPTS) return false;
    if (current.claim?.claimed_at !== previousClaim?.claimed_at) return false;
    tx.set(
      ref,
      {
        claim: {
          attempts: (current.claim?.attempts ?? 0) + 1,
          claimed_at: nowIso,
          owner: `${hostname()}:${process.pid}`,
        },
        mode,
        updated_at: nowIso,
      },
      { merge: true },
    );
    return true;
  });
}

async function transientRetry(tradeSetId: string, reason: string, err: unknown): Promise<HandleResult> {
  await audit('warn', 'signal_event_retry', { tradeSetId, reason, error: errorMessage(err) });
  return { outcome: 'retry', reason };
}

async function recordSkip(
  tradeSetId: string,
  mode: string,
  err: SkipSignal,
  gate: GateContext,
  ev: SignalEventInput,
): Promise<HandleResult> {
  let moved: boolean;
  try {
    moved = await transitionTradeSet(tradeSetId, ['CLAIMED'], {
      state: 'SKIPPED',
      skip_reason: err.reason,
      ...(gate.brokerSymbol ? { broker_symbol: gate.brokerSymbol } : {}),
    });
  } catch (writeErr) {
    return transientRetry(tradeSetId, 'skip_write_failed', writeErr);
  }
  if (!moved) {
    await audit('warn', 'skip_state_changed', { tradeSetId, reason: err.reason });
  }
  await tradeEvent(tradeSetId, mode, `skipped_${err.reason}`, 'execution_skipped', {
    reasonCode: err.reason,
    message: err.message,
    details: { event_id: ev.eventId },
  });
  await audit('info', 'execution_skipped', {
    tradeSetId,
    reason: err.reason,
    detail: err.message,
    mode,
  });
  return { outcome: 'skipped', state: 'SKIPPED', reason: err.reason };
}

/** Runs gates 1 to 17 (contracts §6 step 2, with the deviations in the file header). Throws SkipSignal on refusal. */
async function runGates(
  ev: SignalEventInput,
  control: ExecutionControl,
  tradeSetId: string,
  corr: string,
  gate: GateContext,
): Promise<Prepared> {
  const signal = ev.signal as GoldSignal;

  // 1. Execution control.
  const allowed = canOpenNewEntries(control);
  if (allowed.allowed === false) throw skip(allowed.reason, `execution control refused entries: ${allowed.reason}`);
  if (control.mode === 'disabled') throw skip('execution_disabled', 'execution mode is disabled');
  const mode: BrokerMode = control.mode;
  const profileDocId = control.activeProfileDocId ?? '';

  // 2. Runtime fail-closed re-validation (owner requirement, AD-11).
  const profileCheck = validateProfile(control.activeProfile);
  if (!profileCheck.ok || !profileCheck.value) {
    throw skip('invalid_profile', `profile failed validation: ${summarize(profileCheck.errors)}`);
  }
  const safetyCheck = validateSafetyLimits(control.safety);
  if (!safetyCheck.ok || !safetyCheck.value) {
    throw skip('invalid_safety', `safety limits failed validation: ${summarize(safetyCheck.errors)}`);
  }
  const profile = profileCheck.value;
  const safety: SafetyLimits = safetyCheck.value;
  const safetyIssues = validateProfileAgainstSafety(profile, safety);
  if (safetyIssues.length > 0) {
    throw skip('invalid_profile', `profile exceeds safety limits: ${summarize(safetyIssues)}`);
  }
  const limits = effectiveLimits(profile, safety);

  // 3. Symbol mapping and allow-list.
  const brokerSymbol = resolveBrokerSymbol(profile, signal.symbol);
  if (!brokerSymbol) {
    throw skip('symbol_not_mapped', `${signal.symbol} has no broker symbol in profile ${profile.profile_id}`);
  }
  gate.brokerSymbol = brokerSymbol;
  if (!safety.allowed_signal_symbols.some((s) => s.toUpperCase() === signal.symbol.toUpperCase())) {
    throw skip('symbol_not_allowed', `${signal.symbol} is not in allowed_signal_symbols`);
  }

  // 4. Signal age. A missing or unusable date never counts as fresh.
  const messageMs = ev.messageDate ? Date.parse(ev.messageDate) : NaN;
  if (!Number.isFinite(messageMs)) throw skip('signal_missing_date', 'signal has no usable message date');
  const ageSec = (Date.now() - messageMs) / 1000;
  if (ageSec < -CLOCK_SKEW_SEC) {
    throw skip('signal_missing_date', `message date is ${Math.round(-ageSec)}s in the future`);
  }
  if (ageSec > limits.maxSignalAgeSec) {
    throw skip('signal_too_old', `signal is ${Math.round(ageSec)}s old; limit ${limits.maxSignalAgeSec}s`);
  }

  // 5. Broker and account for the mode.
  const broker = await getBroker(mode);
  const account = await verifyAccountForMode(mode, broker);
  if (account.ok === false) throw skip(account.reason, `account check failed for mode ${mode}: ${account.reason}`);
  // Request expiry is judged on the EA clock; a large skew makes the ambiguity window unreliable.
  const skew = broker.kind === 'mt5' ? getCachedGmtSkewSec() : null;
  if (skew !== null && Math.abs(skew) > maxClockSkewSec()) {
    throw skip('clock_skew', `EA TimeGMT differs from the worker clock by ${skew}s; limit ${maxClockSkewSec()}s`);
  }

  // 6. Symbol specification.
  let spec: SymbolInfo;
  try {
    spec = await broker.getSymbolInfo(brokerSymbol);
  } catch (err) {
    if (err instanceof BrokerRejectedError && err.retcode === 5007) {
      throw skip('symbol_not_mapped', `terminal does not know symbol ${brokerSymbol}`);
    }
    throw err;
  }

  // 7. Symbol trade mode must permit the direction.
  const modeOk =
    signal.direction === 'buy'
      ? spec.tradeMode === 'FULL' || spec.tradeMode === 'LONGONLY'
      : spec.tradeMode === 'FULL' || spec.tradeMode === 'SHORTONLY';
  if (!modeOk) {
    throw skip('symbol_trade_disabled', `${brokerSymbol} trade mode ${spec.tradeMode} does not permit ${signal.direction}`);
  }

  // 8. Quote and spread (spread = spreadPoints * point).
  if (!(spec.bid > 0) || !(spec.ask > 0) || spec.ask < spec.bid) {
    throw skip('invalid_quote', `invalid quote bid=${spec.bid} ask=${spec.ask}`);
  }
  // A quote with an old tick time means a closed market or a frozen feed. Unknown tick time (0) is not judged here.
  const quoteAgeMs = spec.tickTimeMsc > 0 ? Date.now() - spec.tickTimeMsc : 0;
  if (quoteAgeMs > maxQuoteAgeMs()) {
    throw skip('quote_stale', `last ${brokerSymbol} tick is ${Math.round(quoteAgeMs / 1000)}s old; limit ${Math.round(maxQuoteAgeMs() / 1000)}s`);
  }
  const spreadPrice = spec.spreadPoints * spec.point;
  if (spreadPrice > limits.maxSpreadPrice + PRICE_EPS) {
    throw skip('spread_too_wide', `spread ${spreadPrice} above max ${limits.maxSpreadPrice}`);
  }

  // Fresh account snapshot for sizing and margin (the router caches its own read).
  const info = await broker.getAccountInfo();

  // 9. Entry decision.
  const decision = decideEntry(signal, { bid: spec.bid, ask: spec.ask }, profile.entry);
  if (decision.ok === false) throw skip(decision.reason, decision.detail);

  // 10. Stop-loss side and distance, against the entry reference price.
  const slCheck = validateStopLoss(signal.direction, decision.entryRefPrice, signal.stopLoss, profile.stop_loss);
  if (slCheck.ok === false) throw skip(slCheck.reason, slCheck.detail);

  // 11. Sizing. tickValueLoss falls back to tickValue only when missing or zero.
  const warnings: string[] = [];
  let tickValueLoss = spec.tickValueLoss;
  if (!(tickValueLoss > 0)) {
    tickValueLoss = spec.tickValue;
    warnings.push(`tickValueLoss ${spec.tickValueLoss} missing; sized with tickValue ${spec.tickValue}`);
  }
  const sizingSpec: SizingSpec = {
    tickSize: spec.tickSize,
    tickValueLoss,
    volumeMin: spec.volumeMin,
    volumeMax: spec.volumeMax,
    volumeStep: spec.volumeStep,
  };
  const sizing = computeVolume({
    sizing: profile.sizing,
    entryPrice: decision.entryRefPrice,
    stopLoss: signal.stopLoss,
    equity: info.equity,
    spec: sizingSpec,
    limits,
  });
  if (sizing.ok === false) throw skip(sizing.reason, sizing.detail);

  // 12. Checkpoint plan for the sized volume.
  const planned: CheckpointPlanResult = planCheckpoints({
    totalVolume: sizing.volume,
    direction: signal.direction,
    entryPrice: decision.entryRefPrice,
    takeProfits: signal.takeProfits,
    takeProfit: profile.take_profit,
    spec: sizingSpec,
  });
  if (planned.ok === false) throw skip(planned.reason, planned.detail);
  warnings.push(...planned.warnings);

  // 13. Position limits: broker positions and orders, plus local in-flight sets.
  const positions = await broker.getPositions();
  const orders = await broker.getOrders();
  const localSets = await listTradeSetsByState(OPEN_RISK_STATES);
  const sameMode = localSets.filter((s) => s.mode === mode && s.trade_set_id !== tradeSetId);
  const inFlight = sameMode.filter((s) => IN_FLIGHT_STATES.includes(s.state));
  const totalCount = positions.length + orders.length + inFlight.length;
  if (totalCount >= limits.maxConcurrent) {
    throw skip('max_concurrent_positions', `${totalCount} positions/orders open; limit ${limits.maxConcurrent}`);
  }
  const symbolCount =
    positions.filter((p) => p.symbol === brokerSymbol).length +
    orders.filter((o) => o.symbol === brokerSymbol).length +
    inFlight.filter((s) => s.broker_symbol === brokerSymbol).length;
  if (symbolCount >= limits.maxPerSymbol) {
    throw skip('max_positions_per_symbol', `${symbolCount} positions/orders on ${brokerSymbol}; limit ${limits.maxPerSymbol}`);
  }
  // SYMBOL_VOLUME_LIMIT: the broker caps the total open plus pending volume per symbol (0 = no cap).
  if (spec.volumeLimit > 0) {
    const symbolVolume =
      positions.filter((p) => p.symbol === brokerSymbol).reduce((sum, p) => sum + p.volume, 0) +
      orders.filter((o) => o.symbol === brokerSymbol).reduce((sum, o) => sum + o.volumeCurrent, 0);
    if (symbolVolume + sizing.volume > spec.volumeLimit + spec.volumeStep / 2) {
      throw skip('symbol_volume_limit', `${symbolVolume} + ${sizing.volume} lots exceeds the ${brokerSymbol} volume limit ${spec.volumeLimit}`);
    }
  }

  // 14. Daily realized loss since 00:00 UTC.
  const deals = await broker.getDeals({ fromSec: startOfUtcDaySec(Date.now()) });
  const realized = deals
    .filter((d) => d.entry === 'OUT' || d.entry === 'OUT_BY' || d.entry === 'INOUT')
    .reduce((sum, d) => sum + d.profit + d.commission + d.swap + d.fee, 0);
  if (-realized >= limits.dailyLossLimit) {
    throw skip('daily_loss_limit', `realized loss ${(-realized).toFixed(2)} reached limit ${limits.dailyLossLimit}`);
  }

  // 15. Total open risk, including this trade, against equity.
  const openRisk = sameMode
    .filter((s) => s.lifecycle?.be_applied !== true)
    .reduce((sum, s) => sum + (s.plan?.risk_money ?? 0), 0);
  const riskCap = (info.equity * limits.maxTotalRiskPercent) / 100;
  if (openRisk + sizing.riskMoney > riskCap + PRICE_EPS) {
    throw skip('total_risk_limit', `open risk ${openRisk.toFixed(2)} + new ${sizing.riskMoney.toFixed(2)} exceeds ${riskCap.toFixed(2)}`);
  }

  // 16. Margin: the broker's check, then the post-trade margin level floor.
  const request: PlaceOrderRequest = {
    symbol: brokerSymbol,
    orderType: decision.orderType,
    volume: sizing.volume,
    price: decision.orderPrice,
    sl: signal.stopLoss,
    tp: planned.brokerTp,
    deviationPoints: limits.maxDeviationPoints,
    comment: corr,
    ...(decision.isPending
      ? { expiration: nowSec() + profile.entry.pending_expiry_minutes * 60 }
      : {}),
  };
  const check = await broker.checkOrder(request);
  if (!check.ok) throw skip('margin_check_failed', `${check.comment} (retcode ${check.retcode})`);
  if (limits.minMarginLevelPercent > 0) {
    const totalMargin = info.margin + check.margin;
    if (totalMargin > 0) {
      const level = (info.equity / totalMargin) * 100;
      if (level < limits.minMarginLevelPercent) {
        throw skip('margin_level_too_low', `post-trade margin level ${level.toFixed(0)}% below ${limits.minMarginLevelPercent}%`);
      }
    }
  }

  return {
    mode,
    broker,
    direction: signal.direction,
    profile,
    profileDocId,
    limits,
    brokerSymbol,
    spec,
    decision,
    sized: sizing,
    checkpoints: planned.checkpoints,
    brokerTp: planned.brokerTp,
    sl: signal.stopLoss,
    request,
    equity: info.equity,
    warnings,
  };
}

async function persistAndSend(tradeSetId: string, corr: string, p: Prepared): Promise<HandleResult> {
  const submittedAt = new Date().toISOString();
  const expiresAt = nowSec() + SUBMIT_TTL_SEC;

  const planDoc: TradePlan & { warnings?: string[] } = {
    volume: p.sized.volume,
    entry_ref_price: p.decision.entryRefPrice,
    order_price: p.decision.orderPrice,
    sl: p.sl,
    broker_tp: p.brokerTp,
    risk_money: p.sized.riskMoney,
    risk_percent: p.sized.riskPercent,
    checkpoints: p.checkpoints,
    ...(p.warnings.length > 0 ? { warnings: p.warnings } : {}),
  };
  const lifecycle: TradeLifecycle = {
    checkpoints: toLifecycleCheckpoints(p.checkpoints),
    current_volume: 0,
    current_sl: p.sl,
    current_tp: p.brokerTp,
    be_applied: false,
    trailing_active: false,
    best_price: p.decision.entryRefPrice,
  };
  const submission: { submitted_at: string; expires_at: number; request_id: string; pending_expires_at?: number } = {
    submitted_at: submittedAt,
    expires_at: expiresAt,
    request_id: '',
    ...(p.request.expiration !== undefined ? { pending_expires_at: p.request.expiration } : {}),
  };

  // Intent first. If this write fails, nothing is sent.
  let persisted: boolean;
  try {
    persisted = await transitionTradeSet(tradeSetId, ['CLAIMED'], {
      state: 'SUBMITTING',
      broker_symbol: p.brokerSymbol,
      order_type: p.decision.orderType,
      broker: p.broker.kind,
      profile: { doc_id: p.profileDocId, profile_id: p.profile.profile_id, version: p.profile.version },
      profile_snapshot: p.profile,
      limits_snapshot: p.limits,
      plan: planDoc,
      submission,
      lifecycle,
    });
  } catch (err) {
    persisted = false;
    await audit('error', 'entry_intent_persist_failed', { tradeSetId, error: errorMessage(err) });
  }
  if (!persisted) {
    const errored = await tryTransition(tradeSetId, ['CLAIMED'], {
      state: 'ERROR',
      error: 'persist_intent_failed',
    });
    await audit('error', 'entry_not_sent', { tradeSetId, reason: 'persist_intent_failed' });
    return errored
      ? { outcome: 'skipped', state: 'ERROR', reason: 'persist_intent_failed' }
      : { outcome: 'retry', reason: 'persist_intent_failed' };
  }

  const mode = p.mode;
  await tradeEvent(tradeSetId, mode, 'entry_submitted', 'entry_submitted', {
    profileDocId: p.profileDocId,
    profileVersion: p.profile.version,
    volume: p.sized.volume,
    price: p.decision.orderPrice,
    sl: p.sl,
    tp: p.brokerTp,
    details: { order_type: p.decision.orderType, correlation_comment: corr, expires_at: expiresAt },
  });
  await audit('info', 'entry_submitted', {
    tradeSetId,
    mode,
    orderType: p.decision.orderType,
    volume: p.sized.volume,
    symbol: p.brokerSymbol,
  });

  const ctx: SendContext = { tradeSetId, corr, p, lifecycle, submission };
  return sendEntry(ctx);
}

interface SendContext {
  tradeSetId: string;
  corr: string;
  p: Prepared;
  lifecycle: TradeLifecycle;
  submission: { submitted_at: string; expires_at: number; request_id: string; pending_expires_at?: number };
}

/** Writes a state change only when the doc is in one of `from`. Returns false on failure; never throws. */
async function tryTransition(
  tradeSetId: string,
  from: readonly TradeState[],
  patch: Record<string, unknown>,
): Promise<boolean> {
  try {
    return await transitionTradeSet(tradeSetId, from, patch);
  } catch (err) {
    await audit('error', 'trade_set_write_failed', { tradeSetId, error: errorMessage(err), patchState: patch.state });
    return false;
  }
}

async function sendEntry(ctx: SendContext): Promise<HandleResult> {
  const { p, tradeSetId } = ctx;
  let result: PlaceOrderResult;
  try {
    result = await p.broker.placeOrder(p.request);
  } catch (err) {
    if (err instanceof BrokerRejectedError) {
      return rejectEntry(ctx, 'broker_rejected', err.message, err.retcode);
    }
    if (err instanceof BrokerUnavailableError) {
      // Bridge unreachable before the request was sent. Not retried.
      return rejectEntry(ctx, 'bridge_unavailable', err.message);
    }
    // Ambiguous (BrokerAmbiguousError) or any unknown failure: the request may have reached the bridge.
    return markUnknown(ctx, err);
  }

  if (result.duplicate) {
    await tradeEvent(tradeSetId, p.mode, 'duplicate_detected', 'reconciliation', {
      orderTicket: result.orderTicket,
      positionTicket: result.positionTicket,
      message: 'bridge reported an existing order with this correlation comment',
    });
    await audit('warn', 'entry_duplicate_detected', { tradeSetId, orderTicket: result.orderTicket });
  }

  if (p.decision.isPending) return recordPending(ctx, result);
  return recordFill(ctx, result);
}

async function rejectEntry(
  ctx: SendContext,
  reason: string,
  message: string,
  retcode?: number,
): Promise<HandleResult> {
  const { p, tradeSetId } = ctx;
  await tryTransition(tradeSetId, ['SUBMITTING'], { state: 'REJECTED', error: `${reason}: ${message}` });
  await tradeEvent(tradeSetId, p.mode, 'entry_rejected', 'entry_rejected', {
    profileDocId: p.profileDocId,
    reasonCode: reason,
    message,
    retcode,
  });
  await audit('warn', 'entry_rejected', { tradeSetId, reason, retcode, detail: message });
  return { outcome: 'submitted', state: 'REJECTED', reason };
}

async function markUnknown(ctx: SendContext, err: unknown): Promise<HandleResult> {
  const { p, tradeSetId } = ctx;
  const ambiguous = err instanceof BrokerAmbiguousError ? err : null;
  const expiresAt = ambiguous?.expiresAt ?? ctx.submission.expires_at;
  await tryTransition(tradeSetId, ['SUBMITTING'], {
    state: 'SUBMIT_UNKNOWN',
    submission: {
      ...ctx.submission,
      expires_at: expiresAt,
      request_id: ambiguous?.requestId ?? ctx.submission.request_id,
    },
  });
  await tradeEvent(tradeSetId, p.mode, 'entry_unknown', 'entry_unknown', {
    profileDocId: p.profileDocId,
    reasonCode: 'ambiguous_send',
    message: errorMessage(err),
    details: { expires_at: expiresAt },
  });
  await audit('error', 'entry_unknown', {
    tradeSetId,
    error: errorMessage(err),
    expiresAt,
    note: 'not resent; reconciler resolves by correlation comment',
  });
  await raiseAlert({
    type: 'submit_unknown',
    subject: tradeSetId,
    severity: 'error',
    source: 'autotrader',
    title: 'Entry outcome unknown',
    message: `The ${p.mode} entry for ${tradeSetId} (${p.request.orderType} ${p.request.volume} ${p.request.symbol}) got no confirmed reply. It is not resent; the reconciler resolves it from broker state after the request expires.`,
    details: { trade_set_id: tradeSetId, mode: p.mode, correlation_comment: ctx.corr, expires_at: expiresAt },
  });
  return { outcome: 'submitted', state: 'SUBMIT_UNKNOWN', reason: 'entry_unknown' };
}

async function recordPending(ctx: SendContext, result: PlaceOrderResult): Promise<HandleResult> {
  const { p, tradeSetId } = ctx;
  const brokerRefs = {
    order_ticket: result.orderTicket,
    position_ticket: 0,
    deal_ticket: 0,
    fill_price: 0,
    filled_volume: 0,
    ...(result.expirationApplied !== undefined ? { expiration_applied: result.expirationApplied } : {}),
  };
  const moved = await tryTransition(tradeSetId, ['SUBMITTING'], {
    state: 'PENDING_ORDER',
    broker_refs: brokerRefs,
  });
  if (result.expirationApplied === false) {
    // Good-till-cancelled at the broker: the lifecycle manager cancels it at pending_expires_at.
    await tradeEvent(tradeSetId, p.mode, 'pending_expiry_not_applied', 'reconciliation', {
      orderTicket: result.orderTicket,
      reasonCode: 'expiration_not_applied',
      message: 'broker did not accept ORDER_TIME_SPECIFIED; the worker cancels the order at its expiry',
      details: { pending_expires_at: ctx.submission.pending_expires_at ?? null },
    });
    await audit('warn', 'pending_expiry_not_applied', { tradeSetId, orderTicket: result.orderTicket });
  }
  if (!moved) await audit('error', 'pending_state_not_recorded', { tradeSetId, orderTicket: result.orderTicket });
  await tradeEvent(tradeSetId, p.mode, 'pending_order_placed', 'pending_order_placed', {
    profileDocId: p.profileDocId,
    profileVersion: p.profile.version,
    orderTicket: result.orderTicket,
    price: p.decision.orderPrice,
    volume: p.sized.volume,
    sl: p.sl,
    tp: p.brokerTp,
  });
  await audit('info', 'pending_order_placed', {
    tradeSetId,
    orderTicket: result.orderTicket,
    orderType: p.decision.orderType,
    price: p.decision.orderPrice,
  });
  return { outcome: 'submitted', state: 'PENDING_ORDER' };
}

async function recordFill(ctx: SendContext, result: PlaceOrderResult): Promise<HandleResult> {
  const { p, tradeSetId, lifecycle } = ctx;
  const filledVolume = result.volume > 0 ? result.volume : p.sized.volume;
  const brokerRefs = {
    order_ticket: result.orderTicket,
    position_ticket: result.positionTicket,
    deal_ticket: result.dealTicket,
    fill_price: result.price,
    filled_volume: result.volume,
  };

  // A partial fill keeps the planned checkpoints only if they still split the filled size.
  const partial = Math.abs(filledVolume - p.sized.volume) > p.spec.volumeStep / 2;
  const fitted = partial
    ? fillCheckpoints({
        plannedVolume: p.sized.volume,
        direction: p.direction,
        entryPrice: result.price > 0 ? result.price : p.decision.entryRefPrice,
        filledVolume,
        profile: p.profile,
        spec: p.spec,
        checkpoints: lifecycle.checkpoints,
      })
    : null;
  const checkpoints = fitted ?? lifecycle.checkpoints;

  const moved = await tryTransition(tradeSetId, ['SUBMITTING'], {
    state: 'OPEN',
    broker_refs: brokerRefs,
    lifecycle: { ...lifecycle, checkpoints, current_volume: filledVolume },
  });
  if (!moved) await audit('error', 'open_state_not_recorded', { tradeSetId, positionTicket: result.positionTicket });
  await tradeEvent(tradeSetId, p.mode, 'entry_confirmed', 'entry_confirmed', {
    profileDocId: p.profileDocId,
    profileVersion: p.profile.version,
    orderTicket: result.orderTicket,
    positionTicket: result.positionTicket,
    dealTicket: result.dealTicket,
    volume: result.volume,
    price: result.price,
  });
  await audit('info', 'entry_confirmed', {
    tradeSetId,
    positionTicket: result.positionTicket,
    price: result.price,
    volume: result.volume,
  });
  if (partial) await recordPartialFill(ctx, filledVolume, checkpoints, fitted !== null);
  await verifyProtection(ctx, result.positionTicket);
  return { outcome: 'submitted', state: 'OPEN' };
}

/** Records a fill that differs from the planned volume: re-planned, or infeasible (original checkpoints kept). */
async function recordPartialFill(
  ctx: SendContext,
  filledVolume: number,
  checkpoints: CheckpointState[],
  feasible: boolean,
): Promise<void> {
  const { p, tradeSetId } = ctx;
  const details = {
    planned_volume: p.sized.volume,
    filled_volume: filledVolume,
    close_volumes: checkpoints.map((c) => c.close_volume),
  };
  if (feasible) {
    await tradeEvent(tradeSetId, p.mode, 'partial_fill_replanned', 'reconciliation', {
      profileDocId: p.profileDocId,
      profileVersion: p.profile.version,
      reasonCode: 'partial_fill_replanned',
      message: 'checkpoints re-planned for the filled volume',
      volume: filledVolume,
      details,
    });
    await audit('warn', 'partial_fill_replanned', { tradeSetId, ...details });
    return;
  }
  await tradeEvent(tradeSetId, p.mode, 'partial_fill_replan_infeasible', 'execution_error', {
    profileDocId: p.profileDocId,
    profileVersion: p.profile.version,
    reasonCode: 'partial_fill_replan_infeasible',
    message: 'filled volume cannot be split into feasible checkpoints; original checkpoints kept',
    volume: filledVolume,
    details,
  });
  await audit('error', 'partial_fill_replan_infeasible', { tradeSetId, ...details });
}

/** Confirms SL/TP on the filled position. Repairs once with modifyPosition; never resends the entry. */
async function verifyProtection(ctx: SendContext, positionTicket: number): Promise<void> {
  const { p, tradeSetId } = ctx;
  const tol = Math.max(p.spec.point * 0.5, PRICE_EPS);
  try {
    const positions = await p.broker.getPositions(p.brokerSymbol);
    const pos = positions.find((x) => x.ticket === positionTicket);
    if (!pos) {
      await recordExecutionError(ctx, 'protection_unverified', 'position not visible after fill');
      return;
    }
    if (pos.comment !== ctx.corr) await reportCommentMismatch(ctx, positionTicket, pos.comment);
    const slOk = Math.abs(pos.sl - p.sl) <= tol;
    const tpOk = p.brokerTp === 0 || Math.abs(pos.tp - p.brokerTp) <= tol;
    if (slOk && tpOk) {
      await protectionConfirmed(ctx, positionTicket, pos.sl, pos.tp);
      return;
    }
    try {
      await p.broker.modifyPosition(positionTicket, p.sl, p.brokerTp);
    } catch (err) {
      await recordExecutionError(ctx, 'protection_missing', errorMessage(err));
      return;
    }
    await tradeEvent(tradeSetId, p.mode, 'sl_modified_initial', 'sl_modified', {
      positionTicket,
      sl: p.sl,
      tp: p.brokerTp,
      details: { previous_sl: pos.sl, previous_tp: pos.tp },
    });
    await protectionConfirmed(ctx, positionTicket, p.sl, p.brokerTp);
  } catch (err) {
    await recordExecutionError(ctx, 'protection_unverified', errorMessage(err));
  }
}

/**
 * The broker stored a different comment than the correlation comment sent. The
 * duplicate guard and SUBMIT_UNKNOWN resolution match on that comment, so this is
 * critical evidence that the comment strategy does not hold on this broker.
 */
async function reportCommentMismatch(ctx: SendContext, positionTicket: number, stored: string): Promise<void> {
  const { p, tradeSetId, corr } = ctx;
  await tradeEvent(tradeSetId, p.mode, 'comment_not_preserved', 'execution_error', {
    positionTicket,
    reasonCode: 'comment_not_preserved',
    message: `broker stored comment "${stored}" instead of "${corr}"`,
  });
  await audit('error', 'comment_not_preserved', { tradeSetId, positionTicket, sent: corr, stored });
  await raiseAlert({
    type: 'correlation_mismatch',
    subject: tradeSetId,
    severity: 'critical',
    source: 'autotrader',
    title: 'Broker did not preserve the order comment',
    message: `Position ${positionTicket} (${tradeSetId}) carries comment "${stored}" instead of "${corr}". Duplicate protection and ambiguous-order recovery rely on that comment.`,
    details: { trade_set_id: tradeSetId, position_ticket: positionTicket, sent: corr, stored, mode: p.mode },
  });
}

async function protectionConfirmed(
  ctx: SendContext,
  positionTicket: number,
  sl: number,
  tp: number,
): Promise<void> {
  const { p, tradeSetId } = ctx;
  await tradeEvent(tradeSetId, p.mode, 'protection_confirmed', 'protection_confirmed', {
    profileDocId: p.profileDocId,
    positionTicket,
    sl,
    tp,
  });
  await audit('info', 'protection_confirmed', { tradeSetId, positionTicket, sl, tp });
}

async function recordExecutionError(ctx: SendContext, reasonCode: string, message: string): Promise<void> {
  const { p, tradeSetId } = ctx;
  await tradeEvent(tradeSetId, p.mode, `error_${reasonCode}_${Date.now()}`, 'execution_error', {
    profileDocId: p.profileDocId,
    reasonCode,
    message,
  });
  await audit('error', 'execution_error', { tradeSetId, reasonCode, detail: message });
  if (reasonCode === 'protection_missing' || reasonCode === 'protection_unverified') {
    await raiseAlert({
      type: 'protection_missing',
      subject: tradeSetId,
      severity: reasonCode === 'protection_missing' ? 'critical' : 'error',
      source: 'autotrader',
      title: reasonCode === 'protection_missing' ? 'Filled position may have no stop loss' : 'Stop loss of a filled position not confirmed',
      message: `${tradeSetId} (${p.mode}, ${p.request.symbol}): expected SL ${p.sl}${p.brokerTp ? ` and TP ${p.brokerTp}` : ''}. ${message}`,
      details: { trade_set_id: tradeSetId, mode: p.mode, expected_sl: p.sl, expected_tp: p.brokerTp },
    });
  }
}

// ---------------------------------------------------------------------------
// Revisions: a second signal event for an existing trade set
// ---------------------------------------------------------------------------

interface RevisionPlan {
  applied: boolean;
  reasons: string[];
  state: TradeState;
  patch?: Record<string, unknown>;
  slChanged?: { from: number; to: number };
}

function ignoredRevision(state: TradeState, reason: string): RevisionPlan {
  return { applied: false, reasons: [reason], state };
}

async function recordTradeError(
  tradeSetId: string,
  mode: string,
  code: string,
  message: string,
  eventId?: string,
): Promise<void> {
  await tradeEvent(tradeSetId, mode, `error_${code}_${Date.now()}`, 'execution_error', {
    reasonCode: code,
    message,
    details: eventId ? { event_id: eventId } : undefined,
  });
  await audit('error', 'execution_error', { tradeSetId, reasonCode: code, detail: message });
}

async function handleRevision(ev: SignalEventInput, existing: TradeSetDoc): Promise<HandleResult> {
  const tradeSetId = existing.trade_set_id;
  if (existing.schema !== 2) return { outcome: 'noop', reason: 'legacy_trade_set' };
  if ((existing.signal_revisions ?? []).some((r) => r.event_id === ev.eventId)) {
    return { outcome: 'noop', state: existing.state, reason: 'revision_already_applied' };
  }
  const mode = existing.mode;

  let plan: RevisionPlan;
  try {
    plan = await planRevision(existing, ev.signal);
  } catch (err) {
    if (err instanceof BrokerAmbiguousError) {
      await recordTradeError(tradeSetId, mode, 'revision_ambiguous', errorMessage(err), ev.eventId);
      return { outcome: 'revision', state: existing.state, reason: 'revision_ambiguous' };
    }
    if (err instanceof BrokerRejectedError) {
      plan = ignoredRevision(existing.state, `broker_rejected_${err.retcode}`);
    } else {
      return transientRetry(tradeSetId, 'revision_broker_error', err);
    }
  }

  const entry = {
    event_id: ev.eventId,
    text_hash: ev.textHash ?? '',
    received_at: new Date().toISOString(),
    outcome: plan.applied ? ('applied' as const) : ('ignored' as const),
    reason: plan.reasons.join('; '),
  };
  let recorded: boolean;
  try {
    recorded = await commitRevision(tradeSetId, ev.eventId, entry, plan.applied ? plan.patch : undefined);
  } catch (err) {
    await recordTradeError(tradeSetId, mode, 'revision_persist_failed', errorMessage(err), ev.eventId);
    return transientRetry(tradeSetId, 'revision_persist_failed', err);
  }
  if (!recorded) return { outcome: 'noop', state: existing.state, reason: 'revision_already_applied' };

  if (plan.applied) {
    if (plan.slChanged) {
      await tradeEvent(tradeSetId, mode, `sl_modified_${ev.eventId}`, 'sl_modified', {
        sl: plan.slChanged.to,
        details: { previous_sl: plan.slChanged.from, event_id: ev.eventId },
      });
    }
    await tradeEvent(tradeSetId, mode, `revision_${ev.eventId}`, 'signal_revision_applied', {
      reasonCode: 'applied',
      message: plan.reasons.join('; '),
      details: { event_id: ev.eventId },
    });
    await audit('info', 'signal_revision_applied', { tradeSetId, eventId: ev.eventId, reasons: plan.reasons });
  } else {
    await tradeEvent(tradeSetId, mode, `revision_${ev.eventId}`, 'signal_revision_ignored', {
      reasonCode: plan.reasons[0] ?? 'ignored',
      message: plan.reasons.join('; '),
      details: { event_id: ev.eventId },
    });
    await audit('info', 'signal_revision_ignored', { tradeSetId, eventId: ev.eventId, reasons: plan.reasons });
  }
  return { outcome: 'revision', state: plan.state, reason: plan.reasons.join('; ') };
}

/** Appends the revision record and applies `patch`, in one transaction. False when this event is already recorded. */
async function commitRevision(
  tradeSetId: string,
  eventId: string,
  entry: TradeSetDoc['signal_revisions'][number],
  patch: Record<string, unknown> | undefined,
): Promise<boolean> {
  const firestore = requireFirestore();
  const ref = firestore.collection('trade_sets').doc(tradeSetId);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const current = snap.data() as unknown as TradeSetDoc;
    const revisions = current.signal_revisions ?? [];
    if (revisions.some((r) => r.event_id === eventId)) return false;
    tx.set(
      ref,
      stripUndefined({
        ...(patch ?? {}),
        signal_revisions: [...revisions, entry],
        updated_at: new Date().toISOString(),
      }),
      { merge: true },
    );
    return true;
  });
}

/**
 * Decides and, where needed, applies a revision. Edits come from the frozen
 * profile_snapshot. Broker errors propagate: rejected becomes ignored, ambiguous
 * and unavailable are handled by the caller.
 */
async function planRevision(existing: TradeSetDoc, signal: GoldSignal | null): Promise<RevisionPlan> {
  const state = existing.state;
  if (state !== 'PENDING_ORDER' && state !== 'OPEN' && state !== 'PARTIALLY_CLOSED') {
    return ignoredRevision(state, `state_${state}`);
  }
  if (!signal) return ignoredRevision(state, 'missing_signal');
  const snapshot = existing.profile_snapshot;
  const plan = existing.plan;
  const lifecycle = existing.lifecycle;
  if (!snapshot || !plan || !lifecycle || !existing.broker_symbol) {
    return ignoredRevision(state, 'incomplete_trade_set');
  }
  if (existing.mode !== 'paper' && existing.mode !== 'demo' && existing.mode !== 'live') {
    return ignoredRevision(state, 'mode_disabled');
  }
  const broker = await getBroker(existing.mode);
  const args = { existing, signal, snapshot, plan, lifecycle, broker, brokerSymbol: existing.broker_symbol };
  return state === 'PENDING_ORDER' ? revisePending(args) : reviseOpen(args);
}

interface RevisionArgs {
  existing: TradeSetDoc;
  signal: GoldSignal;
  snapshot: ExecutionProfile;
  plan: TradePlan;
  lifecycle: TradeLifecycle;
  broker: BrokerAdapter;
  brokerSymbol: string;
}

async function revisePending(a: RevisionArgs): Promise<RevisionPlan> {
  const { existing, signal, snapshot, plan, lifecycle, broker, brokerSymbol } = a;
  const state = existing.state;
  if (snapshot.edits.before_fill !== 'apply_sl_tp') {
    return ignoredRevision(state, `before_fill_${snapshot.edits.before_fill}`);
  }
  const ticket = existing.broker_refs?.order_ticket;
  if (!ticket) return ignoredRevision(state, 'no_pending_order_ref');

  const slCheck = validateStopLoss(existing.direction, plan.order_price, signal.stopLoss, snapshot.stop_loss);
  if (slCheck.ok === false) return ignoredRevision(state, slCheck.reason);

  const spec = await broker.getSymbolInfo(brokerSymbol);
  const replanned = planCheckpoints({
    totalVolume: plan.volume,
    direction: existing.direction,
    entryPrice: plan.order_price,
    takeProfits: signal.takeProfits,
    takeProfit: snapshot.take_profit,
    spec: { volumeMin: spec.volumeMin, volumeStep: spec.volumeStep },
  });
  if (replanned.ok === false) return ignoredRevision(state, replanned.reason);

  const slSame = Math.abs(signal.stopLoss - plan.sl) <= PRICE_EPS;
  const tpSame =
    replanned.brokerTp === plan.broker_tp &&
    replanned.checkpoints.length === plan.checkpoints.length &&
    replanned.checkpoints.every(
      (c, i) =>
        c.tpIndex === plan.checkpoints[i].tpIndex && Math.abs(c.price - plan.checkpoints[i].price) <= PRICE_EPS,
    );
  if (slSame && tpSame) return ignoredRevision(state, 'unchanged');

  await broker.modifyPendingOrder(ticket, plan.order_price, signal.stopLoss, replanned.brokerTp);

  const newPlan: TradePlan = {
    ...plan,
    sl: signal.stopLoss,
    broker_tp: replanned.brokerTp,
    checkpoints: replanned.checkpoints,
  };
  const newLifecycle: TradeLifecycle = {
    ...lifecycle,
    checkpoints: toLifecycleCheckpoints(replanned.checkpoints),
    current_sl: signal.stopLoss,
    current_tp: replanned.brokerTp,
  };
  return {
    applied: true,
    reasons: [slSame ? 'sl_unchanged' : 'sl_applied', tpSame ? 'tp_unchanged' : 'tp_applied'],
    state,
    patch: { plan: newPlan, lifecycle: newLifecycle },
    slChanged: slSame ? undefined : { from: plan.sl, to: signal.stopLoss },
  };
}

async function reviseOpen(a: RevisionArgs): Promise<RevisionPlan> {
  const { existing, signal, snapshot, plan, lifecycle, broker, brokerSymbol } = a;
  const state = existing.state;
  if (snapshot.edits.after_fill === 'ignore') return ignoredRevision(state, 'after_fill_ignored');
  const ticket = existing.broker_refs?.position_ticket;
  if (!ticket) return ignoredRevision(state, 'no_position_ref');

  const spec = await broker.getSymbolInfo(brokerSymbol);
  const tol = Math.max(spec.point * 0.5, PRICE_EPS);
  const pos = (await broker.getPositions(brokerSymbol)).find((x) => x.ticket === ticket);
  if (!pos) return ignoredRevision(state, 'position_not_found');

  const buy = existing.direction === 'buy';
  const reasons: string[] = [];

  // Stop loss: must sit on the valid side of the current price; tighten-only when configured.
  let finalSl = pos.sl;
  let slChanged: { from: number; to: number } | undefined;
  if (Math.abs(signal.stopLoss - pos.sl) > tol) {
    const sideOk = buy ? signal.stopLoss < pos.priceCurrent : signal.stopLoss > pos.priceCurrent;
    const tighter = pos.sl === 0 || (buy ? signal.stopLoss > pos.sl : signal.stopLoss < pos.sl);
    if (!sideOk) {
      reasons.push('sl_wrong_side_of_price');
    } else if (snapshot.edits.after_fill === 'apply_tighten_only' && !tighter) {
      reasons.push('sl_loosen_ignored');
    } else {
      finalSl = signal.stopLoss;
      slChanged = { from: pos.sl, to: signal.stopLoss };
      reasons.push('sl_applied');
    }
  } else {
    reasons.push('sl_unchanged');
  }

  // Take profit: only checkpoints still pending take the new price.
  const cps = lifecycle.checkpoints;
  const next = cps.map((cp) => (cp.status === 'pending' ? signal.takeProfits[cp.tp_index - 1] : cp.price));
  let missing = false;
  let touched = false;
  cps.forEach((cp, i) => {
    if (cp.status !== 'pending') return;
    const v = next[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) missing = true;
    else if (Math.abs(v - cp.price) > PRICE_EPS) touched = true;
  });
  let tpPrices: number[] | null = null;
  if (missing) {
    reasons.push('tp_missing');
  } else if (!touched) {
    reasons.push('tp_unchanged');
  } else if (ladderValid(next, existing.direction, plan.entry_ref_price)) {
    tpPrices = next;
    reasons.push('tp_applied');
  } else {
    reasons.push('tp_order_invalid');
  }

  if (!slChanged && !tpPrices) return { applied: false, reasons, state };

  // The broker TP follows the final checkpoint only while that checkpoint is pending.
  const last = cps.length - 1;
  let finalTp = pos.tp;
  let brokerTpChanged = false;
  if (tpPrices && snapshot.take_profit.broker_tp === 'final_checkpoint' && cps[last].status === 'pending') {
    const newFinal = tpPrices[last];
    if (Math.abs(newFinal - pos.tp) > tol) {
      finalTp = newFinal;
      brokerTpChanged = true;
    }
  }
  if (slChanged || brokerTpChanged) {
    await broker.modifyPosition(ticket, finalSl, finalTp);
  }

  const newCps = cps.map((cp, i) => (tpPrices && cp.status === 'pending' ? { ...cp, price: tpPrices[i] } : cp));
  const priceByIndex = new Map(newCps.map((cp) => [cp.tp_index, cp.price] as const));
  const newPlan: TradePlan = {
    ...plan,
    broker_tp: brokerTpChanged ? finalTp : plan.broker_tp,
    checkpoints: plan.checkpoints.map((pc) => ({ ...pc, price: priceByIndex.get(pc.tpIndex) ?? pc.price })),
  };
  const newLifecycle: TradeLifecycle = {
    ...lifecycle,
    checkpoints: newCps,
    current_sl: finalSl,
    current_tp: finalTp,
  };
  return {
    applied: true,
    reasons,
    state,
    patch: { plan: newPlan, lifecycle: newLifecycle },
    slChanged,
  };
}

// ---------------------------------------------------------------------------
// Cancels
// ---------------------------------------------------------------------------

type CancelReason = 'unparseable_edit' | 'explicit_cancel';

/** What the frozen profile allows for this cancel reason. Without a snapshot nothing is allowed. */
function cancelPolicy(snapshot: ExecutionProfile | null, reason: CancelReason): { cancelPending: boolean; closeOpen: boolean } {
  if (!snapshot) return { cancelPending: false, closeOpen: false };
  if (reason === 'unparseable_edit') {
    return { cancelPending: snapshot.edits.unparseable_edit === 'cancel_pending_only', closeOpen: false };
  }
  return {
    cancelPending: snapshot.edits.explicit_cancel !== 'ignore',
    closeOpen: snapshot.edits.explicit_cancel === 'close_position',
  };
}

async function handleCancel(ev: SignalEventInput): Promise<HandleResult> {
  const tradeSetId = tradeSetIdFor(ev.chatId, ev.messageId);
  const existing = await getTradeSet(tradeSetId);
  if (!existing) {
    await audit('info', 'cancel_without_trade_set', { tradeSetId, eventId: ev.eventId });
    return { outcome: 'noop', reason: 'no_trade_set' };
  }
  if (existing.schema !== 2) return { outcome: 'noop', reason: 'legacy_trade_set' };
  if (existing.mode !== 'paper' && existing.mode !== 'demo' && existing.mode !== 'live') {
    return { outcome: 'noop', state: existing.state, reason: 'mode_disabled' };
  }

  // An unlabelled cancel is treated as the least destructive kind: it never closes a position.
  const reason: CancelReason = ev.cancelReason ?? 'unparseable_edit';
  if (ev.cancelReason === undefined) {
    await audit('warn', 'cancel_reason_missing', { tradeSetId, eventId: ev.eventId, treatedAs: reason });
  }

  const policy = cancelPolicy(existing.profile_snapshot, reason);
  const state = existing.state;
  if (state === 'PENDING_ORDER') {
    if (!policy.cancelPending) return cancelIgnored(existing, reason, 'policy_keeps_pending_order');
    return cancelPendingOrder(existing, ev, reason);
  }
  if (state === 'OPEN' || state === 'PARTIALLY_CLOSED') {
    if (!policy.closeOpen) return cancelIgnored(existing, reason, 'policy_keeps_open_position');
    return closeForCancel(existing, ev, reason);
  }
  if (state === 'CLAIMED' || state === 'SUBMITTING' || state === 'SUBMIT_UNKNOWN') {
    // Resolution happens after the in-flight send is known: the reconciler applies cancel_requested.
    if (existing.profile_snapshot && !policy.cancelPending && !policy.closeOpen) {
      return cancelIgnored(existing, reason, 'policy_ignores_cancel');
    }
    return requestCancel(existing, ev, reason);
  }
  return { outcome: 'noop', state, reason: `no_open_trade_in_${state}` };
}

async function cancelIgnored(existing: TradeSetDoc, reason: CancelReason, why: string): Promise<HandleResult> {
  await audit('info', 'cancel_ignored', { tradeSetId: existing.trade_set_id, reason, why, state: existing.state });
  return { outcome: 'cancel', state: existing.state, reason: why };
}

async function requestCancel(existing: TradeSetDoc, ev: SignalEventInput, reason: CancelReason): Promise<HandleResult> {
  const tradeSetId = existing.trade_set_id;
  try {
    await updateTradeSet(tradeSetId, {
      cancel_requested: { reason, at: new Date().toISOString(), event_id: ev.eventId },
    });
  } catch (err) {
    return transientRetry(tradeSetId, 'cancel_request_write_failed', err);
  }
  await tradeEvent(tradeSetId, existing.mode, `cancel_${ev.eventId}`, 'cancel_requested', {
    reasonCode: reason,
    details: { event_id: ev.eventId, state: existing.state },
  });
  await audit('info', 'cancel_requested', { tradeSetId, reason, state: existing.state });
  return { outcome: 'cancel', state: existing.state, reason: 'cancel_requested' };
}

async function cancelPendingOrder(existing: TradeSetDoc, ev: SignalEventInput, reason: CancelReason): Promise<HandleResult> {
  const tradeSetId = existing.trade_set_id;
  const mode = existing.mode;
  const ticket = existing.broker_refs?.order_ticket;
  if (!ticket) return { outcome: 'cancel', state: existing.state, reason: 'no_pending_order_ref' };
  if (mode !== 'paper' && mode !== 'demo' && mode !== 'live') return { outcome: 'noop', reason: 'mode_disabled' };

  const broker = await getBroker(mode);
  try {
    await broker.cancelOrder(ticket);
  } catch (err) {
    if (err instanceof BrokerAmbiguousError) {
      await recordTradeError(tradeSetId, mode, 'cancel_ambiguous', errorMessage(err), ev.eventId);
      return { outcome: 'cancel', state: existing.state, reason: 'cancel_ambiguous' };
    }
    if (err instanceof BrokerRejectedError) {
      // Often the order already filled or expired. The lifecycle manager resolves that from broker state.
      await recordTradeError(tradeSetId, mode, 'cancel_rejected', errorMessage(err), ev.eventId);
      return { outcome: 'cancel', state: existing.state, reason: 'cancel_rejected' };
    }
    throw err;
  }

  const moved = await tryTransition(tradeSetId, ['PENDING_ORDER'], { state: 'CANCELLED' });
  if (!moved) await audit('warn', 'cancel_state_not_recorded', { tradeSetId, ticket });
  await tradeEvent(tradeSetId, mode, 'pending_order_cancelled', 'pending_order_cancelled', {
    orderTicket: ticket,
    reasonCode: reason,
    details: { event_id: ev.eventId },
  });
  await audit('info', 'pending_order_cancelled', { tradeSetId, orderTicket: ticket, reason });
  return { outcome: 'cancel', state: 'CANCELLED', reason };
}

async function closeForCancel(existing: TradeSetDoc, ev: SignalEventInput, reason: CancelReason): Promise<HandleResult> {
  const tradeSetId = existing.trade_set_id;
  const mode = existing.mode;
  const lifecycle = existing.lifecycle;
  const ticket = existing.broker_refs?.position_ticket;
  if (!ticket || !lifecycle) return { outcome: 'cancel', state: existing.state, reason: 'no_position_ref' };
  if (mode !== 'paper' && mode !== 'demo' && mode !== 'live') return { outcome: 'noop', reason: 'mode_disabled' };

  const broker = await getBroker(mode);
  const pos = (await broker.getPositions(existing.broker_symbol ?? undefined)).find((x) => x.ticket === ticket);
  if (!pos) return { outcome: 'cancel', state: existing.state, reason: 'position_not_found' };

  let close: CloseResult;
  try {
    close = await broker.closePosition(ticket);
  } catch (err) {
    if (err instanceof BrokerAmbiguousError) {
      await recordTradeError(tradeSetId, mode, 'cancel_ambiguous', errorMessage(err), ev.eventId);
      return { outcome: 'cancel', state: existing.state, reason: 'cancel_ambiguous' };
    }
    if (err instanceof BrokerRejectedError) {
      await recordTradeError(tradeSetId, mode, 'close_rejected', errorMessage(err), ev.eventId);
      return { outcome: 'cancel', state: existing.state, reason: 'close_rejected' };
    }
    throw err;
  }

  const pnl = await realizedPnl(broker, ticket, existing.submission?.submitted_at);
  const closedAt = new Date().toISOString();
  const moved = await tryTransition(tradeSetId, ['OPEN', 'PARTIALLY_CLOSED'], {
    state: 'CLOSED',
    result: { closed_at: closedAt, close_reason: 'cancel', realized_pnl: pnl.value },
    lifecycle: { ...lifecycle, current_volume: 0 },
  });
  if (!moved) await audit('warn', 'close_state_not_recorded', { tradeSetId, positionTicket: ticket });
  await tradeEvent(tradeSetId, mode, 'position_closed', 'position_closed', {
    positionTicket: ticket,
    dealTicket: close.dealTicket,
    volume: close.closedVolume,
    price: close.price,
    realizedPnl: pnl.value,
    retcode: close.retcode,
    reasonCode: reason,
    details: { event_id: ev.eventId, pnl_verified: pnl.verified },
  });
  await audit('info', 'position_closed_by_cancel', {
    tradeSetId,
    positionTicket: ticket,
    realizedPnl: pnl.value,
    pnlVerified: pnl.verified,
    reason,
  });
  return { outcome: 'cancel', state: 'CLOSED', reason };
}

/** Sum of closing deals for the position since the entry was submitted. Never throws. */
async function realizedPnl(
  broker: BrokerAdapter,
  positionTicket: number,
  submittedAt: string | undefined,
): Promise<{ value: number; verified: boolean }> {
  try {
    const submittedMs = submittedAt ? Date.parse(submittedAt) : NaN;
    const fromSec = Number.isFinite(submittedMs) ? Math.floor(submittedMs / 1000) - 60 : 0;
    const deals = await broker.getDeals({ fromSec, positionId: positionTicket });
    const value = deals
      .filter((d) => d.positionId === positionTicket && (d.entry === 'OUT' || d.entry === 'OUT_BY' || d.entry === 'INOUT'))
      .reduce((sum, d) => sum + d.profit + d.commission + d.swap + d.fee, 0);
    return { value, verified: true };
  } catch {
    return { value: 0, verified: false };
  }
}

// ---------------------------------------------------------------------------
// Legacy adapters. Still named by telegramListener.forward.test.ts; new code
// calls handleSignalEvent. The event id is derived from the message id, so
// these do not match the signal_events document id.
// ---------------------------------------------------------------------------

export interface GoldSignalContext {
  chatId: string;
  messageId: string;
  messageDate?: Date | null;
  signal: GoldSignal;
}

export async function handleGoldSignal(context: GoldSignalContext): Promise<void> {
  await handleSignalEvent({
    eventId: `${context.chatId}_${context.messageId}_legacy`,
    chatId: context.chatId,
    messageId: context.messageId,
    messageDate: context.messageDate ? context.messageDate.toISOString() : null,
    messageType: 'new',
    kind: 'signal',
    signal: context.signal,
  });
}

export async function cancelGoldTrade(chatId: string, messageId: string): Promise<void> {
  await handleSignalEvent({
    eventId: `${chatId}_${messageId}_legacy_cancel`,
    chatId,
    messageId,
    messageDate: null,
    messageType: 'edit',
    kind: 'cancel',
    signal: null,
    cancelReason: 'explicit_cancel',
  });
}
