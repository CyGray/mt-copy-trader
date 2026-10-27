import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionProfile } from './executionProfile.js';
import { _resetAlertsForTests } from './alerts.js';
import { _resetBrokerRouterForTests, setBrokerForTests } from './brokerRouter.js';
import { BrokerRejectedError, type BrokerAdapter, type SymbolInfo } from './brokerTypes.js';
import { invalidateExecutionControl } from './executionControl.js';
import { logger } from './logger.js';
import { runAdminCommands, setCloseAllSettleMsForTests } from './adminCommands.js';
import { _resetLifecycleManagerForTests, runLifecycleTick } from './lifecycleManager.js';
import { createSimulatedBroker, type SimState, type SimulatedBroker } from './simulatedBroker.js';
import { asFirestore, createFakeFirestore, type FakeFirestore } from './testing/fakeFirestore.js';
import { correlationComment, type TradeLifecycle, type TradeSetDoc, type TradeState } from './tradeSetTypes.js';

const fake = vi.hoisted(() => ({ firestore: null as unknown }));

vi.mock('./firestoreAdmin', () => ({ initFirestore: vi.fn(() => fake.firestore) }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./systemLog', () => ({ writeSystemLog: vi.fn(async () => true) }));

const MAGIC = 880003;
const FOREIGN_MAGIC = 990003;
const T0 = new Date('2026-10-18T10:00:00Z');

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

function profileFixture(): ExecutionProfile {
  return {
    schema_version: 1,
    profile_id: 'gold-admin-test',
    version: 1,
    name: 'admin test',
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
    edits: { before_fill: 'ignore', after_fill: 'ignore', unparseable_edit: 'ignore', explicit_cancel: 'ignore' },
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
  mode?: TradeSetDoc['mode'];
  positionTicket?: number;
  orderTicket?: number;
  withLifecycle?: boolean;
}): void {
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
    profile: { doc_id: 'gold-admin-test__v1', profile_id: 'gold-admin-test', version: 1 },
    profile_snapshot: profileFixture(),
    limits_snapshot: null,
    state: o.state,
    correlation_comment: correlationComment(o.id),
    claim: { attempts: 1, claimed_at: T0.toISOString(), owner: 'test' },
    plan: null,
    submission: { submitted_at: T0.toISOString(), expires_at: Math.floor(T0.getTime() / 1000) + 8, request_id: 'req' },
    broker_refs: {
      order_ticket: o.orderTicket ?? 0,
      position_ticket: o.positionTicket ?? 0,
      deal_ticket: 0,
      fill_price: 2000,
      filled_volume: o.positionTicket ? 0.1 : 0,
    },
    lifecycle: o.withLifecycle === false ? null : lifecycleFor(0.1),
    result: null,
    created_at: T0.toISOString(),
    updated_at: T0.toISOString(),
  };
  db.seed(`trade_sets/${o.id}`, doc as unknown as Record<string, unknown>);
}

/** Trade set as stored. */
function readTrade(id: string): TradeSetDoc {
  return db.peek(`trade_sets/${id}`) as unknown as TradeSetDoc;
}

function seedCommand(id: string, overrides: Record<string, string> = {}): void {
  db.seed(`admin_commands/${id}`, {
    type: 'close_all',
    status: 'pending',
    confirm: 'CLOSE ALL',
    requested_by_uid: 'uid-test',
    requested_by_email: 'operator@example.test',
    requested_at: T0.toISOString(),
    ...overrides,
  });
}

function readCommand(id: string): { status: string; result?: Record<string, unknown> } {
  return db.peek(`admin_commands/${id}`) as unknown as { status: string; result?: Record<string, unknown> };
}

function readSettings(): { trading?: { kill_switch?: boolean } } {
  return (db.peek('settings/default') ?? {}) as { trading?: { kill_switch?: boolean } };
}

function newSim(magic = MAGIC, persistence?: Parameters<typeof createSimulatedBroker>[0]['persistence']): SimulatedBroker {
  return createSimulatedBroker({ magic, symbols: { XAUUSD: SPEC }, persistence });
}

async function placeBuy(broker: SimulatedBroker, comment: string): Promise<number> {
  await broker.setQuote('XAUUSD', 1999.9, 2000);
  const res = await broker.placeOrder({
    symbol: 'XAUUSD',
    orderType: 'BUY',
    volume: 0.1,
    price: 0,
    sl: 1995,
    tp: 2030,
    deviationPoints: 10,
    comment,
  });
  return res.positionTicket;
}

async function placeLimit(broker: SimulatedBroker, comment: string): Promise<number> {
  await broker.setQuote('XAUUSD', 1999.9, 2000);
  const res = await broker.placeOrder({
    symbol: 'XAUUSD',
    orderType: 'BUY_LIMIT',
    volume: 0.1,
    price: 1995,
    sl: 1990,
    tp: 2030,
    deviationPoints: 10,
    comment,
  });
  return res.orderTicket;
}

function memoryPersistence(store: { data: SimState | null }) {
  return {
    load: async (): Promise<SimState | null> => (store.data ? (JSON.parse(JSON.stringify(store.data)) as SimState) : null),
    save: async (state: SimState): Promise<void> => {
      store.data = JSON.parse(JSON.stringify(state)) as SimState;
    },
  };
}

/** A broker whose reads return nothing and whose mutations record a call. Used to prove a broker was never touched. */
function recordingBroker(): { broker: BrokerAdapter; calls: () => number } {
  const methods = [
    'ping',
    'getAccountInfo',
    'getSymbolInfo',
    'getPositions',
    'getOrders',
    'getDeals',
    'checkOrder',
    'placeOrder',
    'modifyPosition',
    'modifyPendingOrder',
    'closePosition',
    'cancelOrder',
  ];
  const mocks: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of methods) mocks[m] = vi.fn(async () => (m === 'getPositions' || m === 'getOrders' ? [] : undefined));
  const broker = { kind: 'mt5', magic: MAGIC, ...mocks } as unknown as BrokerAdapter;
  return {
    broker,
    calls: () => Object.values(mocks).reduce((sum, fn) => sum + fn.mock.calls.length, 0),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = createFakeFirestore();
  fake.firestore = asFirestore(db);
  _resetBrokerRouterForTests();
  _resetLifecycleManagerForTests();
  _resetAlertsForTests();
  invalidateExecutionControl();
  vi.mocked(logger.error).mockClear();
  setCloseAllSettleMsForTests(0);
});

afterEach(() => {
  vi.useRealTimers();
  _resetBrokerRouterForTests();
  setCloseAllSettleMsForTests(null);
});

describe('close_all', () => {
  it('engages the kill switch, closes owned positions, cancels pending orders, and finishes done with results', async () => {
    const broker = newSim();
    setBrokerForTests('paper', broker);
    const linked = await placeBuy(broker, correlationComment('chat3_300'));
    const manual = await placeBuy(broker, 'manual-trade');
    const pending = await placeLimit(broker, correlationComment('chat3_301'));
    seedTrade({ id: 'chat3_300', state: 'OPEN', positionTicket: linked });
    seedTrade({ id: 'chat3_301', state: 'PENDING_ORDER', orderTicket: pending });
    seedCommand('cmd-done');

    const killAtClose: boolean[] = [];
    const original = broker.closePosition.bind(broker);
    vi.spyOn(broker, 'closePosition').mockImplementation((ticket: number, volume?: number) => {
      killAtClose.push(readSettings().trading?.kill_switch === true);
      return original(ticket, volume);
    });

    const claimed = await runAdminCommands();

    expect(claimed).toBe(1);
    expect(killAtClose).toEqual([true, true]);
    expect(readSettings().trading?.kill_switch).toBe(true);
    expect(await broker.getPositions()).toHaveLength(0);
    expect(await broker.getOrders()).toHaveLength(0);

    const cmd = readCommand('cmd-done');
    expect(cmd.status).toBe('done');
    expect(cmd.result?.kill_switch_engaged).toBe(true);
    const results = cmd.result?.results as { kind: string; ok: boolean; ticket?: number }[];
    expect(results.map((r) => r.kind).sort()).toEqual(['order', 'position', 'position']);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.ticket)).toEqual(expect.arrayContaining([linked, manual, pending]));

    expect(readTrade('chat3_300').close_requested_by).toBe('close_all');
    expect(readTrade('chat3_301').state).toBe('CANCELLED');
  });

  it('a foreign-magic position on the same account survives', async () => {
    const store = { data: null as SimState | null };
    const foreign = newSim(FOREIGN_MAGIC, memoryPersistence(store));
    await foreign.setQuote('XAUUSD', 1999.9, 2000);
    await foreign.placeOrder({
      symbol: 'XAUUSD',
      orderType: 'BUY',
      volume: 0.1,
      price: 0,
      sl: 1995,
      tp: 2030,
      deviationPoints: 10,
      comment: 'other-ea',
    });

    const broker = newSim(MAGIC, memoryPersistence(store));
    setBrokerForTests('paper', broker);
    await placeBuy(broker, 'ours');
    seedCommand('cmd-foreign');

    await runAdminCommands();

    expect(readCommand('cmd-foreign').status).toBe('done');
    const positions = store.data?.positions ?? [];
    expect(positions.filter((p) => p.magic === MAGIC)).toHaveLength(0);
    const survivors = positions.filter((p) => p.magic === FOREIGN_MAGIC);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].volume).toBe(0.1);
    expect(survivors[0].sl).toBe(1995);
  });

  it('does not touch the MT5 broker when there is no MT5 work and the mode is paper', async () => {
    const broker = newSim();
    setBrokerForTests('paper', broker);
    const mt5 = recordingBroker();
    setBrokerForTests('demo', mt5.broker);
    setBrokerForTests('live', mt5.broker);
    db.seed('settings/default', { execution: { mode: 'paper' } });
    await placeBuy(broker, 'paper-only');
    seedCommand('cmd-paper');

    await runAdminCommands();

    expect(readCommand('cmd-paper').status).toBe('done');
    expect(mt5.calls()).toBe(0);
  });

  it('demo and live share one MT5 broker: each position is closed once', async () => {
    setBrokerForTests('paper', newSim());
    const mt5 = newSim();
    setBrokerForTests('demo', mt5);
    setBrokerForTests('live', mt5);
    db.seed('settings/default', { execution: { mode: 'demo' } });
    const demoPos = await placeBuy(mt5, correlationComment('chat3_320'));
    const livePos = await placeBuy(mt5, correlationComment('chat3_321'));
    seedTrade({ id: 'chat3_320', state: 'OPEN', mode: 'demo', positionTicket: demoPos });
    seedTrade({ id: 'chat3_321', state: 'OPEN', mode: 'live', positionTicket: livePos });
    seedCommand('cmd-mt5');
    const spy = vi.spyOn(mt5, 'closePosition');

    await runAdminCommands();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(readCommand('cmd-mt5').status).toBe('done');
    expect(await mt5.getPositions()).toHaveLength(0);
  });

  it('two concurrent runs execute the command once', async () => {
    const broker = newSim();
    setBrokerForTests('paper', broker);
    await placeBuy(broker, 'concurrent');
    seedCommand('cmd-race');
    const spy = vi.spyOn(broker, 'closePosition');

    const [a, b] = await Promise.all([runAdminCommands(), runAdminCommands()]);

    expect(a + b).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(readCommand('cmd-race').status).toBe('done');
  });

  it('a wrong confirmation is rejected before anything is touched', async () => {
    const broker = newSim();
    setBrokerForTests('paper', broker);
    await placeBuy(broker, 'stay-open');
    seedCommand('cmd-confirm', { confirm: 'yes' });
    const spy = vi.spyOn(broker, 'closePosition');

    await runAdminCommands();

    const cmd = readCommand('cmd-confirm');
    expect(cmd.status).toBe('rejected');
    expect(cmd.result?.reason).toBe('confirm_mismatch');
    expect(readSettings().trading?.kill_switch).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    expect(await broker.getPositions()).toHaveLength(1);
  });

  it('an expired command (older than 5 minutes) is rejected', async () => {
    const broker = newSim();
    setBrokerForTests('paper', broker);
    await placeBuy(broker, 'stay-open-2');
    seedCommand('cmd-old', { requested_at: new Date(T0.getTime() - 6 * 60_000).toISOString() });
    const spy = vi.spyOn(broker, 'closePosition');

    await runAdminCommands();

    const cmd = readCommand('cmd-old');
    expect(cmd.status).toBe('rejected');
    expect(cmd.result?.reason).toBe('expired');
    expect(spy).not.toHaveBeenCalled();
  });

  it('an unknown command type is rejected', async () => {
    setBrokerForTests('paper', newSim());
    seedCommand('cmd-type', { type: 'close_positions' });

    await runAdminCommands();

    const cmd = readCommand('cmd-type');
    expect(cmd.status).toBe('rejected');
    expect(cmd.result?.reason).toBe('unknown_type');
  });

  it('a close rejected in both sweeps fails the command, and the other positions still close', async () => {
    const broker = newSim();
    setBrokerForTests('paper', broker);
    const stuck = await placeBuy(broker, 'first');
    await placeBuy(broker, 'second');
    seedCommand('cmd-reject');
    const original = broker.closePosition.bind(broker);
    vi.spyOn(broker, 'closePosition').mockImplementation((ticket: number, volume?: number) =>
      ticket === stuck ? Promise.reject(new BrokerRejectedError(10006, 'requote')) : original(ticket, volume),
    );

    await runAdminCommands();

    const cmd = readCommand('cmd-reject');
    expect(cmd.status).toBe('failed');
    expect(cmd.result?.kill_switch_engaged).toBe(true);
    expect(cmd.result?.sweeps).toBe(2);
    const results = cmd.result?.results as { kind: string; ok: boolean; ticket?: number; sweep: number; retcode?: number }[];
    expect(results.filter((r) => !r.ok)).toEqual([
      expect.objectContaining({ kind: 'position', ticket: stuck, sweep: 1, retcode: 10006 }),
      expect.objectContaining({ kind: 'position', ticket: stuck, sweep: 2, retcode: 10006 }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await broker.getPositions()).toHaveLength(1);
    expect(db.peek('alerts/close_all_failed__cmd-reject')).toMatchObject({ severity: 'critical', status: 'open' });
  });

  it('a close rejected in the first sweep and closed in the second does not fail the command', async () => {
    const broker = newSim();
    setBrokerForTests('paper', broker);
    const stubborn = await placeBuy(broker, 'stubborn');
    await placeBuy(broker, 'easy');
    seedCommand('cmd-cleared');
    const original = broker.closePosition.bind(broker);
    let rejections = 1;
    vi.spyOn(broker, 'closePosition').mockImplementation((ticket: number, volume?: number) => {
      if (ticket === stubborn && rejections > 0) {
        rejections--;
        return Promise.reject(new BrokerRejectedError(10006, 'requote'));
      }
      return original(ticket, volume);
    });

    await runAdminCommands();

    const cmd = readCommand('cmd-cleared');
    expect(cmd.status).toBe('done');
    const results = cmd.result?.results as { ok: boolean; ticket?: number; sweep: number }[];
    expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ ticket: stubborn, sweep: 1 })]);
    expect(results.filter((r) => r.ok && r.sweep === 2)).toEqual([expect.objectContaining({ ticket: stubborn })]);
    expect(await broker.getPositions()).toHaveLength(0);
  });

  it('an ambiguous close is recorded as ambiguous and not retried within its sweep; the second sweep confirms it', async () => {
    const broker = newSim();
    setBrokerForTests('paper', broker);
    const ticket = await placeBuy(broker, correlationComment('chat3_340'));
    seedTrade({ id: 'chat3_340', state: 'OPEN', positionTicket: ticket });
    seedCommand('cmd-ambiguous');
    broker.failNext('closePosition', 'ambiguous');
    const spy = vi.spyOn(broker, 'closePosition');

    await runAdminCommands();

    // The sim closed the position before losing the reply, so the second sweep finds nothing to close.
    expect(spy).toHaveBeenCalledTimes(1);
    const cmd = readCommand('cmd-ambiguous');
    expect(cmd.status).toBe('done');
    const results = cmd.result?.results as { ok: boolean; error?: string; sweep: number }[];
    expect(results).toEqual([expect.objectContaining({ ok: false, error: 'ambiguous', sweep: 1 })]);
    expect(readTrade('chat3_340').close_requested_by).toBe('close_all');
  });

  it('a position read that fails in both sweeps fails the command but still engages the kill switch', async () => {
    const broker = newSim();
    setBrokerForTests('paper', broker);
    await placeBuy(broker, 'unreadable');
    seedCommand('cmd-read');
    broker.failNext('getPositions', 'unavailable');
    broker.failNext('getPositions', 'unavailable');

    await runAdminCommands();

    const cmd = readCommand('cmd-read');
    expect(cmd.status).toBe('failed');
    expect(readSettings().trading?.kill_switch).toBe(true);
    const results = cmd.result?.results as { kind: string; ok: boolean; sweep: number }[];
    expect(results).toEqual([
      expect.objectContaining({ kind: 'read', ok: false, sweep: 1 }),
      expect.objectContaining({ kind: 'read', ok: false, sweep: 2 }),
    ]);
    expect(await broker.getPositions()).toHaveLength(1);
  });

  it('a read that fails in the first sweep is cleared by the second sweep', async () => {
    const broker = newSim();
    setBrokerForTests('paper', broker);
    await placeBuy(broker, 'briefly-unreadable');
    seedCommand('cmd-read-once');
    broker.failNext('getPositions', 'unavailable');

    await runAdminCommands();

    const cmd = readCommand('cmd-read-once');
    expect(cmd.status).toBe('done');
    const results = cmd.result?.results as { kind: string; ok: boolean; sweep: number }[];
    expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ kind: 'read', sweep: 1 })]);
    expect(await broker.getPositions()).toHaveLength(0);
  });

  it('if the kill switch cannot be engaged, nothing is closed', async () => {
    const broker = newSim();
    setBrokerForTests('paper', broker);
    await placeBuy(broker, 'guarded');
    seedCommand('cmd-killfail');
    db.failNext('set');
    const spy = vi.spyOn(broker, 'closePosition');

    await runAdminCommands();

    const cmd = readCommand('cmd-killfail');
    expect(cmd.status).toBe('failed');
    expect(cmd.result?.reason).toBe('kill_switch_not_engaged');
    expect(spy).not.toHaveBeenCalled();
    expect(await broker.getPositions()).toHaveLength(1);
    expect(db.peek('alerts/close_all_failed__cmd-killfail')).toMatchObject({ severity: 'critical', status: 'open' });
  });

  it('the lifecycle finalises a close_all trade as close_reason close_all', async () => {
    const broker = newSim();
    setBrokerForTests('paper', broker);
    const ticket = await placeBuy(broker, correlationComment('chat3_350'));
    seedTrade({ id: 'chat3_350', state: 'OPEN', positionTicket: ticket });
    seedCommand('cmd-finalise');

    await runAdminCommands();
    expect(readCommand('cmd-finalise').status).toBe('done');
    await runLifecycleTick();

    const trade = readTrade('chat3_350');
    expect(trade.state).toBe('CLOSED');
    expect(trade.result?.close_reason).toBe('close_all');
  });

  it('a position that appears between the sweeps is closed by the second sweep', async () => {
    const broker = newSim();
    setBrokerForTests('paper', broker);
    await placeBuy(broker, 'early');
    seedCommand('cmd-between');
    const late: number[] = [];
    const original = broker.closePosition.bind(broker);
    vi.spyOn(broker, 'closePosition').mockImplementation(async (ticket: number, volume?: number) => {
      if (late.length === 0) late.push(await placeBuy(broker, 'appeared-between-sweeps'));
      return original(ticket, volume);
    });

    await runAdminCommands();

    const cmd = readCommand('cmd-between');
    expect(cmd.status).toBe('done');
    expect(await broker.getPositions()).toHaveLength(0);
    const results = cmd.result?.results as { ticket?: number; sweep: number; ok: boolean }[];
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ ticket: late[0], sweep: 2, ok: true })]));
  });

  it('an entry that starts submitting during the first sweep is flagged for the reconciler', async () => {
    const broker = newSim();
    setBrokerForTests('paper', broker);
    await placeBuy(broker, 'open-first');
    seedCommand('cmd-inflight');
    const original = broker.closePosition.bind(broker);
    let seeded = false;
    vi.spyOn(broker, 'closePosition').mockImplementation((ticket: number, volume?: number) => {
      if (!seeded) {
        seeded = true;
        seedTrade({ id: 'chat3_370', state: 'SUBMITTING' });
      }
      return original(ticket, volume);
    });

    await runAdminCommands();

    expect(readCommand('cmd-inflight').status).toBe('done');
    const inFlight = readTrade('chat3_370');
    expect(inFlight.state).toBe('SUBMITTING');
    expect(inFlight.close_requested_by).toBe('close_all');
  });

  it('the second sweep runs only after the 10 s settle delay', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    vi.setSystemTime(T0);
    setCloseAllSettleMsForTests(null);
    const broker = newSim();
    setBrokerForTests('paper', broker);
    await placeBuy(broker, 'settle');
    seedCommand('cmd-settle');
    const reads = vi.spyOn(broker, 'getPositions');

    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const settleScheduled = (): boolean => timeouts.mock.calls.some((c) => c[1] === 10_000);
    const run = runAdminCommands();
    // setImmediate is not faked, so this drains the promise chain until the settle timer is scheduled.
    for (let i = 0; i < 200 && !settleScheduled(); i++) await new Promise((r) => setImmediate(r));
    expect(settleScheduled()).toBe(true);
    expect(reads).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(reads).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await run;

    expect(reads).toHaveBeenCalledTimes(2);
    expect(readCommand('cmd-settle').status).toBe('done');
    timeouts.mockRestore();
  });
});
