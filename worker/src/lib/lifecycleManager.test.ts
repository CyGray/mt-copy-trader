import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionProfile } from './executionProfile.js';
import { _resetAlertsForTests } from './alerts.js';
import { _resetBrokerRouterForTests, setBrokerForTests } from './brokerRouter.js';
import type { SymbolInfo } from './brokerTypes.js';
import { logger } from './logger.js';
import { _resetLifecycleManagerForTests, runLifecycleTick } from './lifecycleManager.js';
import { asFirestore, createFakeFirestore, type FakeFirestore } from './testing/fakeFirestore.js';
import { createSimulatedBroker, type SimState, type SimulatedBroker } from './simulatedBroker.js';
import { correlationComment, type TradeLifecycle, type TradeSetDoc, type TradeState } from './tradeSetTypes.js';

const fake = vi.hoisted(() => ({ firestore: null as unknown }));

vi.mock('./firestoreAdmin', () => ({ initFirestore: vi.fn(() => fake.firestore) }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./systemLog', () => ({ writeSystemLog: vi.fn(async () => true) }));

const MAGIC = 880001;
const FOREIGN_MAGIC = 990001;
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

interface EventRow {
  trade_set_id: string;
  event_key: string;
  type: string;
  reason_code?: string;
  [key: string]: unknown;
}

let db: FakeFirestore;

function profileFixture(patch: {
  after?: ExecutionProfile['stop_loss']['after_checkpoint'];
  be?: Partial<ExecutionProfile['break_even']>;
  trailing?: Partial<ExecutionProfile['trailing']>;
} = {}): ExecutionProfile {
  return {
    schema_version: 1,
    profile_id: 'gold-life-test',
    version: 1,
    name: 'lifecycle test',
    source: { type: 'manual' },
    broker: 'vantage_mt5',
    symbols: [{ signal_symbol: 'XAUUSD', broker_symbol: 'XAUUSD' }],
    entry: {
      policy: 'follow_signal',
      market_tolerance_price: 0.5,
      pending_expiry_minutes: 60,
      allow_market_fallback: false,
    },
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
    stop_loss: { min_distance_price: 2, max_distance_price: 25, after_checkpoint: patch.after ?? [] },
    break_even: { enabled: false, trigger: 'price_distance', trigger_value: 5, buffer_price: 0.2, ...patch.be },
    trailing: {
      enabled: false,
      activation: 'price_distance',
      activation_value: 3,
      distance_price: 2,
      step_price: 0.5,
      ...patch.trailing,
    },
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

function lifecycleFor(direction: 'buy' | 'sell', current = 0.1): TradeLifecycle {
  const prices = direction === 'buy' ? [2010, 2020, 2030] : [1990, 1980, 1970];
  return {
    checkpoints: [
      { tp_index: 1, price: prices[0], close_volume: 0.05, target_remaining_volume: 0.05, status: 'pending', attempts: 0 },
      { tp_index: 2, price: prices[1], close_volume: 0.03, target_remaining_volume: 0.02, status: 'pending', attempts: 0 },
      { tp_index: 3, price: prices[2], close_volume: 0.02, target_remaining_volume: 0, status: 'pending', attempts: 0 },
    ],
    current_volume: current,
    current_sl: direction === 'buy' ? 1995 : 2005,
    current_tp: direction === 'buy' ? 2030 : 1970,
    be_applied: false,
    trailing_active: false,
    best_price: 0,
  };
}

function readTrade(id: string): TradeSetDoc {
  const doc = db.peek(`trade_sets/${id}`);
  if (!doc) throw new Error(`no trade set ${id}`);
  return doc as unknown as TradeSetDoc;
}

function eventsFor(id: string): EventRow[] {
  return db
    .docs('trade_events')
    .map((d) => d.data as unknown as EventRow)
    .filter((e) => e.trade_set_id === id);
}

function seedTrade(o: {
  id: string;
  direction: 'buy' | 'sell';
  state: TradeState;
  profile?: ExecutionProfile | null;
  positionTicket?: number;
  orderTicket?: number;
  fill?: number;
  lifecycle?: TradeLifecycle | null;
  mode?: TradeSetDoc['mode'];
  closeRequestedBy?: 'close_all';
}): TradeSetDoc {
  const buy = o.direction === 'buy';
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
    direction: o.direction,
    order_type: buy ? 'BUY' : 'SELL',
    mode: o.mode ?? 'paper',
    broker: 'simulated',
    profile: profile ? { doc_id: `${profile.profile_id}__v1`, profile_id: profile.profile_id, version: 1 } : null,
    profile_snapshot: profile,
    limits_snapshot: null,
    state: o.state,
    correlation_comment: correlationComment(o.id),
    claim: { attempts: 1, claimed_at: T0.toISOString(), owner: 'test' },
    plan: {
      volume: 0.1,
      entry_ref_price: 2000,
      order_price: 0,
      sl: buy ? 1995 : 2005,
      broker_tp: buy ? 2030 : 1970,
      risk_money: 50,
      risk_percent: 0.5,
      checkpoints: [],
    },
    submission: { submitted_at: T0.toISOString(), expires_at: Math.floor(T0.getTime() / 1000) + 8, request_id: 'req' },
    broker_refs: {
      order_ticket: o.orderTicket ?? 0,
      position_ticket: o.positionTicket ?? 0,
      deal_ticket: 0,
      fill_price: o.fill ?? 2000,
      filled_volume: o.positionTicket ? 0.1 : 0,
    },
    lifecycle: o.lifecycle === undefined ? lifecycleFor(o.direction) : o.lifecycle,
    result: null,
    created_at: T0.toISOString(),
    updated_at: T0.toISOString(),
    ...(o.closeRequestedBy ? { close_requested_by: o.closeRequestedBy } : {}),
  };
  db.seed(`trade_sets/${o.id}`, doc as unknown as Record<string, unknown>);
  return doc as unknown as TradeSetDoc;
}

function newBroker(magic = MAGIC): SimulatedBroker {
  return createSimulatedBroker({ magic, symbols: { XAUUSD: SPEC } });
}

async function quoteBuy(broker: SimulatedBroker, bid: number): Promise<void> {
  await broker.setQuote('XAUUSD', bid, Math.round((bid + 0.2) * 100) / 100);
}

async function quoteSell(broker: SimulatedBroker, ask: number): Promise<void> {
  await broker.setQuote('XAUUSD', Math.round((ask - 0.2) * 100) / 100, ask);
}

/** Opens a BUY at 2000 with SL 1995 and TP 2030, and seeds the matching trade set. */
async function openBuy(broker: SimulatedBroker, id: string, profile?: ExecutionProfile | null): Promise<number> {
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
  seedTrade({ id, direction: 'buy', state: 'OPEN', positionTicket: res.positionTicket, profile });
  return res.positionTicket;
}

/** Opens a SELL at 2000 with SL 2005 and TP 1970, and seeds the matching trade set. */
async function openSell(broker: SimulatedBroker, id: string, profile?: ExecutionProfile | null): Promise<number> {
  await broker.setQuote('XAUUSD', 2000, 2000.2);
  const res = await broker.placeOrder({
    symbol: 'XAUUSD',
    orderType: 'SELL',
    volume: 0.1,
    price: 0,
    sl: 2005,
    tp: 1970,
    deviationPoints: 10,
    comment: correlationComment(id),
  });
  seedTrade({ id, direction: 'sell', state: 'OPEN', positionTicket: res.positionTicket, profile });
  return res.positionTicket;
}

function useBroker(broker: SimulatedBroker, mode: 'paper' | 'demo' | 'live' = 'paper'): void {
  setBrokerForTests(mode, broker);
}

function spyClose(broker: SimulatedBroker, onCall?: () => void) {
  const original = broker.closePosition.bind(broker);
  return vi.spyOn(broker, 'closePosition').mockImplementation((ticket: number, volume?: number) => {
    onCall?.();
    return original(ticket, volume);
  });
}

function memoryPersistence(store: { data: SimState | null }) {
  return {
    load: async (): Promise<SimState | null> => (store.data ? (JSON.parse(JSON.stringify(store.data)) as SimState) : null),
    save: async (state: SimState): Promise<void> => {
      store.data = JSON.parse(JSON.stringify(state)) as SimState;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = createFakeFirestore();
  fake.firestore = asFirestore(db);
  _resetLifecycleManagerForTests();
  _resetBrokerRouterForTests();
  _resetAlertsForTests();
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  _resetBrokerRouterForTests();
});

describe('partial closes at TP checkpoints', () => {
  it('TP1 reached: exactly one partial close of the right volume, persisted, SL intact', async () => {
    const broker = newBroker();
    useBroker(broker);
    const ticket = await openBuy(broker, 'chat1_100');
    await quoteBuy(broker, 2010);
    const spy = spyClose(broker);

    const summary = await runLifecycleTick();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(ticket, 0.05);
    expect(summary.partialCloses).toBe(1);
    const trade = readTrade('chat1_100');
    expect(trade.state).toBe('PARTIALLY_CLOSED');
    expect(trade.lifecycle?.checkpoints[0].status).toBe('done');
    expect(trade.lifecycle?.checkpoints[0].deal_ticket).toBeGreaterThan(0);
    expect(trade.lifecycle?.checkpoints[0].realized_pnl).toBe(50);
    expect(trade.lifecycle?.current_volume).toBe(0.05);
    const [pos] = await broker.getPositions();
    expect(pos.volume).toBe(0.05);
    expect(pos.sl).toBe(1995);
    const types = eventsFor('chat1_100').map((e) => e.event_key);
    expect(types).toEqual(expect.arrayContaining(['tp1_reached', 'tp1_partial_close_requested_1', 'tp1_partial_close_confirmed']));
  });

  it('persists the closing intent before the broker is asked to close', async () => {
    const broker = newBroker();
    useBroker(broker);
    await openBuy(broker, 'chat1_101');
    await quoteBuy(broker, 2010);
    const seen: string[] = [];
    spyClose(broker, () => seen.push(readTrade('chat1_101').lifecycle?.checkpoints[0].status ?? 'missing'));

    await runLifecycleTick();

    expect(seen).toEqual(['closing']);
  });

  it('running again at the same price closes nothing more', async () => {
    const broker = newBroker();
    useBroker(broker);
    await openBuy(broker, 'chat1_102');
    await quoteBuy(broker, 2010);
    const spy = spyClose(broker);
    await runLifecycleTick();
    const eventCount = eventsFor('chat1_102').length;

    const second = await runLifecycleTick();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(second.partialCloses).toBe(0);
    expect(eventsFor('chat1_102').length).toBe(eventCount);
    expect(readTrade('chat1_102').state).toBe('PARTIALLY_CLOSED');
  });

  it('TP2 then TP3 end CLOSED with checkpoints_complete and the realized total', async () => {
    const broker = newBroker();
    useBroker(broker);
    const ticket = await openBuy(broker, 'chat1_103');
    // No broker-side TP, so the final leg is closed by the manager rather than by evaluate().
    await broker.modifyPosition(ticket, 1995, 0);
    const spy = spyClose(broker);

    await quoteBuy(broker, 2010);
    await runLifecycleTick();
    await quoteBuy(broker, 2020);
    await runLifecycleTick();
    expect(readTrade('chat1_103').lifecycle?.current_volume).toBe(0.02);

    await quoteBuy(broker, 2030);
    await runLifecycleTick();
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenLastCalledWith(ticket, undefined);
    expect(await broker.getPositions()).toHaveLength(0);

    const summary = await runLifecycleTick();

    expect(summary.closed).toBe(1);
    const trade = readTrade('chat1_103');
    expect(trade.state).toBe('CLOSED');
    expect(trade.result?.close_reason).toBe('checkpoints_complete');
    expect(trade.result?.realized_pnl).toBe(170);
    expect(trade.lifecycle?.checkpoints.every((c) => c.status === 'done')).toBe(true);
    expect(eventsFor('chat1_103').map((e) => e.event_key)).toContain('position_closed');
  });

  it('a broker-side TP hit on the final checkpoint completes the trade without a second close', async () => {
    const broker = newBroker();
    useBroker(broker);
    await openBuy(broker, 'chat1_106');
    const spy = spyClose(broker);

    await quoteBuy(broker, 2010);
    await runLifecycleTick();
    await quoteBuy(broker, 2020);
    await runLifecycleTick();
    await quoteBuy(broker, 2030); // evaluate() fills the broker TP at 2030
    await runLifecycleTick();

    expect(spy).toHaveBeenCalledTimes(2);
    const trade = readTrade('chat1_106');
    expect(trade.state).toBe('CLOSED');
    expect(trade.result?.close_reason).toBe('checkpoints_complete');
    expect(trade.result?.realized_pnl).toBe(170);
    expect(trade.lifecycle?.checkpoints[2].status).toBe('done');
  });

  it('SELL: TP1 closes the right volume at a falling price, and never a second time', async () => {
    const broker = newBroker();
    useBroker(broker);
    const ticket = await openSell(broker, 'chat1_104');
    await quoteSell(broker, 1990);
    const spy = spyClose(broker);

    await runLifecycleTick();
    await runLifecycleTick();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(ticket, 0.05);
    expect(readTrade('chat1_104').state).toBe('PARTIALLY_CLOSED');
  });

  it('uses priceCurrent, not openPrice: a price that never reaches TP1 closes nothing', async () => {
    const broker = newBroker();
    useBroker(broker);
    await openBuy(broker, 'chat1_105');
    await quoteBuy(broker, 2009.5);
    const spy = spyClose(broker);

    await runLifecycleTick();

    expect(spy).not.toHaveBeenCalled();
    expect(readTrade('chat1_105').state).toBe('OPEN');
  });
});

describe('ambiguous and rejected partial closes', () => {
  it('ambiguous close that DID happen: next tick marks done without a second close', async () => {
    const broker = newBroker();
    useBroker(broker);
    await openBuy(broker, 'chat1_110');
    await quoteBuy(broker, 2010);
    const spy = spyClose(broker);
    broker.failNext('closePosition', 'ambiguous');

    await runLifecycleTick();
    expect(readTrade('chat1_110').lifecycle?.checkpoints[0].status).toBe('closing');
    expect((await broker.getPositions())[0].volume).toBe(0.05);

    await runLifecycleTick();

    expect(spy).toHaveBeenCalledTimes(1);
    const trade = readTrade('chat1_110');
    expect(trade.lifecycle?.checkpoints[0].status).toBe('done');
    expect(trade.state).toBe('PARTIALLY_CLOSED');
    expect(eventsFor('chat1_110').map((e) => e.event_key)).toContain('tp1_partial_close_confirmed');
  });

  it('ambiguous close that did NOT happen: retried only after ambiguous_until', async () => {
    const broker = newBroker();
    useBroker(broker);
    await openBuy(broker, 'chat1_111');
    await quoteBuy(broker, 2010);
    const spy = spyClose(broker);
    broker.failNext('closePosition', 'unavailable');

    await runLifecycleTick();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(readTrade('chat1_111').lifecycle?.checkpoints[0].status).toBe('closing');

    await runLifecycleTick();
    expect(spy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0.getTime() + 16_000);
    await runLifecycleTick();

    expect(spy).toHaveBeenCalledTimes(2);
    const cp = readTrade('chat1_111').lifecycle?.checkpoints[0];
    expect(cp?.status).toBe('done');
    expect(cp?.attempts).toBe(2);
    expect((await broker.getPositions())[0].volume).toBe(0.05);
  });

  it('a rejected close goes back to pending and is retried on the next tick', async () => {
    const broker = newBroker();
    useBroker(broker);
    await openBuy(broker, 'chat1_112');
    await quoteBuy(broker, 2010);
    broker.failNext('closePosition', 'reject');

    await runLifecycleTick();

    const cp = readTrade('chat1_112').lifecycle?.checkpoints[0];
    expect(cp?.status).toBe('pending');
    expect(cp?.attempts).toBe(1);
    expect(cp?.last_error).toBeTruthy();
    expect(eventsFor('chat1_112').map((e) => e.event_key)).toContain('tp1_partial_close_failed_1');
  });

  it('five rejections mark the checkpoint failed, record an event and log an error', async () => {
    const broker = newBroker();
    useBroker(broker);
    await openBuy(broker, 'chat1_113');
    await quoteBuy(broker, 2010);
    const spy = spyClose(broker);
    for (let i = 0; i < 5; i++) broker.failNext('closePosition', 'reject');

    for (let i = 0; i < 5; i++) await runLifecycleTick();
    await runLifecycleTick();

    expect(spy).toHaveBeenCalledTimes(5);
    const cp = readTrade('chat1_113').lifecycle?.checkpoints[0];
    expect(cp?.status).toBe('failed');
    expect(cp?.attempts).toBe(5);
    expect(readTrade('chat1_113').state).toBe('OPEN');
    expect(eventsFor('chat1_113').map((e) => e.event_key)).toContain('tp1_partial_close_failed_5');
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith('lifecycle_partial_close_failed', expect.anything());
    expect(db.peek('alerts/partial_close_failed__chat1_113_tp1')).toMatchObject({
      type: 'partial_close_failed',
      severity: 'error',
      status: 'open',
    });
  });

  it('a market-closed refusal (10018) does not consume close attempts and is retried after a minute', async () => {
    const broker = newBroker();
    useBroker(broker);
    await openBuy(broker, 'chat1_116');
    await quoteBuy(broker, 2010);
    const spy = spyClose(broker);
    for (let i = 0; i < 8; i++) broker.failNext('closePosition', 'reject', 10018);

    await runLifecycleTick();
    await runLifecycleTick();
    expect(spy).toHaveBeenCalledTimes(1);
    let cp = readTrade('chat1_116').lifecycle?.checkpoints[0];
    expect(cp).toMatchObject({ status: 'pending', attempts: 0 });

    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(Date.now() + 61_000);
      await runLifecycleTick();
    }
    cp = readTrade('chat1_116').lifecycle?.checkpoints[0];
    expect(spy).toHaveBeenCalledTimes(7);
    expect(cp?.status).toBe('pending');
    expect(db.peek('alerts/partial_close_failed__chat1_116_tp1')).toBeUndefined();

    // The market reopens: the close goes through.
    vi.setSystemTime(Date.now() + 61_000);
    await runLifecycleTick(); // 8th refusal (last injected fault)
    vi.setSystemTime(Date.now() + 61_000);
    await runLifecycleTick();
    expect(readTrade('chat1_116').lifecycle?.checkpoints[0].status).toBe('done');
  });

  it('a failed write of the closing intent means the close is never sent', async () => {
    const broker = newBroker();
    useBroker(broker);
    await openBuy(broker, 'chat1_114');
    await quoteBuy(broker, 2010);
    const spy = spyClose(broker);
    db.failNext('set');

    const summary = await runLifecycleTick();

    expect(spy).not.toHaveBeenCalled();
    expect(summary.errors).toBe(1);
    expect(readTrade('chat1_114').lifecycle?.checkpoints[0].status).toBe('pending');
    expect(eventsFor('chat1_114').map((e) => e.reason_code)).toContain('lifecycle_error');
  });
});

describe('break-even and trailing', () => {
  it('BUY break-even moves the SL once, and later ticks do not repeat it', async () => {
    const broker = newBroker();
    useBroker(broker);
    const profile = profileFixture({ be: { enabled: true, trigger: 'price_distance', trigger_value: 5, buffer_price: 0.2 } });
    await openBuy(broker, 'chat1_120', profile);
    await quoteBuy(broker, 2005);
    const modify = vi.spyOn(broker, 'modifyPosition');

    await runLifecycleTick();
    await runLifecycleTick();

    expect(modify).toHaveBeenCalledTimes(1);
    expect(modify).toHaveBeenCalledWith(expect.any(Number), 2000.2, 2030);
    const [pos] = await broker.getPositions();
    expect(pos.sl).toBe(2000.2);
    const trade = readTrade('chat1_120');
    expect(trade.lifecycle?.be_applied).toBe(true);
    expect(trade.lifecycle?.current_sl).toBe(2000.2);
    const keys = eventsFor('chat1_120').map((e) => e.event_key);
    expect(keys.filter((k) => k === 'break_even_applied')).toHaveLength(1);
    expect(keys).toContain('sl_modified_2000.20');
  });

  it('three failed stop moves in a row raise sl_modify_failed; the next successful move resolves it', async () => {
    const broker = newBroker();
    useBroker(broker);
    const profile = profileFixture({ be: { enabled: true, trigger: 'price_distance', trigger_value: 5, buffer_price: 0.2 } });
    await openBuy(broker, 'chat1_125', profile);
    await quoteBuy(broker, 2005);
    for (let i = 0; i < 3; i++) broker.failNext('modifyPosition', 'reject');

    await runLifecycleTick();
    await runLifecycleTick();
    expect(db.peek('alerts/sl_modify_failed__chat1_125')).toBeUndefined();
    await runLifecycleTick();
    expect(db.peek('alerts/sl_modify_failed__chat1_125')).toMatchObject({ status: 'open', severity: 'error' });

    await runLifecycleTick();
    const [pos] = await broker.getPositions();
    expect(pos.sl).toBe(2000.2);
    expect(db.peek('alerts/sl_modify_failed__chat1_125')).toMatchObject({ status: 'resolved', resolution: 'stop_moved' });
  });

  it('BE trigger uses priceCurrent: the SL moves although openPrice is the entry', async () => {
    const broker = newBroker();
    useBroker(broker);
    const profile = profileFixture({ be: { enabled: true, trigger: 'price_distance', trigger_value: 5, buffer_price: 0.2 } });
    await openBuy(broker, 'chat1_121', profile);
    await quoteBuy(broker, 2004.9);
    const modify = vi.spyOn(broker, 'modifyPosition');
    await runLifecycleTick();
    expect(modify).not.toHaveBeenCalled();

    await quoteBuy(broker, 2005.1);
    await runLifecycleTick();
    expect(modify).toHaveBeenCalledTimes(1);
  });

  it('BUY trailing follows the price up, never loosens, and waits for the step', async () => {
    const broker = newBroker();
    useBroker(broker);
    const profile = profileFixture({
      trailing: { enabled: true, activation: 'price_distance', activation_value: 3, distance_price: 2, step_price: 0.5 },
    });
    await openBuy(broker, 'chat1_122', profile);
    const modify = vi.spyOn(broker, 'modifyPosition');
    const sls: number[] = [];
    const step = async (bid: number) => {
      await quoteBuy(broker, bid);
      await runLifecycleTick();
      sls.push((await broker.getPositions())[0].sl);
    };

    await step(2003); // activates; SL 2001
    await step(2004); // SL 2002
    await step(2003.8); // retrace: no loosening
    await step(2004.3); // improvement 0.3 < step 0.5
    await step(2005); // SL 2003

    expect(sls).toEqual([2001, 2002, 2002, 2002, 2003]);
    expect(modify).toHaveBeenCalledTimes(3);
    expect(readTrade('chat1_122').lifecycle?.best_price).toBe(2005);
  });

  it('SELL trailing follows the price down and never loosens', async () => {
    const broker = newBroker();
    useBroker(broker);
    const profile = profileFixture({
      trailing: { enabled: true, activation: 'price_distance', activation_value: 3, distance_price: 2, step_price: 0.5 },
    });
    await openSell(broker, 'chat1_123', profile);
    const sls: number[] = [];
    const step = async (ask: number) => {
      await quoteSell(broker, ask);
      await runLifecycleTick();
      sls.push((await broker.getPositions())[0].sl);
    };

    await step(1996.5); // activates; SL 1998.5
    await step(1995); // SL 1997
    await step(1995.8); // retrace: no loosening
    await step(1994.6); // improvement 0.4 < step
    await step(1994); // SL 1996

    expect(sls).toEqual([1998.5, 1997, 1997, 1997, 1996]);
  });
});

describe('ownership and read failures', () => {
  it('a failed position read skips the mode and changes nothing', async () => {
    const broker = newBroker();
    useBroker(broker);
    await openBuy(broker, 'chat1_130');
    await quoteBuy(broker, 2010);
    const before = JSON.stringify(readTrade('chat1_130'));
    const spy = spyClose(broker);
    broker.failNext('getPositions', 'unavailable');

    const summary = await runLifecycleTick();

    expect(summary.skippedModes).toEqual(['paper']);
    expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(readTrade('chat1_130'))).toBe(before);
  });

  it('a failed deal read after a manual close does not mark the trade CLOSED', async () => {
    const broker = newBroker();
    useBroker(broker);
    const ticket = await openBuy(broker, 'chat1_131');
    await broker.closePosition(ticket);
    broker.failNext('getDeals', 'unavailable');

    await runLifecycleTick();
    expect(readTrade('chat1_131').state).toBe('OPEN');

    await runLifecycleTick();
    const trade = readTrade('chat1_131');
    expect(trade.state).toBe('CLOSED');
    expect(trade.result?.close_reason).toBe('manual');
  });

  it('a foreign position (other magic) or a same-magic unlinked position is never touched', async () => {
    const store = { data: null as SimState | null };
    const foreign = createSimulatedBroker({
      magic: FOREIGN_MAGIC,
      symbols: { XAUUSD: SPEC },
      persistence: memoryPersistence(store),
    });
    await foreign.setQuote('XAUUSD', 1999.9, 2000);
    const foreignRes = await foreign.placeOrder({
      symbol: 'XAUUSD',
      orderType: 'BUY',
      volume: 0.1,
      price: 0,
      sl: 1995,
      tp: 2030,
      deviationPoints: 10,
      comment: 'other-ea',
    });

    const broker = createSimulatedBroker({ magic: MAGIC, symbols: { XAUUSD: SPEC }, persistence: memoryPersistence(store) });
    useBroker(broker);
    const ours = await openBuy(broker, 'chat1_132');
    const manual = await broker.placeOrder({
      symbol: 'XAUUSD',
      orderType: 'BUY',
      volume: 0.1,
      price: 0,
      sl: 1995,
      tp: 2030,
      deviationPoints: 10,
      comment: 'manual-trade',
    });
    // A trade set that points at the foreign ticket must not manage it either.
    seedTrade({ id: 'chat1_133', direction: 'buy', state: 'OPEN', positionTicket: foreignRes.positionTicket });

    await quoteBuy(broker, 2010);
    const spy = spyClose(broker);
    const modify = vi.spyOn(broker, 'modifyPosition');
    await runLifecycleTick();
    await quoteBuy(broker, 2020);
    await runLifecycleTick();

    const closedTickets = spy.mock.calls.map((c) => c[0]);
    expect(closedTickets.every((t) => t === ours)).toBe(true);
    expect(modify).not.toHaveBeenCalled();
    const foreignNow = store.data?.positions.find((p) => p.ticket === foreignRes.positionTicket);
    expect(foreignNow?.volume).toBe(0.1);
    expect(foreignNow?.sl).toBe(1995);
    const manualNow = store.data?.positions.find((p) => p.ticket === manual.positionTicket);
    expect(manualNow?.volume).toBe(0.1);
    expect(manualNow?.sl).toBe(1995);
    expect(readTrade('chat1_133').state).toBe('OPEN');
  });

  it('kill switch, disabled mode and a later profile change do not alter an open trade', async () => {
    const broker = newBroker();
    useBroker(broker);
    const profile = profileFixture({ be: { enabled: false, trigger: 'price_distance', trigger_value: 5, buffer_price: 0.2 } });
    await openBuy(broker, 'chat1_134', profile);
    db.seed('settings/default', {
      execution: { mode: 'disabled', active_profile_doc_id: 'gold-life-test__v2' },
      trading: { kill_switch: true },
    });
    db.seed('execution_profiles/gold-life-test__v2', {
      ...profileFixture({ be: { enabled: true, trigger: 'price_distance', trigger_value: 5, buffer_price: 0.2 } }),
      version: 2,
      status: 'active',
    });
    await quoteBuy(broker, 2010);
    const modify = vi.spyOn(broker, 'modifyPosition');
    const spy = spyClose(broker);

    await runLifecycleTick();
    await quoteBuy(broker, 2006);
    await runLifecycleTick();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(modify).not.toHaveBeenCalled();
    expect(readTrade('chat1_134').lifecycle?.checkpoints[0].status).toBe('done');
  });

  it('a trade whose processing throws does not stop the other trades', async () => {
    const broker = newBroker();
    useBroker(broker);
    await openBuy(broker, 'chat1_135');
    await openBuy(broker, 'chat1_136');
    seedTrade({ id: 'chat1_137', direction: 'buy', state: 'OPEN', positionTicket: 0, profile: null });
    await quoteBuy(broker, 2010);
    const spy = spyClose(broker);

    const summary = await runLifecycleTick();

    expect(summary.errors).toBeGreaterThanOrEqual(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(readTrade('chat1_135').state).toBe('PARTIALLY_CLOSED');
    expect(readTrade('chat1_136').state).toBe('PARTIALLY_CLOSED');
    expect(eventsFor('chat1_137').map((e) => e.reason_code)).toContain('lifecycle_error');
  });

  it('one positions read per broker per tick, however many trades it manages', async () => {
    const broker = newBroker();
    useBroker(broker);
    await openBuy(broker, 'chat1_138');
    await openBuy(broker, 'chat1_139');
    const positions = vi.spyOn(broker, 'getPositions');
    const orders = vi.spyOn(broker, 'getOrders');

    await runLifecycleTick();

    expect(positions).toHaveBeenCalledTimes(1);
    expect(orders).toHaveBeenCalledTimes(1);
  });
});

describe('closure by the broker', () => {
  it('a position closed by the broker stop-loss ends CLOSED with close_reason sl', async () => {
    const broker = newBroker();
    useBroker(broker);
    await openBuy(broker, 'chat1_140');
    await quoteBuy(broker, 1994.9);

    const summary = await runLifecycleTick();

    expect(summary.closed).toBe(1);
    const trade = readTrade('chat1_140');
    expect(trade.state).toBe('CLOSED');
    expect(trade.result?.close_reason).toBe('sl');
    expect(trade.result?.realized_pnl).toBe(-50);
    expect(trade.lifecycle?.checkpoints.every((c) => c.status === 'pending')).toBe(true);
    expect(eventsFor('chat1_140').map((e) => e.event_key)).toContain('position_closed');
  });
});

describe('pending orders', () => {
  async function placePending(broker: SimulatedBroker, id: string): Promise<number> {
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
    seedTrade({ id, direction: 'buy', state: 'PENDING_ORDER', orderTicket: res.orderTicket, fill: 0, lifecycle: lifecycleFor('buy', 0.1) });
    return res.orderTicket;
  }

  it('a resting order is left alone', async () => {
    const broker = newBroker();
    useBroker(broker);
    await placePending(broker, 'chat1_150');

    await runLifecycleTick();

    expect(readTrade('chat1_150').state).toBe('PENDING_ORDER');
  });

  it('a pending order that fills below the planned volume gets checkpoints re-planned for the fill', async () => {
    const broker = newBroker();
    useBroker(broker);
    await broker.setQuote('XAUUSD', 1999.9, 2000);
    const res = await broker.placeOrder({
      symbol: 'XAUUSD',
      orderType: 'BUY_LIMIT',
      volume: 0.05,
      price: 1995,
      sl: 1990,
      tp: 0,
      deviationPoints: 10,
      comment: correlationComment('chat1_153'),
    });
    seedTrade({ id: 'chat1_153', direction: 'buy', state: 'PENDING_ORDER', orderTicket: res.orderTicket, fill: 0, lifecycle: lifecycleFor('buy', 0.1) });
    await broker.setQuote('XAUUSD', 1994.7, 1994.9);

    await runLifecycleTick();

    const trade = readTrade('chat1_153');
    expect(trade.state).toBe('OPEN');
    expect(trade.lifecycle?.current_volume).toBe(0.05);
    expect(trade.lifecycle?.checkpoints.map((c) => c.close_volume)).toEqual([0.02, 0.01, 0.02]);
    expect(trade.lifecycle?.checkpoints.map((c) => c.target_remaining_volume)).toEqual([0.03, 0.02, 0]);

    const spy = spyClose(broker);
    await quoteBuy(broker, 2010);
    await runLifecycleTick();
    // A pending order fills into a position with the order's ticket.
    expect(spy).toHaveBeenCalledWith(res.orderTicket, 0.02);
    expect((await broker.getPositions())[0].volume).toBe(0.03);
  });

  it('a filled pending order becomes OPEN with the position and fill price', async () => {
    const broker = newBroker();
    useBroker(broker);
    await placePending(broker, 'chat1_151');
    await broker.setQuote('XAUUSD', 1994.7, 1994.9);

    await runLifecycleTick();

    const trade = readTrade('chat1_151');
    expect(trade.state).toBe('OPEN');
    expect(trade.broker_refs?.position_ticket).toBeGreaterThan(0);
    expect(trade.broker_refs?.fill_price).toBe(1995);
    const keys = eventsFor('chat1_151').map((e) => e.event_key);
    expect(keys).toEqual(expect.arrayContaining(['pending_order_filled', 'entry_confirmed']));
  });

  it('a pending order that disappears without a position is CANCELLED', async () => {
    const broker = newBroker();
    useBroker(broker);
    const orderTicket = await placePending(broker, 'chat1_152');
    await broker.cancelOrder(orderTicket);

    const summary = await runLifecycleTick();

    expect(summary.pendingCancelled).toBe(1);
    expect(readTrade('chat1_152').state).toBe('CANCELLED');
    expect(eventsFor('chat1_152').map((e) => e.event_key)).toContain('pending_order_cancelled');
  });
});

describe('restart safety', () => {
  it('a new process with the same Firestore state continues without a duplicate close', async () => {
    const persistence = {
      load: async (): Promise<SimState | null> => (db.peek('paper_broker/state') as unknown as SimState | undefined) ?? null,
      save: async (state: SimState): Promise<void> => {
        db.seed('paper_broker/state', state as unknown as Record<string, unknown>);
      },
    };
    const first = createSimulatedBroker({ magic: MAGIC, symbols: { XAUUSD: SPEC }, persistence });
    useBroker(first);
    await openBuy(first, 'chat1_160');
    await quoteBuy(first, 2010);
    await runLifecycleTick();
    expect((await first.getPositions())[0].volume).toBe(0.05);

    // Restart: a fresh broker and manager state, same Firestore.
    _resetLifecycleManagerForTests();
    _resetBrokerRouterForTests();
    const second = createSimulatedBroker({ magic: MAGIC, symbols: { XAUUSD: SPEC }, persistence });
    useBroker(second);
    const spy = spyClose(second);

    await runLifecycleTick();
    expect(spy).not.toHaveBeenCalled();

    await quoteBuy(second, 2020);
    await runLifecycleTick();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.any(Number), 0.03);
    expect((await second.getPositions())[0].volume).toBe(0.02);
    expect(readTrade('chat1_160').lifecycle?.checkpoints.map((c) => c.status)).toEqual(['done', 'done', 'pending']);
  });
});
