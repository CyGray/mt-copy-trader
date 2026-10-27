import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionProfile } from './executionProfile.js';
import { _resetAlertsForTests } from './alerts.js';
import { _resetBrokerRouterForTests, setBrokerForTests } from './brokerRouter.js';
import type { SymbolInfo } from './brokerTypes.js';
import { logger } from './logger.js';
import { invalidateExecutionControl } from './executionControl.js';
import { _resetReconcilerForTests, runReconciliation } from './reconciler.js';
import { createSimulatedBroker, type SimulatedBroker } from './simulatedBroker.js';
import { asFirestore, createFakeFirestore, type FakeFirestore } from './testing/fakeFirestore.js';
import { writeSystemLog } from './systemLog.js';
import { correlationComment, type TradeLifecycle, type TradeSetDoc, type TradeState } from './tradeSetTypes.js';

const fake = vi.hoisted(() => ({ firestore: null as unknown }));

vi.mock('./firestoreAdmin', () => ({ initFirestore: vi.fn(() => fake.firestore) }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./systemLog', () => ({ writeSystemLog: vi.fn(async () => true) }));

const MAGIC = 880002;
const T0 = new Date('2026-10-18T10:00:00Z');
const T0_SEC = Math.floor(T0.getTime() / 1000);

const SPEC: SymbolInfo = {
  symbol: 'XAUUSD',
  digits: 2,
  point: 0.01,
  tickSize: 0.01,
  tickValue: 1,
  tickValueProfit: 1,
  tickValueLoss: 1,
  contractSize: 100,
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.01,
  volumeLimit: 0,
  stopsLevelPoints: 10,
  freezeLevelPoints: 0,
  tradeMode: 'FULL',
  bid: 0,
  ask: 0,
  spreadPoints: 0,
  tickTimeMsc: 0,
  currencyProfit: 'USD',
  currencyMargin: 'USD',
};

let db: FakeFirestore;

function profileFixture(editsPatch: Partial<ExecutionProfile['edits']> = {}): ExecutionProfile {
  return {
    schema_version: 1,
    profile_id: 'gold-recon-test',
    version: 1,
    name: 'reconciler test',
    source: { type: 'manual' },
    broker: 'vantage_mt5',
    symbols: [{ signal_symbol: 'XAUUSD', broker_symbol: 'XAUUSD' }],
    entry: { policy: 'follow_signal', market_tolerance_price: 0.5, pending_expiry_minutes: 60, allow_market_fallback: false },
    sizing: { mode: 'fixed_lots', fixed_lots: 0.1, below_min_volume: 'skip' },
    take_profit: {
      checkpoints: [
        { tp_index: 1, close_percent: 50 },
        { tp_index: 2, close_percent: 30 },
        { tp_index: 3, close_percent: 20 },
      ],
      missing_tp: 'skip_trade',
      infeasible_split: 'skip_trade',
      broker_tp: 'final_checkpoint',
    },
    stop_loss: { min_distance_price: 2, max_distance_price: 25, after_checkpoint: [] },
    break_even: { enabled: false, trigger: 'price_distance', trigger_value: 5, buffer_price: 0.2 },
    trailing: { enabled: false, activation: 'price_distance', activation_value: 3, distance_price: 2, step_price: 0.5 },
    limits: {
      max_concurrent_positions: 3,
      max_positions_per_symbol: 1,
      max_spread_price: 0.5,
      max_deviation_points: 30,
      signal_max_age_sec: 120,
      daily_loss_limit_money: 100,
      max_total_risk_percent: 3,
    },
    edits: {
      before_fill: 'ignore',
      after_fill: 'ignore',
      unparseable_edit: 'ignore',
      explicit_cancel: 'ignore',
      ...editsPatch,
    },
  };
}

function lifecycleFor(current: number): TradeLifecycle {
  return {
    checkpoints: [
      { tp_index: 1, price: 2010, close_volume: 0.05, target_remaining_volume: 0.05, status: 'pending', attempts: 0 },
      { tp_index: 2, price: 2020, close_volume: 0.03, target_remaining_volume: 0.02, status: 'pending', attempts: 0 },
      { tp_index: 3, price: 2030, close_volume: 0.02, target_remaining_volume: 0, status: 'pending', attempts: 0 },
    ],
    current_volume: current,
    current_sl: 1995,
    current_tp: 2030,
    be_applied: false,
    trailing_active: false,
    best_price: 0,
  };
}

function seedTrade(o: {
  id: string;
  state: TradeState;
  submittedAt?: number;
  expiresAt?: number;
  claimedAt?: number;
  createdAt?: number;
  brokerRefs?: TradeSetDoc['broker_refs'];
  lifecycle?: TradeLifecycle | null;
  profile?: ExecutionProfile | null;
  cancel?: 'explicit_cancel' | 'unparseable_edit';
  mode?: TradeSetDoc['mode'];
}): TradeSetDoc {
  const created = new Date((o.createdAt ?? T0_SEC) * 1000).toISOString();
  const profile = o.profile === undefined ? profileFixture() : o.profile;
  const doc = {
    schema: 2,
    trade_set_id: o.id,
    chat_id: o.id.split('_')[0],
    message_id: o.id.split('_')[1],
    event_id: `evt-${o.id}`,
    signal: {},
    signal_revisions: [],
    symbol: 'XAUUSD',
    broker_symbol: 'XAUUSD',
    direction: 'buy',
    order_type: 'BUY',
    mode: o.mode ?? 'paper',
    broker: 'simulated',
    profile: profile ? { doc_id: `${profile.profile_id}__v1`, profile_id: profile.profile_id, version: 1 } : null,
    profile_snapshot: profile,
    limits_snapshot: null,
    state: o.state,
    correlation_comment: correlationComment(o.id),
    claim: { attempts: 1, claimed_at: new Date((o.claimedAt ?? T0_SEC) * 1000).toISOString(), owner: 'test' },
    plan: null,
    submission: {
      submitted_at: new Date((o.submittedAt ?? T0_SEC) * 1000).toISOString(),
      expires_at: o.expiresAt ?? T0_SEC + 8,
      request_id: `req-${o.id}`,
    },
    broker_refs: o.brokerRefs ?? null,
    lifecycle: o.lifecycle === undefined ? lifecycleFor(0.1) : o.lifecycle,
    result: null,
    ...(o.cancel
      ? { cancel_requested: { reason: o.cancel, at: T0.toISOString(), event_id: 'evt-cancel' } }
      : {}),
    created_at: created,
    updated_at: created,
  };
  db.seed(`trade_sets/${o.id}`, doc as unknown as Record<string, unknown>);
  return doc as unknown as TradeSetDoc;
}

function readTrade(id: string): TradeSetDoc {
  const doc = db.peek(`trade_sets/${id}`);
  if (!doc) throw new Error(`no trade set ${id}`);
  return doc as unknown as TradeSetDoc;
}

function eventKeys(id: string): string[] {
  return db
    .docs('trade_events')
    .map((d) => d.data as { trade_set_id: string; event_key: string })
    .filter((e) => e.trade_set_id === id)
    .map((e) => e.event_key);
}

function newBroker(): SimulatedBroker {
  const broker = createSimulatedBroker({ magic: MAGIC, symbols: { XAUUSD: SPEC } });
  setBrokerForTests('paper', broker);
  return broker;
}

/** Places a market BUY at 2000 carrying the trade's correlation comment. */
async function placeBuy(broker: SimulatedBroker, id: string): Promise<number> {
  await broker.setQuote('XAUUSD', 1999.9, 2000);
  const res = await broker.placeOrder({
    symbol: 'XAUUSD',
    orderType: 'BUY',
    volume: 0.1,
    price: 0,
    sl: 1995,
    tp: 2030,
    deviationPoints: 10,
    comment: correlationComment(id),
  });
  return res.positionTicket;
}

/** Places a BUY_LIMIT at 1995 carrying the trade's correlation comment. */
async function placeLimit(broker: SimulatedBroker, id: string): Promise<number> {
  await broker.setQuote('XAUUSD', 1999.9, 2000);
  const res = await broker.placeOrder({
    symbol: 'XAUUSD',
    orderType: 'BUY_LIMIT',
    volume: 0.1,
    price: 1995,
    sl: 1990,
    tp: 2030,
    deviationPoints: 10,
    comment: correlationComment(id),
  });
  return res.orderTicket;
}

function setNow(sec: number): void {
  vi.setSystemTime(new Date(sec * 1000));
}

function orphanLogs(event: string): number {
  return vi.mocked(writeSystemLog).mock.calls.filter((c) => c[2] === event).length;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setNow(T0_SEC);
  db = createFakeFirestore();
  fake.firestore = asFirestore(db);
  _resetReconcilerForTests();
  _resetBrokerRouterForTests();
  _resetAlertsForTests();
  invalidateExecutionControl();
  vi.mocked(writeSystemLog).mockClear();
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  _resetBrokerRouterForTests();
});

describe('SUBMIT_UNKNOWN resolution', () => {
  it('a position with the comment is found after expiry: OPEN with broker refs', async () => {
    const broker = newBroker();
    const ticket = await placeBuy(broker, 'chat2_200');
    seedTrade({ id: 'chat2_200', state: 'SUBMIT_UNKNOWN' });
    setNow(T0_SEC + 20);

    const summary = await runReconciliation();

    expect(summary.resolved).toBe(1);
    const trade = readTrade('chat2_200');
    expect(trade.state).toBe('OPEN');
    expect(trade.broker_refs?.position_ticket).toBe(ticket);
    expect(trade.broker_refs?.fill_price).toBe(2000);
    expect(trade.broker_refs?.filled_volume).toBe(0.1);
    expect(trade.lifecycle?.current_volume).toBe(0.1);
    expect(eventKeys('chat2_200')).toEqual(expect.arrayContaining(['entry_confirmed', 'reconciliation_submit_unknown_resolved']));
  });

  it('a pending order with the comment: PENDING_ORDER with the order ticket', async () => {
    const broker = newBroker();
    const orderTicket = await placeLimit(broker, 'chat2_201');
    seedTrade({ id: 'chat2_201', state: 'SUBMIT_UNKNOWN' });
    setNow(T0_SEC + 20);

    await runReconciliation();

    const trade = readTrade('chat2_201');
    expect(trade.state).toBe('PENDING_ORDER');
    expect(trade.broker_refs?.order_ticket).toBe(orderTicket);
    expect(eventKeys('chat2_201')).toContain('pending_order_placed');
  });

  it('a position that already closed (IN deal only) becomes CLOSED with the realized pnl', async () => {
    const broker = newBroker();
    const ticket = await placeBuy(broker, 'chat2_202');
    await broker.setQuote('XAUUSD', 2010, 2010.2);
    await broker.closePosition(ticket);
    seedTrade({ id: 'chat2_202', state: 'SUBMIT_UNKNOWN' });
    setNow(T0_SEC + 20);

    await runReconciliation();

    const trade = readTrade('chat2_202');
    expect(trade.state).toBe('CLOSED');
    expect(trade.result?.close_reason).toBe('manual');
    expect(trade.result?.realized_pnl).toBe(100);
    expect(trade.lifecycle?.current_volume).toBe(0);
  });

  it('nothing found after expiry: REJECTED with not_found_after_expiry', async () => {
    const broker = newBroker();
    seedTrade({ id: 'chat2_203', state: 'SUBMIT_UNKNOWN' });
    setNow(T0_SEC + 20);

    const summary = await runReconciliation();

    expect(summary.rejected).toBe(1);
    const trade = readTrade('chat2_203');
    expect(trade.state).toBe('REJECTED');
    expect(trade.error).toBe('not_found_after_expiry');
    expect(eventKeys('chat2_203')).toEqual(expect.arrayContaining(['entry_rejected_not_found_after_expiry', 'reconciliation_submit_unknown_resolved']));
    expect(await broker.getPositions()).toHaveLength(0);
  });

  it('before expiry (+5 s grace) nothing is decided, even when the position exists', async () => {
    const broker = newBroker();
    await placeBuy(broker, 'chat2_204');
    seedTrade({ id: 'chat2_204', state: 'SUBMIT_UNKNOWN', cancel: 'explicit_cancel' });
    seedTrade({ id: 'chat2_205', state: 'SUBMIT_UNKNOWN', cancel: 'explicit_cancel' });
    setNow(T0_SEC + 8 + 5);

    await runReconciliation();

    expect(readTrade('chat2_204').state).toBe('SUBMIT_UNKNOWN');
    expect(readTrade('chat2_205').state).toBe('SUBMIT_UNKNOWN');
    expect(eventKeys('chat2_204')).toEqual([]);
    expect(eventKeys('chat2_205')).toEqual([]);
  });

  it('a failed deal search never concludes "not found"', async () => {
    const broker = newBroker();
    seedTrade({ id: 'chat2_206', state: 'SUBMIT_UNKNOWN' });
    setNow(T0_SEC + 20);
    broker.failNext('getDeals', 'unavailable');

    const summary = await runReconciliation();

    expect(summary.errors).toBe(1);
    expect(readTrade('chat2_206').state).toBe('SUBMIT_UNKNOWN');
  });

  it('a broker read outage skips the mode and changes nothing', async () => {
    const broker = newBroker();
    await placeBuy(broker, 'chat2_207');
    seedTrade({ id: 'chat2_207', state: 'SUBMIT_UNKNOWN' });
    setNow(T0_SEC + 20);
    broker.failNext('getPositions', 'unavailable');

    const summary = await runReconciliation();

    expect(summary.skippedModes).toContain('paper');
    expect(readTrade('chat2_207').state).toBe('SUBMIT_UNKNOWN');
  });
});

describe('stale states', () => {
  it('SUBMITTING older than 120 s becomes SUBMIT_UNKNOWN (expiry not yet passed, so untouched after)', async () => {
    newBroker();
    seedTrade({
      id: 'chat2_210',
      state: 'SUBMITTING',
      submittedAt: T0_SEC - 130,
      expiresAt: T0_SEC + 100,
    });

    const summary = await runReconciliation();

    expect(summary.staleSubmitting).toBe(1);
    expect(readTrade('chat2_210').state).toBe('SUBMIT_UNKNOWN');
    expect(eventKeys('chat2_210')).toContain('entry_unknown_stale_submitting');
  });

  it('SUBMITTING younger than 120 s is left alone', async () => {
    newBroker();
    seedTrade({ id: 'chat2_211', state: 'SUBMITTING', submittedAt: T0_SEC - 60, expiresAt: T0_SEC + 100 });

    await runReconciliation();

    expect(readTrade('chat2_211').state).toBe('SUBMITTING');
  });

  it('CLAIMED older than 5 minutes becomes ERROR with stale_claim', async () => {
    newBroker();
    seedTrade({ id: 'chat2_212', state: 'CLAIMED', claimedAt: T0_SEC - 301 });
    seedTrade({ id: 'chat2_213', state: 'CLAIMED', claimedAt: T0_SEC - 200 });

    const summary = await runReconciliation();

    expect(summary.staleClaims).toBe(1);
    const stale = readTrade('chat2_212');
    expect(stale.state).toBe('ERROR');
    expect(stale.error).toBe('stale_claim');
    expect(readTrade('chat2_213').state).toBe('CLAIMED');
  });
});

describe('cancel_requested', () => {
  it('a resolved pending order is cancelled when the profile allows cancel_pending_only', async () => {
    const broker = newBroker();
    const orderTicket = await placeLimit(broker, 'chat2_220');
    seedTrade({
      id: 'chat2_220',
      state: 'SUBMIT_UNKNOWN',
      cancel: 'explicit_cancel',
      profile: profileFixture({ explicit_cancel: 'cancel_pending_only' }),
    });
    setNow(T0_SEC + 20);

    await runReconciliation();

    expect(readTrade('chat2_220').state).toBe('CANCELLED');
    expect(await broker.getOrders()).toHaveLength(0);
    expect(eventKeys('chat2_220')).toContain('pending_order_cancelled');
    expect(orderTicket).toBeGreaterThan(0);
  });

  it('under explicit_cancel "ignore" the pending order stays and the cancel is recorded as ignored', async () => {
    const broker = newBroker();
    await placeLimit(broker, 'chat2_221');
    seedTrade({ id: 'chat2_221', state: 'SUBMIT_UNKNOWN', cancel: 'explicit_cancel', profile: profileFixture({ explicit_cancel: 'ignore' }) });
    setNow(T0_SEC + 20);

    await runReconciliation();

    expect(readTrade('chat2_221').state).toBe('PENDING_ORDER');
    expect(await broker.getOrders()).toHaveLength(1);
    expect(eventKeys('chat2_221')).toContain('cancel_ignored_explicit_cancel');
  });

  it('an open position is closed with close_reason cancel under explicit_cancel "close_position"', async () => {
    const broker = newBroker();
    await placeBuy(broker, 'chat2_222');
    seedTrade({
      id: 'chat2_222',
      state: 'SUBMIT_UNKNOWN',
      cancel: 'explicit_cancel',
      profile: profileFixture({ explicit_cancel: 'close_position' }),
    });
    setNow(T0_SEC + 20);

    await runReconciliation();

    const trade = readTrade('chat2_222');
    expect(trade.state).toBe('CLOSED');
    expect(trade.result?.close_reason).toBe('cancel');
    expect(await broker.getPositions()).toHaveLength(0);
  });

  it('an unparseable_edit cancel on an open position is only recorded', async () => {
    const broker = newBroker();
    const ticket = await placeBuy(broker, 'chat2_223');
    seedTrade({
      id: 'chat2_223',
      state: 'OPEN',
      cancel: 'unparseable_edit',
      profile: profileFixture({ unparseable_edit: 'cancel_pending_only' }),
      brokerRefs: { order_ticket: 0, position_ticket: ticket, deal_ticket: 0, fill_price: 2000, filled_volume: 0.1 },
    });
    setNow(T0_SEC + 20);

    await runReconciliation();

    expect(readTrade('chat2_223').state).toBe('OPEN');
    expect(await broker.getPositions()).toHaveLength(1);
    expect(eventKeys('chat2_223')).toContain('cancel_ignored_unparseable_edit');
  });
});

describe('volume drift', () => {
  it('a position smaller than the lifecycle expects is updated and recorded as an external change', async () => {
    const broker = newBroker();
    const ticket = await placeBuy(broker, 'chat2_230');
    await broker.closePosition(ticket, 0.03);
    seedTrade({
      id: 'chat2_230',
      state: 'OPEN',
      brokerRefs: { order_ticket: 0, position_ticket: ticket, deal_ticket: 0, fill_price: 2000, filled_volume: 0.1 },
      lifecycle: lifecycleFor(0.1),
    });

    const summary = await runReconciliation();

    expect(summary.volumeUpdates).toBe(1);
    const trade = readTrade('chat2_230');
    expect(trade.lifecycle?.current_volume).toBe(0.07);
    expect(eventKeys('chat2_230').some((k) => k.startsWith('external_volume_change_'))).toBe(true);
  });

  it('a reduction that matches a checkpoint target is left to the lifecycle manager', async () => {
    const broker = newBroker();
    const ticket = await placeBuy(broker, 'chat2_231');
    await broker.closePosition(ticket, 0.05);
    seedTrade({
      id: 'chat2_231',
      state: 'OPEN',
      brokerRefs: { order_ticket: 0, position_ticket: ticket, deal_ticket: 0, fill_price: 2000, filled_volume: 0.1 },
      lifecycle: lifecycleFor(0.1),
    });

    const summary = await runReconciliation();

    expect(summary.volumeUpdates).toBe(0);
    expect(readTrade('chat2_231').lifecycle?.current_volume).toBe(0.1);
  });
});

describe('orphans', () => {
  it('an unlinked position and order are logged once per ticket and never touched', async () => {
    const broker = newBroker();
    // Paper is the execution mode, so its broker is in use even with no trade sets.
    db.seed('settings/default', { execution: { mode: 'paper' } });
    const orphanPos = await placeBuy(broker, 'manual-position');
    const orphanOrder = await placeLimit(broker, 'manual-order');
    // The second placement shares no comment with the first, so both are unlinked.

    await runReconciliation();
    await runReconciliation();

    expect(orphanLogs('orphan_position')).toBe(1);
    expect(orphanLogs('orphan_order')).toBe(1);
    const positions = await broker.getPositions();
    const orders = await broker.getOrders();
    expect(positions.map((p) => p.ticket)).toEqual([orphanPos]);
    expect(orders.map((o) => o.ticket)).toEqual([orphanOrder]);
    expect(positions[0].volume).toBe(0.1);
    expect(positions[0].sl).toBe(1995);
  });

  it('a position referenced by an active trade set is not an orphan', async () => {
    const broker = newBroker();
    const ticket = await placeBuy(broker, 'chat2_240');
    seedTrade({
      id: 'chat2_240',
      state: 'OPEN',
      brokerRefs: { order_ticket: 0, position_ticket: ticket, deal_ticket: 0, fill_price: 2000, filled_volume: 0.1 },
    });

    await runReconciliation();

    expect(orphanLogs('orphan_position')).toBe(0);
  });
});

describe('close_requested_by close_all', () => {
  /** Stamps the admin close-all marker onto a seeded trade set. */
  function markCloseAll(id: string): void {
    db.seed(`trade_sets/${id}`, { ...(db.peek(`trade_sets/${id}`) as Record<string, unknown>), close_requested_by: 'close_all' });
  }

  it('an entry that resolves to an open position under close_all is closed, with close_reason close_all', async () => {
    const broker = newBroker();
    await placeBuy(broker, 'chat2_500');
    seedTrade({ id: 'chat2_500', state: 'SUBMIT_UNKNOWN' });
    markCloseAll('chat2_500');
    setNow(T0_SEC + 20);

    await runReconciliation();

    const trade = readTrade('chat2_500');
    expect(trade.state).toBe('CLOSED');
    expect(trade.result?.close_reason).toBe('close_all');
    expect(trade.lifecycle?.current_volume).toBe(0);
    expect(await broker.getPositions()).toHaveLength(0);
    expect(eventKeys('chat2_500')).toEqual(expect.arrayContaining(['position_closed']));
  });

  it('an entry that resolves to a pending order under close_all has the order cancelled', async () => {
    const broker = newBroker();
    await placeLimit(broker, 'chat2_501');
    seedTrade({ id: 'chat2_501', state: 'SUBMIT_UNKNOWN' });
    markCloseAll('chat2_501');
    setNow(T0_SEC + 20);

    await runReconciliation();

    expect(readTrade('chat2_501').state).toBe('CANCELLED');
    expect(await broker.getOrders()).toHaveLength(0);
  });

  it('a failed close under close_all stays OPEN and the next pass closes it', async () => {
    const broker = newBroker();
    const ticket = await placeBuy(broker, 'chat2_502');
    seedTrade({
      id: 'chat2_502',
      state: 'OPEN',
      brokerRefs: { order_ticket: 0, position_ticket: ticket, deal_ticket: 0, fill_price: 2000, filled_volume: 0.1 },
    });
    markCloseAll('chat2_502');
    broker.failNext('closePosition', 'reject', 10006);

    await runReconciliation();
    expect(readTrade('chat2_502').state).toBe('OPEN');
    expect(await broker.getPositions()).toHaveLength(1);

    await runReconciliation();
    expect(readTrade('chat2_502').state).toBe('CLOSED');
    expect(readTrade('chat2_502').result?.close_reason).toBe('close_all');
    expect(await broker.getPositions()).toHaveLength(0);
  });

  it('a trade without close_all is left alone when its entry resolves to an open position', async () => {
    const broker = newBroker();
    await placeBuy(broker, 'chat2_503');
    seedTrade({ id: 'chat2_503', state: 'SUBMIT_UNKNOWN' });
    setNow(T0_SEC + 20);

    await runReconciliation();

    expect(readTrade('chat2_503').state).toBe('OPEN');
    expect(await broker.getPositions()).toHaveLength(1);
  });
});

describe('operator alerts', () => {
  function alert(id: string): Record<string, unknown> | undefined {
    return db.peek(`alerts/${id}`);
  }

  it('resolves the submit_unknown alert when the reconciler settles the entry', async () => {
    const broker = newBroker();
    await placeBuy(broker, 'chat2_700');
    seedTrade({ id: 'chat2_700', state: 'SUBMIT_UNKNOWN' });
    db.seed('alerts/submit_unknown__chat2_700', { type: 'submit_unknown', subject: 'chat2_700', status: 'open', severity: 'error', count: 1 });
    setNow(T0_SEC + 20);

    await runReconciliation();

    expect(readTrade('chat2_700').state).toBe('OPEN');
    expect(alert('submit_unknown__chat2_700')).toMatchObject({ status: 'resolved', resolution: 'resolved_open' });
  });

  it('escalates a SUBMIT_UNKNOWN to critical when the broker stays unreadable for 5 minutes past expiry', async () => {
    const broker = newBroker();
    seedTrade({ id: 'chat2_701', state: 'SUBMIT_UNKNOWN' });
    setNow(T0_SEC + 8 + 301);
    broker.failNext('getPositions', 'unavailable');

    await runReconciliation();

    expect(readTrade('chat2_701').state).toBe('SUBMIT_UNKNOWN');
    expect(alert('submit_unknown__chat2_701')).toMatchObject({ status: 'open', severity: 'critical' });
  });

  it('raises submit_unknown when a stale SUBMITTING is moved to SUBMIT_UNKNOWN', async () => {
    newBroker();
    seedTrade({ id: 'chat2_702', state: 'SUBMITTING', submittedAt: T0_SEC - 200, expiresAt: T0_SEC + 3600 });
    await runReconciliation();
    expect(readTrade('chat2_702').state).toBe('SUBMIT_UNKNOWN');
    expect(alert('submit_unknown__chat2_702')).toMatchObject({ status: 'open', severity: 'error' });
  });

  it('raises reconciliation_failed after three consecutive failed passes for a mode, and resolves it on success', async () => {
    const broker = newBroker();
    seedTrade({ id: 'chat2_703', state: 'OPEN', brokerRefs: { order_ticket: 1, position_ticket: 1, deal_ticket: 1, fill_price: 2000, filled_volume: 0.1 } });
    for (let i = 0; i < 2; i += 1) {
      broker.failNext('getPositions', 'unavailable');
      await runReconciliation();
    }
    expect(alert('reconciliation_failed__paper')).toBeUndefined();
    broker.failNext('getPositions', 'unavailable');
    await runReconciliation();
    expect(alert('reconciliation_failed__paper')).toMatchObject({ status: 'open', severity: 'error' });

    await runReconciliation();
    expect(alert('reconciliation_failed__paper')).toMatchObject({ status: 'resolved' });
  });

  it('raises reconciliation_failed when the trade set listing keeps failing', async () => {
    for (let i = 0; i < 3; i += 1) {
      db.failNext('query');
      await runReconciliation();
    }
    expect(alert('reconciliation_failed__list')).toMatchObject({ status: 'open' });
  });

  it('keeps an unknown_position alert open while the orphan exists and resolves it when it is gone', async () => {
    const broker = newBroker();
    db.seed('settings/default', { execution: { mode: 'paper' } });
    const ticket = await placeBuy(broker, 'manual-position');

    await runReconciliation();
    expect(alert(`unknown_position__paper_position_${ticket}`)).toMatchObject({ status: 'open', severity: 'info' });

    await broker.closePosition(ticket);
    await runReconciliation();
    expect(alert(`unknown_position__paper_position_${ticket}`)).toMatchObject({ status: 'resolved', resolution: 'no_longer_at_broker' });
  });
});
