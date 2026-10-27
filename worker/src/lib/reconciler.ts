/**
 * reconciler.ts
 *
 * Resolves trade sets whose outcome the worker could not observe directly
 * (contracts §7). Runs once at startup and then every 15 s:
 *   - SUBMIT_UNKNOWN past its expiry (+5 s): search the broker by correlation
 *     comment and move the set to OPEN, PENDING_ORDER, CLOSED or REJECTED.
 *     Only a successful broker read can conclude "not found".
 *   - SUBMITTING older than 120 s: the process died mid-send, so it becomes
 *     SUBMIT_UNKNOWN. CLAIMED older than 5 min becomes ERROR.
 *   - cancel_requested: applied per the trade's profile_snapshot edits.
 *   - OPEN / PARTIALLY_CLOSED: a position volume lower than the lifecycle expects,
 *     and not explained by a checkpoint, updates lifecycle.current_volume.
 *   - Orphans: EA-magic positions and orders that no trade set references are
 *     logged once per ticket per process and never touched.
 * A failed broker read skips that mode and changes no state.
 *
 * Alerts (alerts.ts): a SUBMIT_UNKNOWN still unresolved 5 min after expiry is
 * escalated to critical and resolved when the set leaves SUBMIT_UNKNOWN; three
 * consecutive failed passes for a mode (or of the trade listing) raise
 * reconciliation_failed; orphans raise unknown_position until they disappear.
 */

import { raiseAlert, resolveAlert } from './alerts';
import { getBroker, type BrokerMode } from './brokerRouter';
import { getCachedGmtSkewSec } from './mt5Client';
import type { BrokerAdapter, BrokerDeal, BrokerOrder, BrokerPosition, SymbolInfo } from './brokerTypes';
import { getExecutionControl } from './executionControl';
import { logger } from './logger';
import { classifyCloseReason, fillCheckpoints, lastExitDeal, realizedPnlFromDeals } from './lifecycleRules';
import { volumeDecimals } from './positionSizing';
import { writeSystemLog } from './systemLog';
import { recordTradeEvent } from './tradeEvents';
import type { TradeEventInput } from './tradeSetTypes';
import type { TradeLifecycle, TradeResult, TradeSetDoc, TradeState } from './tradeSetTypes';
import { listTradeSetsByState, transitionTradeSet, updateTradeSet } from './tradeSetStore';

const RECONCILED_STATES: readonly TradeState[] = [
  'CLAIMED',
  'SUBMITTING',
  'SUBMIT_UNKNOWN',
  'PENDING_ORDER',
  'OPEN',
  'PARTIALLY_CLOSED',
];
/** States where a cancel_requested can act. Unresolved submissions wait for resolution first. */
const CANCELLABLE_STATES: readonly TradeState[] = ['PENDING_ORDER', 'OPEN', 'PARTIALLY_CLOSED'];
const DEFAULT_INTERVAL_MS = 15_000;
const CLAIM_STALE_SEC = 300;
const SUBMITTING_STALE_SEC = 120;
const RESOLVE_GRACE_SEC = 5;
const LOOKBACK_SEC = 60;
const EPS = 1e-9;
const UNKNOWN_ESCALATE_SEC = 300;
const FAILURES_BEFORE_ALERT = 3;

export interface ReconcileSummary {
  checked: number;
  staleClaims: number;
  staleSubmitting: number;
  resolved: number;
  rejected: number;
  cancelsApplied: number;
  volumeUpdates: number;
  orphans: number;
  skippedModes: string[];
  errors: number;
}

/** A broker's state as read at the start of one mode's pass. Deals are fetched lazily. */
interface ModeView {
  mode: BrokerMode;
  broker: BrokerAdapter;
  positions: BrokerPosition[];
  orders: BrokerOrder[];
  deals?: BrokerDeal[];
  dealsFrom?: number;
  symbols: Map<string, SymbolInfo | Error>;
}

/** Tickets and comments that some trade set references, for orphan detection. */
interface Links {
  positions: Map<BrokerMode, Set<number>>;
  orders: Map<BrokerMode, Set<number>>;
  comments: Set<string>;
}

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const orphansSeen = new Set<string>();
const modeDown = new Set<BrokerMode>();
/** Consecutive failed passes per scope ('list' or a mode). */
const failureStreak = new Map<string, number>();
/** Orphan alert subjects raised by this process, per mode, so they can be resolved when the ticket is gone. */
const orphanAlerts = new Map<BrokerMode, Set<string>>();

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

function isManagedMode(mode: string | null | undefined): mode is BrokerMode {
  return mode === 'paper' || mode === 'demo' || mode === 'live';
}

function isoToSec(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function lookbackFrom(trade: TradeSetDoc): number {
  return (isoToSec(trade.created_at) ?? 0) - LOOKBACK_SEC;
}

/** When the EA stops accepting the submitted request. Falls back to created_at + 8 s without a submission record. */
function expiresAtOf(trade: TradeSetDoc): number {
  return trade.submission?.expires_at ?? (isoToSec(trade.created_at) ?? 0) + 8;
}

async function notify(level: 'info' | 'warn' | 'error', event: string, details: Record<string, unknown>): Promise<void> {
  logger[level](event, details);
  await writeSystemLog(level, 'reconciler', event, details);
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

function emptySummary(checked: number): ReconcileSummary {
  return {
    checked,
    staleClaims: 0,
    staleSubmitting: 0,
    resolved: 0,
    rejected: 0,
    cancelsApplied: 0,
    volumeUpdates: 0,
    orphans: 0,
    skippedModes: [],
    errors: 0,
  };
}

// ---------------------------------------------------------------------------
// Broker reads
// ---------------------------------------------------------------------------

async function readMode(mode: BrokerMode): Promise<ModeView> {
  const broker = await getBroker(mode);
  const [positions, orders] = await Promise.all([broker.getPositions(), broker.getOrders()]);
  if (modeDown.delete(mode)) {
    await notify('info', 'reconciler_mode_recovered', { mode });
  }
  return { mode, broker, positions, orders, symbols: new Map() };
}

/** Deals from `fromSec` onward. Reuses the cached list when it already covers that window. */
async function dealsSince(view: ModeView, fromSec: number): Promise<BrokerDeal[]> {
  if (!view.deals || view.dealsFrom === undefined || fromSec < view.dealsFrom) {
    view.deals = await view.broker.getDeals({ fromSec });
    view.dealsFrom = fromSec;
  }
  return view.deals;
}

async function symbolFor(view: ModeView, symbol: string | null): Promise<SymbolInfo> {
  if (!symbol) throw new Error('missing_broker_symbol');
  let info = view.symbols.get(symbol);
  if (!info) {
    try {
      info = await view.broker.getSymbolInfo(symbol);
    } catch (err) {
      info = err instanceof Error ? err : new Error(String(err));
    }
    view.symbols.set(symbol, info);
  }
  if (info instanceof Error) throw info;
  return info;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** One reconciliation pass. Never throws. */
export async function runReconciliation(): Promise<ReconcileSummary> {
  let trades: TradeSetDoc[];
  try {
    trades = await listTradeSetsByState(RECONCILED_STATES);
  } catch (err) {
    logger.warn('reconciler_list_failed', { error: errorMessage(err) });
    await recordPassFailure('list', `trade set listing failed: ${errorMessage(err)}`);
    return emptySummary(0);
  }
  await recordPassSuccess('list');
  const summary = emptySummary(trades.length);

  const live: TradeSetDoc[] = [];
  for (const trade of trades) {
    try {
      live.push(await applyStaleRules(trade, summary));
    } catch (err) {
      summary.errors++;
      logger.warn('reconciler_trade_failed', { trade_set_id: trade.trade_set_id, error: errorMessage(err) });
      live.push(trade);
    }
  }

  const groups = new Map<BrokerMode, TradeSetDoc[]>();
  for (const trade of live) {
    if (!isManagedMode(trade.mode)) continue;
    const list = groups.get(trade.mode) ?? [];
    list.push(trade);
    groups.set(trade.mode, list);
  }

  const modes = new Set<BrokerMode>(groups.keys());
  const control = await getExecutionControl().catch(() => null);
  if (control && isManagedMode(control.mode)) modes.add(control.mode);

  const links = buildLinks(live);
  for (const mode of modes) {
    await reconcileMode(mode, groups.get(mode) ?? [], links, summary);
  }
  await escalateUnresolved(groups);
  return summary;
}

async function recordPassFailure(scope: string, message: string): Promise<void> {
  const streak = (failureStreak.get(scope) ?? 0) + 1;
  failureStreak.set(scope, streak);
  if (streak < FAILURES_BEFORE_ALERT) return;
  await raiseAlert({
    type: 'reconciliation_failed',
    subject: scope,
    severity: 'error',
    source: 'autotrader',
    title: scope === 'list' ? 'Reconciliation cannot read trade sets' : `Reconciliation cannot read ${scope} broker state`,
    message: `${streak} consecutive reconciliation passes failed: ${message}`,
    details: { scope, consecutive_failures: streak },
  });
}

async function recordPassSuccess(scope: string): Promise<void> {
  if ((failureStreak.get(scope) ?? 0) === 0) return;
  failureStreak.set(scope, 0);
  await resolveAlert('reconciliation_failed', scope, 'pass_succeeded');
}

/** SUBMIT_UNKNOWN sets still unresolved well after expiry (for example while the bridge is down) become critical. */
async function escalateUnresolved(groups: Map<BrokerMode, TradeSetDoc[]>): Promise<void> {
  const now = nowSec();
  for (const trades of groups.values()) {
    for (const trade of trades) {
      if (trade.state !== 'SUBMIT_UNKNOWN') continue;
      const overdue = now - expiresAtOf(trade);
      if (overdue < UNKNOWN_ESCALATE_SEC) continue;
      await raiseAlert({
        type: 'submit_unknown',
        subject: trade.trade_set_id,
        severity: 'critical',
        source: 'autotrader',
        title: 'Entry outcome still unknown',
        message: `Trade set ${trade.trade_set_id} (${trade.mode}) has been SUBMIT_UNKNOWN for ${Math.round(overdue / 60)} min after its request expired. Look for comment ${trade.correlation_comment} in MT5.`,
        details: { trade_set_id: trade.trade_set_id, mode: trade.mode, correlation_comment: trade.correlation_comment },
      });
    }
  }
}

function buildLinks(trades: TradeSetDoc[]): Links {
  const links: Links = { positions: new Map(), orders: new Map(), comments: new Set() };
  for (const trade of trades) {
    links.comments.add(trade.correlation_comment);
    if (!isManagedMode(trade.mode) || !trade.broker_refs) continue;
    linkTicket(links.positions, trade.mode, trade.broker_refs.position_ticket);
    linkTicket(links.orders, trade.mode, trade.broker_refs.order_ticket);
  }
  return links;
}

function linkTicket(map: Map<BrokerMode, Set<number>>, mode: BrokerMode, ticket: number): void {
  if (!(ticket > 0)) return;
  const set = map.get(mode) ?? new Set<number>();
  set.add(ticket);
  map.set(mode, set);
}

/** Stale CLAIMED -> ERROR and SUBMITTING -> SUBMIT_UNKNOWN. Broker-independent. */
async function applyStaleRules(trade: TradeSetDoc, summary: ReconcileSummary): Promise<TradeSetDoc> {
  const now = nowSec();
  if (trade.state === 'CLAIMED') {
    const claimed = isoToSec(trade.claim?.claimed_at);
    if (claimed === null || now - claimed <= CLAIM_STALE_SEC) return trade;
    const moved = await transitionTradeSet(trade.trade_set_id, ['CLAIMED'], { state: 'ERROR', error: 'stale_claim' });
    if (!moved) return trade;
    summary.staleClaims++;
    await emit(trade, {
      eventKey: 'stale_claim',
      type: 'execution_error',
      reasonCode: 'stale_claim',
      message: 'claim older than 5 minutes; nothing was sent',
    });
    await notify('warn', 'reconciler_stale_claim', { trade_set_id: trade.trade_set_id });
    return { ...trade, state: 'ERROR', error: 'stale_claim' };
  }

  if (trade.state === 'SUBMITTING') {
    const since = isoToSec(trade.submission?.submitted_at ?? trade.claim?.claimed_at);
    if (since === null || now - since <= SUBMITTING_STALE_SEC) return trade;
    const moved = await transitionTradeSet(trade.trade_set_id, ['SUBMITTING'], { state: 'SUBMIT_UNKNOWN' });
    if (!moved) return trade;
    summary.staleSubmitting++;
    await emit(trade, {
      eventKey: 'entry_unknown_stale_submitting',
      type: 'entry_unknown',
      reasonCode: 'stale_submitting',
      message: 'submission older than 2 minutes; outcome resolved from the broker after expiry',
    });
    await notify('warn', 'reconciler_stale_submitting', { trade_set_id: trade.trade_set_id });
    await raiseAlert({
      type: 'submit_unknown',
      subject: trade.trade_set_id,
      severity: 'error',
      source: 'autotrader',
      title: 'Entry interrupted mid-send',
      message: `Trade set ${trade.trade_set_id} stayed SUBMITTING for over ${SUBMITTING_STALE_SEC} s (the process probably stopped mid-send). It is resolved from broker state; nothing is resent.`,
      details: { trade_set_id: trade.trade_set_id, mode: trade.mode, correlation_comment: trade.correlation_comment },
    });
    return { ...trade, state: 'SUBMIT_UNKNOWN' };
  }

  return trade;
}

async function reconcileMode(
  mode: BrokerMode,
  trades: TradeSetDoc[],
  links: Links,
  summary: ReconcileSummary,
): Promise<void> {
  let view: ModeView;
  try {
    view = await readMode(mode);
  } catch (err) {
    summary.skippedModes.push(mode);
    if (!modeDown.has(mode)) {
      modeDown.add(mode);
      await notify('warn', 'reconciler_mode_skipped', { mode, error: errorMessage(err) });
    } else {
      logger.warn('reconciler_mode_skipped', { mode, error: errorMessage(err) });
    }
    await recordPassFailure(mode, errorMessage(err));
    return;
  }
  await recordPassSuccess(mode);

  for (const listed of trades) {
    let trade = listed;
    try {
      if (trade.state === 'SUBMIT_UNKNOWN') {
        trade = await resolveUnknown(view, trade, links, summary);
        if (trade.state !== 'SUBMIT_UNKNOWN') {
          await resolveAlert('submit_unknown', trade.trade_set_id, `resolved_${trade.state.toLowerCase()}`);
        }
      }
      if (trade.close_requested_by === 'close_all') {
        trade = await applyCloseAll(view, trade);
      }
      if (trade.cancel_requested && CANCELLABLE_STATES.includes(trade.state)) {
        await applyCancelRequest(view, trade, summary);
      }
      if (listed.state === 'OPEN' || listed.state === 'PARTIALLY_CLOSED') {
        await checkVolume(view, listed, summary);
      }
    } catch (err) {
      summary.errors++;
      logger.warn('reconciler_trade_failed', { trade_set_id: trade.trade_set_id, mode, error: errorMessage(err) });
    }
  }

  await reportOrphans(view, links, summary);
}

// ---------------------------------------------------------------------------
// SUBMIT_UNKNOWN resolution
// ---------------------------------------------------------------------------

/**
 * Searches the broker for the trade's correlation comment once the request can
 * no longer execute. A read failure throws, so nothing is concluded from missing data.
 */
async function resolveUnknown(
  view: ModeView,
  trade: TradeSetDoc,
  links: Links,
  summary: ReconcileSummary,
): Promise<TradeSetDoc> {
  // The EA judges expires_at on its own clock; when it runs behind ours, wait for that too.
  const skew = view.broker.kind === 'mt5' ? (getCachedGmtSkewSec() ?? 0) : 0;
  if (nowSec() <= expiresAtOf(trade) + RESOLVE_GRACE_SEC + Math.max(0, -skew)) return trade;
  if (!trade.lifecycle) throw new Error('missing_lifecycle');

  const cc = trade.correlation_comment;
  const deals = await dealsSince(view, lookbackFrom(trade));
  const pos = view.positions.find((p) => p.comment === cc);

  if (pos) {
    const inDeal = deals.find((d) => d.entry === 'IN' && d.positionId === pos.ticket);
    const brokerRefs = {
      order_ticket: inDeal?.order ?? 0,
      position_ticket: pos.ticket,
      deal_ticket: inDeal?.ticket ?? 0,
      fill_price: inDeal?.price ?? pos.openPrice,
      filled_volume: pos.volume,
    };
    const sym = await symbolFor(view, trade.broker_symbol);
    const fitted = trade.profile_snapshot
      ? fillCheckpoints({
          plannedVolume: trade.plan?.volume,
          direction: trade.direction,
          entryPrice: brokerRefs.fill_price,
          filledVolume: pos.volume,
          profile: trade.profile_snapshot,
          spec: sym,
          checkpoints: trade.lifecycle.checkpoints,
        })
      : trade.lifecycle.checkpoints;
    const lifecycle: TradeLifecycle = {
      ...clone(trade.lifecycle),
      checkpoints: fitted ?? trade.lifecycle.checkpoints,
      current_volume: pos.volume,
    };
    const moved = await transitionTradeSet(trade.trade_set_id, ['SUBMIT_UNKNOWN'], {
      state: 'OPEN',
      broker_refs: brokerRefs,
      lifecycle,
    });
    if (!moved) return trade;
    summary.resolved++;
    linkTicket(links.positions, trade.mode as BrokerMode, pos.ticket);
    if (fitted === null) {
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
      eventKey: 'entry_confirmed',
      type: 'entry_confirmed',
      positionTicket: pos.ticket,
      dealTicket: brokerRefs.deal_ticket || undefined,
      volume: pos.volume,
      price: brokerRefs.fill_price,
      details: { source: 'reconciler' },
    });
    await emit(trade, {
      eventKey: 'reconciliation_submit_unknown_resolved',
      type: 'reconciliation',
      positionTicket: pos.ticket,
      reasonCode: 'open_position_found',
      details: { previous_state: 'SUBMIT_UNKNOWN', new_state: 'OPEN' },
    });
    await notify('info', 'reconciler_entry_open', { trade_set_id: trade.trade_set_id, position_ticket: pos.ticket });
    return { ...trade, state: 'OPEN', broker_refs: brokerRefs, lifecycle };
  }

  const order = view.orders.find((o) => o.comment === cc);
  if (order) {
    const brokerRefs = { order_ticket: order.ticket, position_ticket: 0, deal_ticket: 0, fill_price: 0, filled_volume: 0 };
    const moved = await transitionTradeSet(trade.trade_set_id, ['SUBMIT_UNKNOWN'], {
      state: 'PENDING_ORDER',
      broker_refs: brokerRefs,
    });
    if (!moved) return trade;
    summary.resolved++;
    linkTicket(links.orders, trade.mode as BrokerMode, order.ticket);
    await emit(trade, {
      eventKey: 'pending_order_placed',
      type: 'pending_order_placed',
      orderTicket: order.ticket,
      price: order.priceOpen,
      volume: order.volumeInitial,
      details: { source: 'reconciler' },
    });
    await emit(trade, {
      eventKey: 'reconciliation_submit_unknown_resolved',
      type: 'reconciliation',
      orderTicket: order.ticket,
      reasonCode: 'pending_order_found',
      details: { previous_state: 'SUBMIT_UNKNOWN', new_state: 'PENDING_ORDER' },
    });
    await notify('info', 'reconciler_entry_pending', { trade_set_id: trade.trade_set_id, order_ticket: order.ticket });
    return { ...trade, state: 'PENDING_ORDER', broker_refs: brokerRefs };
  }

  const inDeal = deals.find((d) => d.entry === 'IN' && d.comment === cc);
  if (inDeal) {
    const exits = deals.filter((d) => d.positionId === inDeal.positionId);
    const closeReason: TradeResult['close_reason'] = lastExitDeal(exits) ? classifyCloseReason(exits) : 'unknown';
    const realized = realizedPnlFromDeals(exits);
    const brokerRefs = {
      order_ticket: inDeal.order,
      position_ticket: inDeal.positionId,
      deal_ticket: inDeal.ticket,
      fill_price: inDeal.price,
      filled_volume: inDeal.volume,
    };
    const lifecycle: TradeLifecycle = { ...clone(trade.lifecycle), current_volume: 0 };
    const moved = await transitionTradeSet(trade.trade_set_id, ['SUBMIT_UNKNOWN'], {
      state: 'CLOSED',
      broker_refs: brokerRefs,
      lifecycle,
      result: { closed_at: isoNow(), close_reason: closeReason, realized_pnl: realized },
    });
    if (!moved) return trade;
    summary.resolved++;
    linkTicket(links.positions, trade.mode as BrokerMode, inDeal.positionId);
    await emit(trade, {
      eventKey: 'entry_confirmed',
      type: 'entry_confirmed',
      positionTicket: inDeal.positionId,
      dealTicket: inDeal.ticket,
      price: inDeal.price,
      details: { source: 'reconciler' },
    });
    await emit(trade, {
      eventKey: 'position_closed',
      type: 'position_closed',
      positionTicket: inDeal.positionId,
      realizedPnl: realized,
      reasonCode: closeReason,
    });
    await emit(trade, {
      eventKey: 'reconciliation_submit_unknown_resolved',
      type: 'reconciliation',
      positionTicket: inDeal.positionId,
      reasonCode: 'closed_position_found',
      details: { previous_state: 'SUBMIT_UNKNOWN', new_state: 'CLOSED' },
    });
    await notify('info', 'reconciler_entry_closed', {
      trade_set_id: trade.trade_set_id,
      position_ticket: inDeal.positionId,
      close_reason: closeReason,
    });
    return { ...trade, state: 'CLOSED', broker_refs: brokerRefs, lifecycle, result: { closed_at: isoNow(), close_reason: closeReason, realized_pnl: realized } };
  }

  // Before concluding "never executed": an unlinked EA position, order or entry deal on the same
  // symbol and side, opened inside the submission window, may be this entry with an altered comment.
  // It is never linked automatically; the trade stays SUBMIT_UNKNOWN for the operator.
  const candidates = correlationCandidates(view, trade, links, deals);
  if (candidates.length > 0) {
    await emit(trade, {
      eventKey: 'correlation_candidates',
      type: 'reconciliation',
      reasonCode: 'possible_uncorrelated_fill',
      message: `no match by comment, but ${candidates.length} unlinked candidate(s) in the submission window; left SUBMIT_UNKNOWN`,
      details: { candidates },
    });
    await raiseAlert({
      type: 'correlation_mismatch',
      subject: trade.trade_set_id,
      severity: 'critical',
      source: 'autotrader',
      title: 'Entry outcome unknown: possible fill without its comment',
      message: `${trade.trade_set_id}: nothing carries comment ${trade.correlation_comment}, but ${candidates
        .map((c) => `${c.kind} ${c.ticket}`)
        .join(', ')} (EA magic, ${trade.broker_symbol}, same side) appeared in the submission window. It is not linked or touched automatically.`,
      action:
        'Inspect the listed tickets in MT5. If one is this entry, manage or close it manually; then resolve the trade set from the Trades page. Keep execution disabled until comment handling is verified (VANTAGE_BROKER_ASSUMPTIONS.md).',
      details: { trade_set_id: trade.trade_set_id, candidates },
    });
    return trade;
  }

  // The request expired and no trace of it exists, so it never executed.
  const moved = await transitionTradeSet(trade.trade_set_id, ['SUBMIT_UNKNOWN'], {
    state: 'REJECTED',
    error: 'not_found_after_expiry',
  });
  if (!moved) return trade;
  summary.rejected++;
  await emit(trade, {
    eventKey: 'entry_rejected_not_found_after_expiry',
    type: 'entry_rejected',
    reasonCode: 'not_found_after_expiry',
    message: 'no position, order or deal with the correlation comment after the request expired',
  });
  await emit(trade, {
    eventKey: 'reconciliation_submit_unknown_resolved',
    type: 'reconciliation',
    reasonCode: 'not_found_after_expiry',
    details: { previous_state: 'SUBMIT_UNKNOWN', new_state: 'REJECTED' },
  });
  await notify('warn', 'reconciler_entry_rejected', {
    trade_set_id: trade.trade_set_id,
    reason: 'not_found_after_expiry',
  });
  return { ...trade, state: 'REJECTED', error: 'not_found_after_expiry' };
}

interface CorrelationCandidate {
  kind: 'position' | 'order' | 'deal';
  ticket: number;
  volume: number;
  time: number;
  comment: string;
}

/** Unlinked EA-magic activity on the trade's symbol and side inside [submitted - 10 s, expiry + 60 s]. */
function correlationCandidates(view: ModeView, trade: TradeSetDoc, links: Links, deals: BrokerDeal[]): CorrelationCandidate[] {
  const symbol = trade.broker_symbol;
  if (!symbol) return [];
  const from = (isoToSec(trade.submission?.submitted_at) ?? isoToSec(trade.created_at) ?? 0) - 10;
  const to = expiresAtOf(trade) + 60;
  const side = trade.direction === 'buy' ? 'BUY' : 'SELL';
  const inWindow = (t: number): boolean => t >= from && t <= to;
  const linkedPos = links.positions.get(view.mode);
  const linkedOrd = links.orders.get(view.mode);
  const out: CorrelationCandidate[] = [];
  for (const p of view.positions) {
    if (p.magic !== view.broker.magic || p.symbol !== symbol || p.type !== side) continue;
    if (linkedPos?.has(p.ticket) || links.comments.has(p.comment) || !inWindow(p.timeOpen)) continue;
    out.push({ kind: 'position', ticket: p.ticket, volume: p.volume, time: p.timeOpen, comment: p.comment });
  }
  for (const o of view.orders) {
    if (o.magic !== view.broker.magic || o.symbol !== symbol || !o.type.startsWith(side)) continue;
    if (linkedOrd?.has(o.ticket) || links.comments.has(o.comment) || !inWindow(o.timeSetup)) continue;
    out.push({ kind: 'order', ticket: o.ticket, volume: o.volumeInitial, time: o.timeSetup, comment: o.comment });
  }
  for (const d of deals) {
    if (d.entry !== 'IN' || d.magic !== view.broker.magic || d.symbol !== symbol || d.type !== side) continue;
    if (linkedPos?.has(d.positionId) || links.comments.has(d.comment) || !inWindow(d.time)) continue;
    if (out.some((c) => c.kind === 'position' && c.ticket === d.positionId)) continue;
    out.push({ kind: 'deal', ticket: d.ticket, volume: d.volume, time: d.time, comment: d.comment });
  }
  return out;
}

// ---------------------------------------------------------------------------
// cancel_requested
// ---------------------------------------------------------------------------

/**
 * Applies a cancel that arrived while the entry was unresolved. Pending orders
 * are cancelled and open positions closed only when the trade's profile allows
 * it. Anything else is recorded as ignored.
 */
async function applyCancelRequest(view: ModeView, trade: TradeSetDoc, summary: ReconcileSummary): Promise<void> {
  const req = trade.cancel_requested;
  if (!req) return;
  const edits = trade.profile_snapshot?.edits;
  const ref = trade.broker_refs;

  const ignore = async (): Promise<void> => {
    await emit(trade, {
      eventKey: `cancel_ignored_${req.reason}`,
      type: 'signal_revision_ignored',
      reasonCode: 'cancel_not_applicable',
      message: `cancel (${req.reason}) not applied for state ${trade.state} under the profile edits`,
    });
  };

  if (trade.state === 'PENDING_ORDER') {
    const allowed =
      req.reason === 'unparseable_edit'
        ? edits?.unparseable_edit === 'cancel_pending_only'
        : edits?.explicit_cancel === 'cancel_pending_only' || edits?.explicit_cancel === 'close_position';
    if (!allowed) return ignore();
    const order = ref ? view.orders.find((o) => o.ticket === ref.order_ticket && o.magic === view.broker.magic) : undefined;
    if (!order) return;
    try {
      await view.broker.cancelOrder(order.ticket);
    } catch (err) {
      logger.warn('reconciler_cancel_order_failed', { trade_set_id: trade.trade_set_id, error: errorMessage(err) });
      return;
    }
    const moved = await transitionTradeSet(trade.trade_set_id, ['PENDING_ORDER'], { state: 'CANCELLED' });
    if (!moved) return;
    summary.cancelsApplied++;
    await emit(trade, {
      eventKey: 'pending_order_cancelled',
      type: 'pending_order_cancelled',
      orderTicket: order.ticket,
      reasonCode: `cancel_requested_${req.reason}`,
    });
    await emit(trade, { eventKey: 'cancel_applied', type: 'cancel_requested', orderTicket: order.ticket, reasonCode: req.reason });
    await notify('info', 'reconciler_cancel_applied', { trade_set_id: trade.trade_set_id, order_ticket: order.ticket });
    return;
  }

  if (trade.state === 'OPEN' || trade.state === 'PARTIALLY_CLOSED') {
    if (!(req.reason === 'explicit_cancel' && edits?.explicit_cancel === 'close_position')) return ignore();
    const pos = ref ? view.positions.find((p) => p.ticket === ref.position_ticket && p.magic === view.broker.magic) : undefined;
    if (!pos) return;
    try {
      await view.broker.closePosition(pos.ticket);
    } catch (err) {
      logger.warn('reconciler_cancel_close_failed', { trade_set_id: trade.trade_set_id, error: errorMessage(err) });
      return;
    }
    const deals = await view.broker.getDeals({ fromSec: lookbackFrom(trade), positionId: pos.ticket }).catch(() => []);
    const realized = realizedPnlFromDeals(deals);
    const lifecycle = trade.lifecycle ? { ...clone(trade.lifecycle), current_volume: 0 } : undefined;
    const moved = await transitionTradeSet(trade.trade_set_id, ['OPEN', 'PARTIALLY_CLOSED'], {
      state: 'CLOSED',
      ...(lifecycle ? { lifecycle } : {}),
      result: { closed_at: isoNow(), close_reason: 'cancel', realized_pnl: realized },
    });
    if (!moved) return;
    summary.cancelsApplied++;
    await emit(trade, {
      eventKey: 'position_closed',
      type: 'position_closed',
      positionTicket: pos.ticket,
      realizedPnl: realized,
      reasonCode: 'cancel',
    });
    await notify('info', 'reconciler_cancel_applied', { trade_set_id: trade.trade_set_id, position_ticket: pos.ticket });
    return;
  }

  return ignore();
}

// ---------------------------------------------------------------------------
// close_requested_by = 'close_all'
// ---------------------------------------------------------------------------

/**
 * The admin close-all reached this trade while its entry was unresolved, so it
 * is closed here once the entry resolves. An open position is closed and a
 * pending order is cancelled, by the trade's own ticket. A failed action leaves
 * the trade unchanged, and the next pass retries it.
 */
async function applyCloseAll(view: ModeView, trade: TradeSetDoc): Promise<TradeSetDoc> {
  const ref = trade.broker_refs;
  if (!ref) return trade;

  if (trade.state === 'PENDING_ORDER') {
    const order = view.orders.find((o) => o.ticket === ref.order_ticket && o.magic === view.broker.magic);
    if (!order) return trade;
    try {
      await view.broker.cancelOrder(order.ticket);
    } catch (err) {
      logger.warn('reconciler_close_all_cancel_failed', { trade_set_id: trade.trade_set_id, error: errorMessage(err) });
      return trade;
    }
    const moved = await transitionTradeSet(trade.trade_set_id, ['PENDING_ORDER'], { state: 'CANCELLED' });
    if (!moved) return trade;
    await emit(trade, {
      eventKey: 'pending_order_cancelled',
      type: 'pending_order_cancelled',
      orderTicket: order.ticket,
      reasonCode: 'close_all',
    });
    await notify('info', 'reconciler_close_all_cancelled', { trade_set_id: trade.trade_set_id, order_ticket: order.ticket });
    return { ...trade, state: 'CANCELLED' };
  }

  if (trade.state === 'OPEN' || trade.state === 'PARTIALLY_CLOSED') {
    const pos = view.positions.find((p) => p.ticket === ref.position_ticket && p.magic === view.broker.magic);
    if (!pos) return trade;
    try {
      await view.broker.closePosition(pos.ticket);
    } catch (err) {
      logger.warn('reconciler_close_all_close_failed', { trade_set_id: trade.trade_set_id, error: errorMessage(err) });
      return trade;
    }
    const deals = await view.broker.getDeals({ fromSec: lookbackFrom(trade), positionId: pos.ticket }).catch(() => []);
    const realized = realizedPnlFromDeals(deals);
    const lifecycle = trade.lifecycle ? { ...clone(trade.lifecycle), current_volume: 0 } : undefined;
    const result: TradeResult = { closed_at: isoNow(), close_reason: 'close_all', realized_pnl: realized };
    const moved = await transitionTradeSet(trade.trade_set_id, ['OPEN', 'PARTIALLY_CLOSED'], {
      state: 'CLOSED',
      ...(lifecycle ? { lifecycle } : {}),
      result,
    });
    if (!moved) return trade;
    await emit(trade, {
      eventKey: 'position_closed',
      type: 'position_closed',
      positionTicket: pos.ticket,
      realizedPnl: realized,
      reasonCode: 'close_all',
    });
    await notify('info', 'reconciler_close_all_closed', { trade_set_id: trade.trade_set_id, position_ticket: pos.ticket });
    return { ...trade, state: 'CLOSED', ...(lifecycle ? { lifecycle } : {}), result };
  }

  return trade;
}

// ---------------------------------------------------------------------------
// Volume drift and orphans
// ---------------------------------------------------------------------------

/**
 * A position smaller than lifecycle.current_volume is explained when a
 * checkpoint is closing or its target matches the volume. The lifecycle manager
 * handles those. Any other reduction is recorded as an external change.
 */
async function checkVolume(view: ModeView, trade: TradeSetDoc, summary: ReconcileSummary): Promise<void> {
  if (!trade.broker_refs || !trade.lifecycle) return;
  const ticket = trade.broker_refs.position_ticket;
  const pos = view.positions.find((p) => p.ticket === ticket && p.magic === view.broker.magic);
  if (!pos) return;
  if (pos.comment !== trade.correlation_comment) {
    await raiseAlert({
      type: 'correlation_mismatch',
      subject: trade.trade_set_id,
      severity: 'critical',
      source: 'autotrader',
      title: 'Broker did not preserve the order comment',
      message: `Position ${ticket} (${trade.trade_set_id}) carries comment "${pos.comment}" instead of "${trade.correlation_comment}".`,
      details: { trade_set_id: trade.trade_set_id, position_ticket: ticket, sent: trade.correlation_comment, stored: pos.comment },
    });
  }

  const sym = await symbolFor(view, trade.broker_symbol);
  const step = sym.volumeStep;
  const lc = trade.lifecycle;
  if (pos.volume >= lc.current_volume - step / 2) return;

  const explained = lc.checkpoints.some(
    (cp) => cp.status === 'closing' || Math.abs(pos.volume - cp.target_remaining_volume) <= step / 2 + EPS,
  );
  if (explained) return;

  const previous = lc.current_volume;
  await updateTradeSet(trade.trade_set_id, { lifecycle: { current_volume: pos.volume } });
  summary.volumeUpdates++;
  await emit(trade, {
    eventKey: `external_volume_change_${pos.volume.toFixed(volumeDecimals(step))}`,
    type: 'reconciliation',
    positionTicket: ticket,
    volume: pos.volume,
    reasonCode: 'external_volume_change',
    details: { previous_volume: previous },
  });
  await notify('warn', 'reconciler_external_volume_change', {
    trade_set_id: trade.trade_set_id,
    position_ticket: ticket,
    previous_volume: previous,
    volume: pos.volume,
  });
}

/**
 * Logs EA-magic positions and orders that no trade set references (once per
 * ticket per process) and keeps an unknown_position alert open for each until
 * it disappears from the broker. Orphans are never touched.
 */
async function reportOrphans(view: ModeView, links: Links, summary: ReconcileSummary): Promise<void> {
  const linkedPos = links.positions.get(view.mode);
  const linkedOrd = links.orders.get(view.mode);
  const present = new Set<string>();

  for (const pos of view.positions) {
    if (linkedPos?.has(pos.ticket) || links.comments.has(pos.comment)) continue;
    const subject = `${view.mode}_position_${pos.ticket}`;
    present.add(subject);
    await raiseOrphanAlert(view.mode, subject, `position ${pos.ticket}`, {
      symbol: pos.symbol,
      volume: pos.volume,
      comment: pos.comment,
    });
    const key = `${view.mode}:position:${pos.ticket}`;
    if (orphansSeen.has(key)) continue;
    orphansSeen.add(key);
    summary.orphans++;
    await notify('warn', 'orphan_position', {
      mode: view.mode,
      ticket: pos.ticket,
      symbol: pos.symbol,
      volume: pos.volume,
      comment: pos.comment,
    });
  }

  for (const order of view.orders) {
    if (linkedOrd?.has(order.ticket) || links.comments.has(order.comment)) continue;
    const subject = `${view.mode}_order_${order.ticket}`;
    present.add(subject);
    await raiseOrphanAlert(view.mode, subject, `pending order ${order.ticket}`, {
      symbol: order.symbol,
      volume: order.volumeInitial,
      comment: order.comment,
    });
    const key = `${view.mode}:order:${order.ticket}`;
    if (orphansSeen.has(key)) continue;
    orphansSeen.add(key);
    summary.orphans++;
    await notify('warn', 'orphan_order', {
      mode: view.mode,
      ticket: order.ticket,
      symbol: order.symbol,
      volume: order.volumeInitial,
      comment: order.comment,
    });
  }

  const raised = orphanAlerts.get(view.mode) ?? new Set<string>();
  for (const subject of raised) {
    if (present.has(subject)) continue;
    raised.delete(subject);
    await resolveAlert('unknown_position', subject, 'no_longer_at_broker');
  }
  for (const subject of present) raised.add(subject);
  orphanAlerts.set(view.mode, raised);
}

async function raiseOrphanAlert(
  mode: BrokerMode,
  subject: string,
  what: string,
  details: { symbol: string; volume: number; comment: string },
): Promise<void> {
  await raiseAlert({
    type: 'unknown_position',
    subject,
    severity: mode === 'paper' ? 'info' : 'warning',
    source: 'autotrader',
    title: `Unknown ${what} with the EA magic (${mode})`,
    message: `The broker has a ${what} (${details.symbol}, ${details.volume} lots, comment "${details.comment}") that no trade set owns. It is not managed or touched.`,
    details: { mode, ...details },
  });
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export function startReconciler(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (running) return;
  running = true;

  logger.info('reconciler_started', { intervalMs });
  void writeSystemLog('info', 'reconciler', 'reconciler_started', { intervalMs });

  const loop = (): void => {
    if (!running) return;
    void runReconciliation()
      .catch((err: unknown) => {
        logger.warn('reconciler_run_crashed', { error: errorMessage(err) });
      })
      .finally(() => {
        if (running) timer = setTimeout(loop, intervalMs);
      });
  };

  // The first pass runs at startup, then every intervalMs.
  timer = setTimeout(loop, 0);
}

export function stopReconciler(): void {
  running = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  logger.info('reconciler_stopped');
  void writeSystemLog('info', 'reconciler', 'reconciler_stopped');
}

export function isReconcilerRunning(): boolean {
  return running;
}

/** Test seam: clears the orphan-once latches and mode-outage state. */
export function _resetReconcilerForTests(): void {
  orphansSeen.clear();
  modeDown.clear();
  failureStreak.clear();
  orphanAlerts.clear();
}
