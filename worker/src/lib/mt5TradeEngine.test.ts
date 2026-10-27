import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fs: null as unknown,
  controlOverride: null as null | ((control: Record<string, unknown>) => Record<string, unknown>),
}));

vi.mock('./firestoreAdmin', () => ({ initFirestore: () => h.fs }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./executionControl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./executionControl')>();
  return {
    ...actual,
    getExecutionControl: async () => {
      const control = await actual.getExecutionControl();
      if (!h.controlOverride) return control;
      return h.controlOverride(control as unknown as Record<string, unknown>) as unknown as typeof control;
    },
  };
});

import { createFakeFirestore, type FakeFirestore } from './testing/fakeFirestore.js';
import { createSimulatedBroker, type SimulatedBroker } from './simulatedBroker.js';
import { _resetAlertsForTests } from './alerts.js';
import { _resetBrokerRouterForTests, setBrokerForTests } from './brokerRouter.js';
import { invalidateExecutionControl } from './executionControl.js';
import { handleSignalEvent, type SignalEventInput } from './mt5TradeEngine.js';
import type { AccountInfo, BrokerAdapter, PlaceOrderRequest, SymbolInfo } from './brokerTypes.js';
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

function fs(): FakeFirestore {
  return h.fs as FakeFirestore;
}

function makeSim(spec: Partial<SymbolInfo> = {}, account: Partial<AccountInfo> = {}): SimulatedBroker {
  return createSimulatedBroker({
    magic: MAGIC,
    account: { tradeMode: 'DEMO', balance: 10000, ...account },
    symbols: { XAUUSD: { ...SPEC, ...spec } },
  });
}

/** Sim broker registered as the demo broker, with a 2000.00 / 2000.20 quote. */
async function demoSim(spec: Partial<SymbolInfo> = {}, account: Partial<AccountInfo> = {}): Promise<SimulatedBroker> {
  const sim = makeSim(spec, account);
  await sim.setQuote('XAUUSD', 2000, 2000.2);
  setBrokerForTests('demo', sim);
  return sim;
}

function seedControl(
  over: {
    mode?: string;
    killSwitch?: boolean;
    profile?: unknown;
    noProfile?: boolean;
    safety?: unknown;
  } = {},
): void {
  const execution: Record<string, unknown> = { mode: over.mode ?? 'demo' };
  if (!over.noProfile) execution.active_profile_doc_id = PROFILE_DOC;
  fs().seed('settings/default', {
    execution,
    trading: { kill_switch: over.killSwitch ?? false },
    safety: over.safety ?? SAFETY,
  });
  if (!over.noProfile) {
    fs().seed(`execution_profiles/${PROFILE_DOC}`, {
      ...((over.profile ?? PROFILE) as Record<string, unknown>),
      status: 'active',
    });
  }
}

let seq = 0;
function signalEvent(over: Partial<SignalEventInput> = {}): SignalEventInput {
  seq += 1;
  return {
    eventId: `${CHAT}_${over.messageId ?? '1'}_hash${seq}`,
    chatId: CHAT,
    messageId: '1',
    messageDate: new Date().toISOString(),
    messageType: 'new',
    kind: 'signal',
    signal: BUY_SIGNAL,
    ...over,
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

function skipReasons(): string[] {
  return fs()
    .docs('trade_events')
    .map((e) => e.data)
    .filter((e) => e.type === 'execution_skipped')
    .map((e) => e.reason_code as string);
}

/** Records every call made to a broker. Delegates when `inner` is given, otherwise throws on use. */
function recordingBroker(kind: 'mt5' | 'simulated', inner?: BrokerAdapter): { broker: BrokerAdapter; calls: string[] } {
  const calls: string[] = [];
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

describe('mt5TradeEngine', () => {
  beforeEach(() => {
    h.fs = createFakeFirestore();
    h.controlOverride = null;
    seq = 0;
    invalidateExecutionControl();
    _resetAlertsForTests();
    delete process.env.BYTRADER_LIVE_TRADING;
  });

  afterEach(() => {
    _resetBrokerRouterForTests();
    delete process.env.BYTRADER_LIVE_TRADING;
  });

  describe('happy path', () => {
    it('opens a market BUY sized by risk, with checkpoints and broker TP at the final checkpoint', async () => {
      const sim = await demoSim();
      seedControl();

      const result = await handleSignalEvent(signalEvent({ eventId: 'evt-buy', messageId: '3001' }));
      expect(result).toMatchObject({ outcome: 'submitted', state: 'OPEN' });

      const id = `${CHAT}_3001`;
      const doc = tradeSet(id);
      expect(doc.state).toBe('OPEN');
      expect(doc.mode).toBe('demo');
      // The simulated broker is injected as the demo broker; the stored kind follows the adapter.
      expect(doc.broker).toBe('simulated');
      expect(doc.plan.volume).toBeCloseTo(0.09, 8);
      expect(doc.plan.risk_money).toBeCloseTo(46.8, 6);
      expect(doc.plan.broker_tp).toBe(2020);
      expect(doc.plan.checkpoints.map((c: { closeVolume: number }) => c.closeVolume)).toEqual([0.04, 0.02, 0.03]);
      expect(doc.lifecycle.checkpoints.map((c: { status: string }) => c.status)).toEqual(['pending', 'pending', 'pending']);
      expect(doc.lifecycle.checkpoints.map((c: { close_volume: number }) => c.close_volume)).toEqual([0.04, 0.02, 0.03]);
      expect(doc.lifecycle.checkpoints.map((c: { target_remaining_volume: number }) => c.target_remaining_volume)).toEqual([
        0.05, 0.03, 0,
      ]);
      expect(doc.broker_refs.position_ticket).toBeGreaterThan(0);
      expect(doc.correlation_comment).toMatch(/^BT-[0-9a-f]{12}$/);

      const positions = await sim.getPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0]).toMatchObject({ type: 'BUY', sl: 1995, tp: 2020 });
      expect(positions[0].volume).toBeCloseTo(0.09, 8);
      expect(positions[0].comment).toBe(doc.correlation_comment);

      expect(eventTypes(id)).toEqual([
        'signal_received',
        'signal_validated',
        'entry_submitted',
        'entry_confirmed',
        'protection_confirmed',
      ]);
    });

    it('opens a market SELL with the mirrored plan', async () => {
      const sim = await demoSim();
      seedControl();

      const signal: GoldSignal = {
        symbol: 'XAUUSD',
        direction: 'sell',
        orderType: 'market',
        entryLow: 1999,
        entryHigh: 2001,
        stopLoss: 2005,
        takeProfits: [1995, 1990, 1980],
      };
      const result = await handleSignalEvent(signalEvent({ messageId: '3002', signal }));
      expect(result).toMatchObject({ outcome: 'submitted', state: 'OPEN' });

      const doc = tradeSet(`${CHAT}_3002`);
      expect(doc.plan.volume).toBeCloseTo(0.1, 8);
      expect(doc.plan.broker_tp).toBe(1980);
      expect(doc.plan.checkpoints.map((c: { closeVolume: number }) => c.closeVolume)).toEqual([0.05, 0.03, 0.02]);

      const positions = await sim.getPositions();
      expect(positions[0]).toMatchObject({ type: 'SELL', sl: 2005, tp: 1980 });
    });

    it('places a pending BUY_LIMIT for a buy_limit signal under follow_signal, with expiry', async () => {
      const sim = await demoSim();
      seedControl();

      const signal: GoldSignal = {
        symbol: 'XAUUSD',
        direction: 'buy',
        orderType: 'buy_limit',
        entryLow: 1995,
        entryHigh: 1998,
        stopLoss: 1993,
        takeProfits: [2005, 2010, 2020],
      };
      const before = Math.floor(Date.now() / 1000);
      const result = await handleSignalEvent(signalEvent({ messageId: '3003', signal }));
      expect(result).toMatchObject({ outcome: 'submitted', state: 'PENDING_ORDER' });

      const doc = tradeSet(`${CHAT}_3003`);
      expect(doc.state).toBe('PENDING_ORDER');
      expect(doc.order_type).toBe('BUY_LIMIT');
      expect(doc.plan.order_price).toBe(1998);
      expect(doc.broker_refs.order_ticket).toBeGreaterThan(0);

      const orders = await sim.getOrders();
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({ type: 'BUY_LIMIT', priceOpen: 1998, sl: 1993 });
      expect(orders[0].timeExpiration).toBeGreaterThanOrEqual(before + 60 * 60 - 2);
      expect(orders[0].timeExpiration).toBeLessThanOrEqual(before + 60 * 60 + 5);
      expect(eventTypes(`${CHAT}_3003`)).toContain('pending_order_placed');
    });

    it('places BUY_LIMIT at entryHigh for an out-of-range market signal under pending_at_range', async () => {
      const sim = await demoSim();
      seedControl({ profile: { ...PROFILE, entry: { ...PROFILE.entry, policy: 'pending_at_range' } } });

      const signal: GoldSignal = {
        symbol: 'XAUUSD',
        direction: 'buy',
        orderType: 'market',
        entryLow: 1990,
        entryHigh: 1995,
        stopLoss: 1985,
        takeProfits: [2000, 2005, 2010],
      };
      const result = await handleSignalEvent(signalEvent({ messageId: '3004', signal }));
      expect(result).toMatchObject({ outcome: 'submitted', state: 'PENDING_ORDER' });

      const orders = await sim.getOrders();
      expect(orders[0]).toMatchObject({ type: 'BUY_LIMIT', priceOpen: 1995 });
      expect(tradeSet(`${CHAT}_3004`).order_type).toBe('BUY_LIMIT');
    });
  });

  describe('gates', () => {
    async function expectSkip(
      messageId: string,
      reason: string,
      setup: () => Promise<void> | void,
      ev: Partial<SignalEventInput> = {},
    ): Promise<void> {
      await setup();
      const result = await handleSignalEvent(signalEvent({ messageId, ...ev }));
      expect(result).toMatchObject({ outcome: 'skipped', state: 'SKIPPED', reason });
      expect(tradeSet(`${CHAT}_${messageId}`).state).toBe('SKIPPED');
      expect(tradeSet(`${CHAT}_${messageId}`).skip_reason).toBe(reason);
      expect(skipReasons()).toContain(reason);
    }

    it('skips when execution is disabled, and still records the trade set', async () => {
      const sim = await demoSim();
      seedControl({ mode: 'disabled' });
      await expectSkip('5001', 'execution_disabled', () => undefined);
      expect(await sim.getPositions()).toHaveLength(0);
    });

    it('skips when the kill switch is engaged', async () => {
      await demoSim();
      seedControl({ killSwitch: true });
      await expectSkip('5002', 'kill_switch', () => undefined);
    });

    it('skips when there is no active profile', async () => {
      await demoSim();
      seedControl({ noProfile: true });
      await expectSkip('5003', 'no_active_profile', () => undefined);
    });

    it('skips when the stored profile is structurally invalid (executionControl refuses it)', async () => {
      await demoSim();
      seedControl({ profile: { ...PROFILE, sizing: { ...PROFILE.sizing, below_min_volume: 'nope' } } });
      await expectSkip('5004', 'invalid_profile', () => undefined);
    });

    it('re-validates the profile at runtime and refuses a profile that violates safety', async () => {
      const sim = await demoSim();
      seedControl();
      h.controlOverride = (control) => ({
        ...control,
        activeProfile: {
          ...(control.activeProfile as Record<string, unknown>),
          sizing: { mode: 'equity_risk_percent', risk_percent: 2, below_min_volume: 'skip' },
        },
      });
      await expectSkip('5005', 'invalid_profile', () => undefined);
      expect(await sim.getPositions()).toHaveLength(0);
    });

    it('re-validates the profile at runtime and refuses a structurally broken profile', async () => {
      await demoSim();
      seedControl();
      h.controlOverride = (control) => {
        const profile = { ...(control.activeProfile as Record<string, unknown>) };
        delete profile.take_profit;
        return { ...control, activeProfile: profile };
      };
      await expectSkip('5006', 'invalid_profile', () => undefined);
    });

    it('skips a symbol that the profile does not map', async () => {
      await demoSim();
      seedControl();
      await expectSkip('5007', 'symbol_not_mapped', () => undefined, {
        signal: { ...BUY_SIGNAL, symbol: 'EURUSD' },
      });
    });

    it('skips a signal older than the profile max age', async () => {
      await demoSim();
      seedControl();
      await expectSkip('5008', 'signal_too_old', () => undefined, {
        messageDate: new Date(Date.now() - 10 * 60_000).toISOString(),
      });
    });

    it('skips a signal with no message date', async () => {
      await demoSim();
      seedControl();
      await expectSkip('5009', 'signal_missing_date', () => undefined, { messageDate: null });
    });

    it('skips demo mode when the account is REAL', async () => {
      await demoSim({}, { tradeMode: 'REAL' });
      seedControl();
      await expectSkip('5010', 'account_not_demo', () => undefined);
    });

    it('refuses live mode without the environment flag', async () => {
      const sim = makeSim();
      await sim.setQuote('XAUUSD', 2000, 2000.2);
      setBrokerForTests('live', sim);
      seedControl({ mode: 'live' });
      await expectSkip('5011', 'live_not_enabled', () => undefined);
    });

    it('refuses live mode on a DEMO account even with the environment flag', async () => {
      const sim = makeSim({}, { tradeMode: 'DEMO' });
      await sim.setQuote('XAUUSD', 2000, 2000.2);
      setBrokerForTests('live', sim);
      process.env.BYTRADER_LIVE_TRADING = 'enabled';
      seedControl({ mode: 'live' });
      await expectSkip('5012', 'account_not_real', () => undefined);
    });

    it('skips quote_stale when the last tick is older than MAX_QUOTE_AGE_SEC (closed market), and sends nothing', async () => {
      const sim = makeSim();
      await sim.setQuote('XAUUSD', 2000, 2000.2, Date.now() - 5 * 60_000);
      setBrokerForTests('demo', sim);
      seedControl();
      const place = vi.spyOn(sim, 'placeOrder');
      await expectSkip('5020', 'quote_stale', () => undefined);
      expect(place).not.toHaveBeenCalled();
    });

    it('a fresh tick passes the quote age gate', async () => {
      const sim = makeSim();
      await sim.setQuote('XAUUSD', 2000, 2000.2, Date.now() - 2_000);
      setBrokerForTests('demo', sim);
      seedControl();
      const result = await handleSignalEvent(signalEvent({ messageId: '5021' }));
      expect(result).toMatchObject({ outcome: 'submitted', state: 'OPEN' });
    });

    it('skips when the spread is too wide', async () => {
      const sim = makeSim();
      await sim.setQuote('XAUUSD', 2000, 2000.6);
      setBrokerForTests('demo', sim);
      seedControl();
      await expectSkip('5013', 'spread_too_wide', () => undefined);
    });

    it('skips a stop loss on the wrong side of the entry', async () => {
      await demoSim();
      seedControl();
      await expectSkip('5014', 'sl_wrong_side', () => undefined, {
        signal: { ...BUY_SIGNAL, stopLoss: 2003 },
      });
    });

    it('skips a stop loss beyond the profile max distance', async () => {
      await demoSim();
      seedControl();
      await expectSkip('5015', 'sl_too_far', () => undefined, { signal: { ...BUY_SIGNAL, stopLoss: 1960 } });
    });

    it('skips a stop loss inside the profile min distance', async () => {
      await demoSim();
      seedControl();
      await expectSkip('5016', 'sl_too_close', () => undefined, { signal: { ...BUY_SIGNAL, stopLoss: 1999.5 } });
    });

    it('skips a market signal outside its range under follow_signal', async () => {
      await demoSim();
      seedControl();
      await expectSkip('5017', 'price_outside_entry_range', () => undefined, {
        signal: { ...BUY_SIGNAL, entryLow: 1990, entryHigh: 1995 },
      });
    });

    it('skips when the signal has no TP for a referenced checkpoint', async () => {
      await demoSim();
      seedControl();
      await expectSkip('5018', 'tp_missing', () => undefined, { signal: { ...BUY_SIGNAL, takeProfits: [2005] } });
    });

    it('skips when a checkpoint split is infeasible under skip_trade', async () => {
      await demoSim();
      seedControl({
        profile: {
          ...PROFILE,
          sizing: { mode: 'fixed_risk_money', risk_money: 15, below_min_volume: 'skip' },
          take_profit: { ...PROFILE.take_profit, infeasible_split: 'skip_trade' },
        },
      });
      await expectSkip('5019', 'tp_split_infeasible', () => undefined);
    });

    it('skips fixed lots above the symbol maximum (never clamps them)', async () => {
      await demoSim({ volumeMax: 0.5 });
      seedControl({
        profile: { ...PROFILE, sizing: { mode: 'fixed_lots', fixed_lots: 1, below_min_volume: 'skip' } },
      });
      await expectSkip('5020', 'volume_exceeds_max', () => undefined);
    });

    it('skips when the account is at the concurrent position limit', async () => {
      await demoSim();
      seedControl({
        profile: { ...PROFILE, limits: { ...PROFILE.limits, max_concurrent_positions: 1 } },
      });
      expect((await handleSignalEvent(signalEvent({ messageId: '6001' }))).state).toBe('OPEN');
      await expectSkip('6002', 'max_concurrent_positions', () => undefined);
    });

    it('skips when the symbol is at the per-symbol position limit', async () => {
      await demoSim();
      seedControl();
      expect((await handleSignalEvent(signalEvent({ messageId: '6101' }))).state).toBe('OPEN');
      await expectSkip('6102', 'max_positions_per_symbol', () => undefined);
    });

    it('skips when realized losses today reach the daily limit', async () => {
      const sim = await demoSim();
      seedControl({
        profile: { ...PROFILE, limits: { ...PROFILE.limits, daily_loss_limit_money: 50 } },
      });
      // Realize about -90 USD through the simulated broker.
      await sim.placeOrder({
        symbol: 'XAUUSD',
        orderType: 'BUY',
        volume: 0.09,
        price: 0,
        sl: 0,
        tp: 0,
        deviationPoints: 20,
        comment: 'manual-loss',
      });
      await sim.setQuote('XAUUSD', 1990, 1990.2);
      const [pos] = await sim.getPositions();
      await sim.closePosition(pos.ticket);
      await sim.setQuote('XAUUSD', 2000, 2000.2);

      await expectSkip('6201', 'daily_loss_limit', () => undefined);
    });

    it('skips when open risk plus the new trade exceeds the total risk limit', async () => {
      await demoSim();
      seedControl({
        profile: { ...PROFILE, limits: { ...PROFILE.limits, max_total_risk_percent: 0.4 } },
      });
      // Cap is 40 USD (0.4% of 10000); the trade risks about 46.8 USD.
      await expectSkip('6301', 'total_risk_limit', () => undefined);
    });

    it('skips when the broker margin check fails', async () => {
      const sim = makeSim();
      await sim.setQuote('XAUUSD', 2000, 2000.2);
      const refusing = {
        ...sim,
        checkOrder: async () => ({ ok: false, retcode: 10019, margin: 0, marginFree: 0, comment: 'no money' }),
      } as unknown as BrokerAdapter;
      setBrokerForTests('demo', refusing);
      seedControl();
      await expectSkip('6401', 'margin_check_failed', () => undefined);
    });

    it('skips when the post-trade margin level is below the safety floor', async () => {
      await demoSim();
      seedControl({ safety: { ...SAFETY, min_margin_level_percent: 10000 } });
      await expectSkip('6501', 'margin_level_too_low', () => undefined);
    });
  });

  describe('persistence and send failures', () => {
    it('refuses to send when the SUBMITTING intent cannot be persisted', async () => {
      const sim = await demoSim();
      seedControl();
      fs().failNext('transaction');

      const result = await handleSignalEvent(signalEvent({ eventId: 'evt-persist', messageId: '7001' }));
      expect(result).toEqual({ outcome: 'skipped', state: 'ERROR', reason: 'persist_intent_failed' });
      expect(tradeSet(`${CHAT}_7001`).state).toBe('ERROR');
      expect(await sim.getPositions()).toHaveLength(0);
    });

    it('returns retry when persisting the intent and writing ERROR both fail', async () => {
      const sim = await demoSim();
      seedControl();
      fs().failNext('transaction');
      fs().failNext('transaction');

      const result = await handleSignalEvent(signalEvent({ messageId: '7002' }));
      expect(result).toEqual({ outcome: 'retry', reason: 'persist_intent_failed' });
      expect(tradeSet(`${CHAT}_7002`).state).toBe('CLAIMED');
      expect(await sim.getPositions()).toHaveLength(0);
    });

    it('returns retry and sends nothing when Firestore is unavailable, then succeeds once it is back', async () => {
      const sim = await demoSim();
      seedControl();
      const saved = h.fs;
      h.fs = null;

      const first = await handleSignalEvent(signalEvent({ eventId: 'evt-down', messageId: '7101' }));
      expect(first).toEqual({ outcome: 'retry', reason: 'claim_failed' });
      expect(await sim.getPositions()).toHaveLength(0);

      // The execution control cache holds the fail-closed read for 5 s; the feed's backoff covers that in production.
      h.fs = saved;
      invalidateExecutionControl();
      const second = await handleSignalEvent(signalEvent({ eventId: 'evt-down', messageId: '7101' }));
      expect(second).toMatchObject({ outcome: 'submitted', state: 'OPEN' });
      expect(await sim.getPositions()).toHaveLength(1);
    });

    it('marks REJECTED on a definite broker refusal', async () => {
      const sim = await demoSim();
      seedControl();
      sim.failNext('placeOrder', 'reject', 10006);

      const result = await handleSignalEvent(signalEvent({ messageId: '7201' }));
      expect(result).toMatchObject({ outcome: 'submitted', state: 'REJECTED', reason: 'broker_rejected' });
      const doc = tradeSet(`${CHAT}_7201`);
      expect(doc.state).toBe('REJECTED');
      expect(eventTypes(`${CHAT}_7201`)).toContain('entry_rejected');
      expect(await sim.getPositions()).toHaveLength(0);
    });

    it('marks REJECTED with bridge_unavailable when the bridge is down before sending', async () => {
      const sim = await demoSim();
      seedControl();
      sim.failNext('placeOrder', 'unavailable');

      const result = await handleSignalEvent(signalEvent({ messageId: '7301' }));
      expect(result).toMatchObject({ state: 'REJECTED', reason: 'bridge_unavailable' });
      expect(await sim.getPositions()).toHaveLength(0);
    });

    it('marks SUBMIT_UNKNOWN on an ambiguous send, never resends, and keeps one position', async () => {
      const sim = await demoSim();
      seedControl();
      sim.failNext('placeOrder', 'ambiguous');

      const first = await handleSignalEvent(signalEvent({ eventId: 'evt-amb', messageId: '7401' }));
      expect(first).toMatchObject({ outcome: 'submitted', state: 'SUBMIT_UNKNOWN', reason: 'entry_unknown' });
      // The simulated broker executed the order before losing the reply.
      expect(await sim.getPositions()).toHaveLength(1);

      const doc = tradeSet(`${CHAT}_7401`);
      expect(doc.state).toBe('SUBMIT_UNKNOWN');
      expect(typeof doc.submission.expires_at).toBe('number');
      expect(eventTypes(`${CHAT}_7401`)).toContain('entry_unknown');

      const second = await handleSignalEvent(signalEvent({ eventId: 'evt-amb', messageId: '7401' }));
      expect(second).toMatchObject({ outcome: 'noop', state: 'SUBMIT_UNKNOWN', reason: 'already_processed' });
      expect(await sim.getPositions()).toHaveLength(1);
      expect(fs().peek(`alerts/submit_unknown__${CHAT}_7401`)).toMatchObject({
        type: 'submit_unknown',
        severity: 'error',
        status: 'open',
      });
    });

    it('raises protection_missing when the filled position cannot be confirmed to carry its stop', async () => {
      const sim = await demoSim();
      seedControl();
      const realGet = sim.getPositions.bind(sim);
      let calls = 0;
      vi.spyOn(sim, 'getPositions').mockImplementation(async (symbol?: string) => {
        calls += 1;
        // The gate read succeeds; the post-fill verification read fails.
        if (calls === 2) throw new Error('bridge read timed out');
        return realGet(symbol);
      });

      const result = await handleSignalEvent(signalEvent({ eventId: 'evt-prot', messageId: '7402' }));
      expect(result).toMatchObject({ outcome: 'submitted', state: 'OPEN' });
      expect(fs().peek(`alerts/protection_missing__${CHAT}_7402`)).toMatchObject({
        type: 'protection_missing',
        severity: 'error',
        status: 'open',
      });
    });
  });

  describe('idempotency', () => {
    it('does not send twice when the same event is dispatched twice', async () => {
      const sim = await demoSim();
      seedControl();
      const ev = signalEvent({ eventId: 'evt-dup', messageId: '8001' });

      expect((await handleSignalEvent(ev)).state).toBe('OPEN');
      expect(await handleSignalEvent(ev)).toMatchObject({ outcome: 'noop', state: 'OPEN', reason: 'already_processed' });
      expect(await sim.getPositions()).toHaveLength(1);
    });

    it('does not send again after a restart re-delivers the same message', async () => {
      const sim = await demoSim();
      seedControl();
      const ev = signalEvent({ eventId: 'evt-restart', messageId: '8101' });
      expect((await handleSignalEvent(ev)).state).toBe('OPEN');

      // A fresh module instance (process restart) against the same Firestore.
      vi.resetModules();
      const router = await import('./brokerRouter.js');
      router._resetBrokerRouterForTests();
      router.setBrokerForTests('demo', sim);
      const fresh = await import('./mt5TradeEngine.js');
      const result = await fresh.handleSignalEvent(ev);
      expect(result).toMatchObject({ outcome: 'noop', state: 'OPEN' });
      expect(await sim.getPositions()).toHaveLength(1);
    });
  });

  describe('paper mode', () => {
    it('uses the simulated paper broker and never touches the MT5 brokers', async () => {
      const paper = makeSim();
      await paper.setQuote('XAUUSD', 2000, 2000.2);
      setBrokerForTests('paper', paper);
      const demo = recordingBroker('mt5');
      const live = recordingBroker('mt5');
      setBrokerForTests('demo', demo.broker);
      setBrokerForTests('live', live.broker);
      seedControl({ mode: 'paper' });

      const result = await handleSignalEvent(signalEvent({ messageId: '9001' }));
      expect(result).toMatchObject({ outcome: 'submitted', state: 'OPEN' });
      expect(await paper.getPositions()).toHaveLength(1);
      expect(tradeSet(`${CHAT}_9001`).broker).toBe('simulated');
      expect(demo.calls).toEqual([]);
      expect(live.calls).toEqual([]);
    });
  });

  describe('re-check before send', () => {
    /** Wraps a sim broker; `hook` runs right after checkOrder, the last gate call before the send. */
    function hookAfterCheck(sim: SimulatedBroker, hook: () => void): { broker: BrokerAdapter; sends: () => number } {
      let sends = 0;
      const broker = {
        ...sim,
        checkOrder: async (req: PlaceOrderRequest) => {
          const res = await sim.checkOrder(req);
          hook();
          return res;
        },
        placeOrder: (req: PlaceOrderRequest) => {
          sends += 1;
          return sim.placeOrder(req);
        },
      };
      return { broker: broker as unknown as BrokerAdapter, sends: () => sends };
    }

    it('a kill switch engaged between the gates and the send places no order', async () => {
      const sim = await demoSim();
      seedControl();
      const { broker, sends } = hookAfterCheck(sim, () => seedControl({ killSwitch: true }));
      setBrokerForTests('demo', broker);

      const result = await handleSignalEvent(signalEvent({ eventId: 'evt-kill-race', messageId: '7501' }));

      expect(result).toMatchObject({ outcome: 'skipped', state: 'SKIPPED', reason: 'kill_switch' });
      expect(sends()).toBe(0);
      expect(await sim.getPositions()).toHaveLength(0);
      expect(tradeSet(`${CHAT}_7501`)).toMatchObject({ state: 'SKIPPED', skip_reason: 'kill_switch' });
      expect(skipReasons()).toContain('kill_switch');
    });

    it('an active profile changed between the gates and the send places no order', async () => {
      const sim = await demoSim();
      seedControl();
      const { broker, sends } = hookAfterCheck(sim, () => {
        fs().seed('execution_profiles/xau-next__v1', { ...PROFILE, profile_id: 'xau-next', status: 'active' });
        fs().seed('settings/default', {
          execution: { mode: 'demo', active_profile_doc_id: 'xau-next__v1' },
          trading: { kill_switch: false },
          safety: SAFETY,
        });
      });
      setBrokerForTests('demo', broker);

      const result = await handleSignalEvent(signalEvent({ eventId: 'evt-profile-race', messageId: '7502' }));

      expect(result).toMatchObject({ outcome: 'skipped', state: 'SKIPPED', reason: 'profile_changed' });
      expect(sends()).toBe(0);
      expect(await sim.getPositions()).toHaveLength(0);
      expect(tradeSet(`${CHAT}_7502`).skip_reason).toBe('profile_changed');
    });
  });

  describe('partial market fill', () => {
    /** Broker whose market entries fill `filledVolume` of the requested size. */
    function partialFillBroker(sim: SimulatedBroker, filledVolume: number): BrokerAdapter {
      const broker = { ...sim, placeOrder: (req: PlaceOrderRequest) => sim.placeOrder({ ...req, volume: filledVolume }) };
      return broker as unknown as BrokerAdapter;
    }

    function eventsFor(id: string): Record<string, unknown>[] {
      return fs()
        .docs('trade_events')
        .map((e) => e.data)
        .filter((e) => e.trade_set_id === id);
    }

    const round2 = (values: number[]): number[] => values.map((v) => Math.round(v * 100) / 100);

    it('re-plans the checkpoints for the filled volume and keeps the planned volume on the plan', async () => {
      const sim = await demoSim();
      seedControl();
      setBrokerForTests('demo', partialFillBroker(sim, 0.04));

      const result = await handleSignalEvent(signalEvent({ eventId: 'evt-partial', messageId: '7601' }));

      expect(result).toMatchObject({ outcome: 'submitted', state: 'OPEN' });
      const id = `${CHAT}_7601`;
      const doc = tradeSet(id);
      expect(doc.plan.volume).toBeCloseTo(0.09, 8);
      expect(doc.broker_refs.filled_volume).toBeCloseTo(0.04, 8);
      expect(doc.lifecycle.current_volume).toBeCloseTo(0.04, 8);
      expect(round2(doc.lifecycle.checkpoints.map((c: { close_volume: number }) => c.close_volume))).toEqual([0.02, 0.01, 0.01]);
      expect(round2(doc.lifecycle.checkpoints.map((c: { target_remaining_volume: number }) => c.target_remaining_volume))).toEqual([
        0.02, 0.01, 0,
      ]);
      expect(doc.lifecycle.checkpoints.map((c: { status: string }) => c.status)).toEqual(['pending', 'pending', 'pending']);
      expect(eventsFor(id).map((e) => e.event_key)).toContain('partial_fill_replanned');
      expect((await sim.getPositions())[0].volume).toBeCloseTo(0.04, 8);
    });

    it('keeps the planned checkpoints and records infeasibility when the filled size cannot be split', async () => {
      const sim = await demoSim();
      const strictSplit = { ...PROFILE, take_profit: { ...PROFILE.take_profit, infeasible_split: 'skip_trade' } };
      seedControl({ profile: strictSplit });
      setBrokerForTests('demo', partialFillBroker(sim, 0.01));

      const result = await handleSignalEvent(signalEvent({ eventId: 'evt-infeasible', messageId: '7602' }));

      expect(result).toMatchObject({ outcome: 'submitted', state: 'OPEN' });
      const id = `${CHAT}_7602`;
      const doc = tradeSet(id);
      expect(doc.broker_refs.filled_volume).toBeCloseTo(0.01, 8);
      expect(round2(doc.lifecycle.checkpoints.map((c: { close_volume: number }) => c.close_volume))).toEqual([0.04, 0.02, 0.03]);
      const infeasible = eventsFor(id).find((e) => e.event_key === 'partial_fill_replan_infeasible');
      expect(infeasible).toMatchObject({ type: 'execution_error', reason_code: 'partial_fill_replan_infeasible' });
    });
  });
});
