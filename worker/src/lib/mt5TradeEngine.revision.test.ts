import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fs: null as unknown,
}));

vi.mock('./firestoreAdmin', () => ({ initFirestore: () => h.fs }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { createFakeFirestore, type FakeFirestore } from './testing/fakeFirestore.js';
import { createSimulatedBroker, type SimulatedBroker } from './simulatedBroker.js';
import { _resetBrokerRouterForTests, setBrokerForTests } from './brokerRouter.js';
import { invalidateExecutionControl } from './executionControl.js';
import { handleSignalEvent, type SignalEventInput } from './mt5TradeEngine.js';
import type { BrokerAdapter, SymbolInfo } from './brokerTypes.js';
import type { GoldSignal } from './vipSignalParser.js';
import type { TradeSetDoc } from './tradeSetTypes.js';

const MAGIC = 98801;
const CHAT = '-1003271337051';
const PROFILE_DOC = 'xau-test-profile__v1';

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

const SAFETY = {
  max_risk_percent_per_trade: 1,
  max_risk_money_per_trade: 50,
  max_lots_per_trade: 1,
  max_concurrent_positions: 3,
  max_positions_per_symbol: 1,
  daily_loss_limit_money: 100,
  max_total_risk_percent: 3,
  max_spread_price: 0.5,
  max_deviation_points: 30,
  max_signal_age_sec: 120,
  min_margin_level_percent: 200,
  allowed_signal_symbols: ['XAUUSD'],
};

const PROFILE = {
  schema_version: 1,
  profile_id: 'xau-test-profile',
  version: 1,
  name: 'Test profile',
  source: { type: 'manual' },
  broker: 'vantage_mt5',
  symbols: [{ signal_symbol: 'XAUUSD', broker_symbol: 'XAUUSD' }],
  entry: { policy: 'follow_signal', market_tolerance_price: 0.5, pending_expiry_minutes: 60, allow_market_fallback: false },
  sizing: { mode: 'equity_risk_percent', risk_percent: 0.5, below_min_volume: 'skip' },
  take_profit: {
    checkpoints: [
      { tp_index: 1, close_percent: 50 },
      { tp_index: 2, close_percent: 30 },
      { tp_index: 3, close_percent: 20 },
    ],
    missing_tp: 'skip_trade',
    infeasible_split: 'merge_into_next',
    broker_tp: 'final_checkpoint',
  },
  stop_loss: { min_distance_price: 2, max_distance_price: 25, after_checkpoint: [] },
  break_even: { enabled: false, trigger: 'price_distance', trigger_value: 5, buffer_price: 0.2 },
  trailing: { enabled: false, activation: 'after_tp_index', activation_value: 2, distance_price: 3, step_price: 0.5 },
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
    before_fill: 'apply_sl_tp',
    after_fill: 'apply_tighten_only',
    unparseable_edit: 'cancel_pending_only',
    explicit_cancel: 'close_position',
  },
};

const BUY_SIGNAL: GoldSignal = {
  symbol: 'XAUUSD',
  direction: 'buy',
  orderType: 'market',
  entryLow: 1999,
  entryHigh: 2001,
  stopLoss: 1995,
  takeProfits: [2005, 2010, 2020],
};

const BUY_LIMIT_SIGNAL: GoldSignal = {
  symbol: 'XAUUSD',
  direction: 'buy',
  orderType: 'buy_limit',
  entryLow: 1995,
  entryHigh: 1998,
  stopLoss: 1993,
  takeProfits: [2005, 2010, 2020],
};

function fs(): FakeFirestore {
  return h.fs as FakeFirestore;
}

function makeSim(): SimulatedBroker {
  return createSimulatedBroker({
    magic: MAGIC,
    account: { tradeMode: 'DEMO', balance: 10000 },
    symbols: { XAUUSD: { ...SPEC } },
  });
}

async function demoSim(): Promise<SimulatedBroker> {
  const sim = makeSim();
  await sim.setQuote('XAUUSD', 2000, 2000.2);
  setBrokerForTests('demo', sim);
  return sim;
}

function seedControl(
  over: { mode?: string; killSwitch?: boolean; activeDocId?: string; profiles?: Record<string, unknown> } = {},
): void {
  const activeDocId = over.activeDocId ?? PROFILE_DOC;
  fs().seed('settings/default', {
    execution: { mode: over.mode ?? 'demo', active_profile_doc_id: activeDocId },
    trading: { kill_switch: over.killSwitch ?? false },
    safety: SAFETY,
  });
  fs().seed(`execution_profiles/${PROFILE_DOC}`, { ...PROFILE, status: 'active' });
  for (const [docId, body] of Object.entries(over.profiles ?? {})) {
    fs().seed(`execution_profiles/${docId}`, { ...(body as Record<string, unknown>), status: 'active' });
  }
  invalidateExecutionControl();
}

let seq = 0;
function event(over: Partial<SignalEventInput> = {}): SignalEventInput {
  seq += 1;
  return {
    eventId: `${CHAT}_${over.messageId ?? '1'}_evt${seq}`,
    chatId: CHAT,
    messageId: '1',
    messageDate: new Date().toISOString(),
    messageType: 'new',
    kind: 'signal',
    signal: BUY_SIGNAL,
    ...over,
  };
}

function edit(messageId: string, signal: GoldSignal, eventId: string): SignalEventInput {
  return event({ eventId, messageId, messageType: 'edit', signal });
}

function cancel(messageId: string, cancelReason: 'unparseable_edit' | 'explicit_cancel', eventId: string): SignalEventInput {
  return {
    eventId,
    chatId: CHAT,
    messageId,
    messageDate: null,
    messageType: 'edit',
    kind: 'cancel',
    signal: null,
    cancelReason,
  };
}

/**
 * A stored trade set with the fields the assertions read. Sets that never reached
 * SUBMITTING have nulls there; tests only read those fields on sets that did.
 */
type StoredTradeSet = TradeSetDoc & {
  plan: NonNullable<TradeSetDoc['plan']>;
  broker_refs: NonNullable<TradeSetDoc['broker_refs']>;
  lifecycle: NonNullable<TradeSetDoc['lifecycle']>;
  profile: NonNullable<TradeSetDoc['profile']>;
  submission: NonNullable<TradeSetDoc['submission']>;
  result: NonNullable<TradeSetDoc['result']>;
};

function tradeSet(id: string): StoredTradeSet {
  return (fs().peek(`trade_sets/${id}`) ?? {}) as unknown as StoredTradeSet;
}

function eventTypes(id: string): string[] {
  return fs()
    .docs('trade_events')
    .map((e) => e.data)
    .filter((e) => e.trade_set_id === id)
    .map((e) => e.type as string);
}

/** Records broker calls. Throws on use unless `inner` is given. */
function trapBroker(kind: 'mt5' | 'simulated', inner?: BrokerAdapter): { broker: BrokerAdapter; calls: string[] } {
  const calls: string[] = [];
  const methods = [
    'ping', 'getAccountInfo', 'getSymbolInfo', 'getPositions', 'getOrders', 'getDeals',
    'checkOrder', 'placeOrder', 'modifyPosition', 'modifyPendingOrder', 'closePosition', 'cancelOrder',
  ];
  const broker: Record<string, unknown> = { kind, magic: MAGIC };
  for (const method of methods) {
    broker[method] = async (...args: unknown[]) => {
      calls.push(method);
      if (!inner) throw new Error(`unexpected broker call ${method}`);
      return (inner as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args);
    };
  }
  return { broker: broker as unknown as BrokerAdapter, calls };
}

/** Opens a market BUY on `messageId`: entry 2000.2, SL 1995, TPs 2005 / 2010 / 2020. */
async function openBuy(sim: SimulatedBroker, messageId: string): Promise<string> {
  const result = await handleSignalEvent(event({ messageId, eventId: `open-${messageId}` }));
  expect(result).toMatchObject({ state: 'OPEN' });
  expect((await sim.getPositions()).length).toBeGreaterThan(0);
  return `${CHAT}_${messageId}`;
}

describe('mt5TradeEngine revisions and cancels', () => {
  beforeEach(() => {
    h.fs = createFakeFirestore();
    seq = 0;
    invalidateExecutionControl();
    delete process.env.BYTRADER_LIVE_TRADING;
  });

  afterEach(() => {
    _resetBrokerRouterForTests();
  });

  describe('revisions to an open trade', () => {
    it('applies a tighter stop loss (apply_tighten_only) and updates the lifecycle', async () => {
      const sim = await demoSim();
      seedControl();
      const id = await openBuy(sim, '4001');

      const result = await handleSignalEvent(
        edit('4001', { ...BUY_SIGNAL, stopLoss: 1998 }, 'rev-tight'),
      );
      expect(result).toMatchObject({ outcome: 'revision', state: 'OPEN' });

      const [pos] = await sim.getPositions();
      expect(pos.sl).toBe(1998);
      expect(pos.tp).toBe(2020);
      expect(tradeSet(id).lifecycle.current_sl).toBe(1998);
      expect(tradeSet(id).signal_revisions).toEqual([
        expect.objectContaining({ event_id: 'rev-tight', outcome: 'applied' }),
      ]);
      expect(eventTypes(id)).toEqual(expect.arrayContaining(['sl_modified', 'signal_revision_applied']));
    });

    it('ignores a loosening stop loss under apply_tighten_only', async () => {
      const sim = await demoSim();
      seedControl();
      const id = await openBuy(sim, '4002');

      const result = await handleSignalEvent(edit('4002', { ...BUY_SIGNAL, stopLoss: 1990 }, 'rev-loose'));
      expect(result).toMatchObject({ outcome: 'revision', state: 'OPEN' });
      expect(result.reason).toContain('sl_loosen_ignored');

      const [pos] = await sim.getPositions();
      expect(pos.sl).toBe(1995);
      expect(tradeSet(id).signal_revisions[0]).toMatchObject({ outcome: 'ignored' });
      expect(tradeSet(id).signal_revisions[0].reason).toContain('sl_loosen_ignored');
      expect(eventTypes(id)).toContain('signal_revision_ignored');
    });

    it('updates only pending checkpoints; a done checkpoint keeps its price; broker TP follows the final checkpoint', async () => {
      const sim = await demoSim();
      seedControl();
      const id = await openBuy(sim, '4003');

      // Mark TP1 as already closed, so its price must not move.
      const doc = tradeSet(id);
      const [cp1, cp2, cp3] = doc.lifecycle.checkpoints;
      fs().seed(`trade_sets/${id}`, {
        ...doc,
        lifecycle: { ...doc.lifecycle, checkpoints: [{ ...cp1, status: 'done', price: 2005 }, cp2, cp3] },
      });

      const result = await handleSignalEvent(
        edit('4003', { ...BUY_SIGNAL, takeProfits: [2007, 2011, 2025] }, 'rev-tp'),
      );
      expect(result).toMatchObject({ outcome: 'revision', state: 'OPEN' });

      const after = tradeSet(id);
      expect(after.lifecycle.checkpoints.map((c: { price: number }) => c.price)).toEqual([2005, 2011, 2025]);
      expect(after.plan.checkpoints.map((c: { price: number }) => c.price)).toEqual([2005, 2011, 2025]);
      const [pos] = await sim.getPositions();
      expect(pos.tp).toBe(2025);
      expect(pos.sl).toBe(1995);
    });

    it('ignores a revision on a SKIPPED trade set without any broker call', async () => {
      const sim = await demoSim();
      seedControl();
      await sim.setQuote('XAUUSD', 2000, 2000.6);
      const skipped = await handleSignalEvent(event({ messageId: '4004', eventId: 'skip-4004' }));
      expect(skipped).toMatchObject({ state: 'SKIPPED', reason: 'spread_too_wide' });
      await sim.setQuote('XAUUSD', 2000, 2000.2);

      const result = await handleSignalEvent(edit('4004', { ...BUY_SIGNAL, stopLoss: 1998 }, 'rev-skip'));
      expect(result).toMatchObject({ outcome: 'revision', state: 'SKIPPED', reason: 'state_SKIPPED' });
      expect(await sim.getPositions()).toHaveLength(0);
      expect(await sim.getOrders()).toHaveLength(0);
    });

    it('applies the same revision event once', async () => {
      const sim = await demoSim();
      seedControl();
      const id = await openBuy(sim, '4005');
      const revision = edit('4005', { ...BUY_SIGNAL, stopLoss: 1998 }, 'rev-once');

      expect(await handleSignalEvent(revision)).toMatchObject({ outcome: 'revision', state: 'OPEN' });
      expect(await handleSignalEvent(revision)).toMatchObject({
        outcome: 'noop',
        reason: 'revision_already_applied',
      });
      expect(tradeSet(id).signal_revisions).toHaveLength(1);
      expect((await sim.getPositions())[0].sl).toBe(1998);
    });

    it('uses the frozen profile snapshot, not the currently active profile', async () => {
      const sim = await demoSim();
      seedControl();
      const id = await openBuy(sim, '4006');

      // Activate a later version that ignores after-fill edits.
      const v2 = {
        ...PROFILE,
        version: 2,
        edits: { ...PROFILE.edits, after_fill: 'ignore' },
      };
      seedControl({ activeDocId: 'xau-test-profile__v2', profiles: { 'xau-test-profile__v2': v2 } });

      const result = await handleSignalEvent(edit('4006', { ...BUY_SIGNAL, stopLoss: 1998 }, 'rev-snapshot'));
      expect(result).toMatchObject({ outcome: 'revision', state: 'OPEN' });
      expect((await sim.getPositions())[0].sl).toBe(1998);
      expect(tradeSet(id).profile.version).toBe(1);
    });

    it('acts in the trade set mode, not the current execution mode', async () => {
      const sim = await demoSim();
      seedControl();
      const id = await openBuy(sim, '4007');

      const paper = trapBroker('simulated');
      setBrokerForTests('paper', paper.broker);
      seedControl({ mode: 'paper' });

      const result = await handleSignalEvent(edit('4007', { ...BUY_SIGNAL, stopLoss: 1998 }, 'rev-mode'));
      expect(result).toMatchObject({ outcome: 'revision', state: 'OPEN' });
      expect((await sim.getPositions())[0].sl).toBe(1998);
      expect(tradeSet(id).mode).toBe('demo');
      expect(paper.calls).toEqual([]);
    });

    it('still applies revisions and closes on explicit cancel while the kill switch is engaged', async () => {
      const sim = await demoSim();
      seedControl();
      const id = await openBuy(sim, '4008');

      seedControl({ killSwitch: true });
      const revised = await handleSignalEvent(edit('4008', { ...BUY_SIGNAL, stopLoss: 1998 }, 'rev-ks'));
      expect(revised).toMatchObject({ outcome: 'revision', state: 'OPEN' });
      expect((await sim.getPositions())[0].sl).toBe(1998);

      const closed = await handleSignalEvent(cancel('4008', 'explicit_cancel', 'cancel-ks'));
      expect(closed).toMatchObject({ outcome: 'cancel', state: 'CLOSED' });
      expect(tradeSet(id).state).toBe('CLOSED');
    });
  });

  describe('revisions to a pending order', () => {
    it('modifies the pending order SL and TP under apply_sl_tp', async () => {
      const sim = await demoSim();
      seedControl();
      const pending = await handleSignalEvent(event({ messageId: '4101', eventId: 'pend-4101', signal: BUY_LIMIT_SIGNAL }));
      expect(pending).toMatchObject({ state: 'PENDING_ORDER' });

      const result = await handleSignalEvent(
        edit('4101', { ...BUY_LIMIT_SIGNAL, stopLoss: 1992, takeProfits: [2006, 2011, 2025] }, 'rev-pend'),
      );
      expect(result).toMatchObject({ outcome: 'revision', state: 'PENDING_ORDER' });

      const [order] = await sim.getOrders();
      expect(order).toMatchObject({ priceOpen: 1998, sl: 1992, tp: 2025 });
      const doc = tradeSet(`${CHAT}_4101`);
      expect(doc.plan.sl).toBe(1992);
      expect(doc.plan.broker_tp).toBe(2025);
      expect(doc.lifecycle.checkpoints.map((c: { price: number }) => c.price)).toEqual([2006, 2011, 2025]);
    });

    it('ignores pending-order revisions when before_fill is ignore', async () => {
      const sim = await demoSim();
      const ignoring = { ...PROFILE, edits: { ...PROFILE.edits, before_fill: 'ignore' } };
      seedControl({ profiles: {} });
      fs().seed(`execution_profiles/${PROFILE_DOC}`, { ...ignoring, status: 'active' });
      invalidateExecutionControl();

      await handleSignalEvent(event({ messageId: '4102', eventId: 'pend-4102', signal: BUY_LIMIT_SIGNAL }));
      const result = await handleSignalEvent(edit('4102', { ...BUY_LIMIT_SIGNAL, stopLoss: 1992 }, 'rev-ignored'));
      expect(result).toMatchObject({ outcome: 'revision', state: 'PENDING_ORDER', reason: 'before_fill_ignore' });
      expect((await sim.getOrders())[0].sl).toBe(1993);
    });
  });

  describe('cancels', () => {
    it('never closes an open position on an unparseable edit', async () => {
      const sim = await demoSim();
      seedControl();
      const id = await openBuy(sim, '4201');

      const result = await handleSignalEvent(cancel('4201', 'unparseable_edit', 'cancel-unparse'));
      expect(result).toMatchObject({ outcome: 'cancel', state: 'OPEN', reason: 'policy_keeps_open_position' });
      expect(await sim.getPositions()).toHaveLength(1);
      expect(tradeSet(id).state).toBe('OPEN');
    });

    it('cancels a pending order on an unparseable edit under cancel_pending_only', async () => {
      const sim = await demoSim();
      seedControl();
      const id = `${CHAT}_4202`;
      await handleSignalEvent(event({ messageId: '4202', eventId: 'pend-4202', signal: BUY_LIMIT_SIGNAL }));
      expect(await sim.getOrders()).toHaveLength(1);

      const result = await handleSignalEvent(cancel('4202', 'unparseable_edit', 'cancel-pend'));
      expect(result).toMatchObject({ outcome: 'cancel', state: 'CANCELLED' });
      expect(await sim.getOrders()).toHaveLength(0);
      expect(tradeSet(id).state).toBe('CANCELLED');
      expect(eventTypes(id)).toContain('pending_order_cancelled');
    });

    it('closes an open position on explicit cancel under close_position, recording the realized result', async () => {
      const sim = await demoSim();
      seedControl();
      const id = await openBuy(sim, '4203');

      const result = await handleSignalEvent(cancel('4203', 'explicit_cancel', 'cancel-close'));
      expect(result).toMatchObject({ outcome: 'cancel', state: 'CLOSED', reason: 'explicit_cancel' });
      expect(await sim.getPositions()).toHaveLength(0);

      const doc = tradeSet(id);
      expect(doc.state).toBe('CLOSED');
      expect(doc.result.close_reason).toBe('cancel');
      // Entered at 2000.2, closed at bid 2000.00 on 0.09 lots: -1.8 USD.
      expect(doc.result.realized_pnl).toBeCloseTo(-1.8, 2);
      expect(eventTypes(id)).toContain('position_closed');
    });

    it('ignores an explicit cancel on an open position under cancel_pending_only', async () => {
      const sim = await demoSim();
      // The trade is entered under a profile whose frozen snapshot says cancel_pending_only.
      const pendingOnly = { ...PROFILE, edits: { ...PROFILE.edits, explicit_cancel: 'cancel_pending_only' } };
      seedControl({ profiles: { [PROFILE_DOC]: pendingOnly } });
      const id = await openBuy(sim, '4204');

      const result = await handleSignalEvent(cancel('4204', 'explicit_cancel', 'cancel-keep'));
      expect(result).toMatchObject({ outcome: 'cancel', state: 'OPEN', reason: 'policy_keeps_open_position' });
      expect(await sim.getPositions()).toHaveLength(1);
      expect(tradeSet(id).state).toBe('OPEN');
    });

    it('never closes a position when the cancel reason is missing', async () => {
      const sim = await demoSim();
      seedControl();
      await openBuy(sim, '4205');

      const ev = cancel('4205', 'explicit_cancel', 'cancel-noreason');
      delete ev.cancelReason;
      const result = await handleSignalEvent(ev);
      expect(result).toMatchObject({ outcome: 'cancel', state: 'OPEN' });
      expect(await sim.getPositions()).toHaveLength(1);
    });

    it('sets cancel_requested when the cancel arrives during SUBMIT_UNKNOWN and does not touch the broker', async () => {
      const sim = await demoSim();
      seedControl();
      sim.failNext('placeOrder', 'ambiguous');
      const id = `${CHAT}_4206`;
      expect(await handleSignalEvent(event({ messageId: '4206', eventId: 'amb-4206' }))).toMatchObject({
        state: 'SUBMIT_UNKNOWN',
      });
      expect(await sim.getPositions()).toHaveLength(1);

      const result = await handleSignalEvent(cancel('4206', 'explicit_cancel', 'cancel-amb'));
      expect(result).toMatchObject({ outcome: 'cancel', state: 'SUBMIT_UNKNOWN', reason: 'cancel_requested' });
      expect(tradeSet(id).state).toBe('SUBMIT_UNKNOWN');
      expect(tradeSet(id).cancel_requested).toMatchObject({ reason: 'explicit_cancel', event_id: 'cancel-amb' });
      expect(await sim.getPositions()).toHaveLength(1);
    });

    it('records nothing and returns noop when there is no trade set for the cancelled message', async () => {
      await demoSim();
      seedControl();
      const result = await handleSignalEvent(cancel('4301', 'explicit_cancel', 'cancel-none'));
      expect(result).toEqual({ outcome: 'noop', reason: 'no_trade_set' });
      expect(fs().docs('trade_events')).toEqual([]);
    });
  });
});
