/**
 * Broker assumptions that can be simulated (docs/project_memory/VANTAGE_BROKER_ASSUMPTIONS.md).
 *
 * Each test models what happens when a Vantage behaviour differs from what the
 * code relies on, and checks that the system fails safe: no duplicate order, no
 * wrong conclusion about an order's fate, and an operator alert. None of this
 * verifies Vantage itself; it verifies the reaction to each possible answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fs: null as unknown, skew: null as number | null }));

vi.mock('./firestoreAdmin', () => ({ initFirestore: () => h.fs }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./mt5Client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mt5Client.js')>();
  return { ...actual, getCachedGmtSkewSec: () => h.skew };
});

import { _resetAlertsForTests } from './alerts.js';
import { _resetBrokerRouterForTests, setBrokerForTests } from './brokerRouter.js';
import type { AccountInfo, BrokerAdapter, SymbolInfo } from './brokerTypes.js';
import { invalidateExecutionControl } from './executionControl.js';
import { _resetLifecycleManagerForTests, runLifecycleTick } from './lifecycleManager.js';
import { handleSignalEvent, type SignalEventInput } from './mt5TradeEngine.js';
import { _resetReconcilerForTests, runReconciliation } from './reconciler.js';
import { createSimulatedBroker, type SimulatedBroker, type SimulatedBrokerOptions } from './simulatedBroker.js';
import { createFakeFirestore, type FakeFirestore } from './testing/fakeFirestore.js';
import { correlationComment, type TradeSetDoc } from './tradeSetTypes.js';
import type { GoldSignal } from './vipSignalParser.js';

const MAGIC = 98801;
const CHAT = '-1003271337051';
const PROFILE_DOC = 'xau-assumptions__v1';
const T0 = Date.parse('2026-10-19T10:00:00.000Z');

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
  max_positions_per_symbol: 2,
  daily_loss_limit_money: 100,
  max_total_risk_percent: 3,
  max_spread_price: 0.5,
  max_deviation_points: 30,
  max_signal_age_sec: 120,
  min_margin_level_percent: 200,
  allowed_signal_symbols: ['XAUUSD'],
};

function profile(entryPolicy: 'follow_signal' | 'pending_at_range' = 'follow_signal') {
  return {
    schema_version: 1,
    profile_id: 'xau-assumptions',
    version: 1,
    name: 'assumptions',
    source: { type: 'manual' },
    broker: 'vantage_mt5',
    symbols: [{ signal_symbol: 'XAUUSD', broker_symbol: 'XAUUSD' }],
    entry: { policy: entryPolicy, market_tolerance_price: 0.5, pending_expiry_minutes: 30, allow_market_fallback: false },
    sizing: { mode: 'fixed_lots', fixed_lots: 0.05, below_min_volume: 'skip' },
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
      max_positions_per_symbol: 2,
      max_spread_price: 0.5,
      max_deviation_points: 30,
      signal_max_age_sec: 120,
      daily_loss_limit_money: 100,
      max_total_risk_percent: 3,
    },
    edits: { before_fill: 'apply_sl_tp', after_fill: 'apply_tighten_only', unparseable_edit: 'cancel_pending_only', explicit_cancel: 'cancel_pending_only' },
    status: 'active',
  };
}

const BUY: GoldSignal = {
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

function seedControl(entryPolicy?: 'follow_signal' | 'pending_at_range'): void {
  fs().seed('settings/default', {
    execution: { mode: 'demo', active_profile_doc_id: PROFILE_DOC },
    trading: { kill_switch: false },
    safety: SAFETY,
  });
  fs().seed(`execution_profiles/${PROFILE_DOC}`, profile(entryPolicy));
}

let seq = 0;
function event(messageId: string, signal: GoldSignal = BUY): SignalEventInput {
  seq += 1;
  return {
    eventId: `${CHAT}_${messageId}_h${seq}`,
    chatId: CHAT,
    messageId,
    messageDate: new Date().toISOString(),
    messageType: 'new',
    kind: 'signal',
    signal,
  };
}

function trade(messageId: string): TradeSetDoc {
  return fs().peek(`trade_sets/${CHAT}_${messageId}`) as unknown as TradeSetDoc;
}

function eventKeys(messageId: string): string[] {
  return fs()
    .docs('trade_events')
    .filter((d) => d.data.trade_set_id === `${CHAT}_${messageId}`)
    .map((d) => String(d.data.event_key));
}

/** A simulated broker that presents itself as the MT5 adapter (so MT5-only gates apply). */
function mt5Like(opts: Partial<SimulatedBrokerOptions> = {}, account: Partial<AccountInfo> = {}): { sim: SimulatedBroker; broker: BrokerAdapter; calls: string[] } {
  const sim = createSimulatedBroker({
    magic: MAGIC,
    account: { tradeMode: 'DEMO', balance: 10000, ...account },
    symbols: { XAUUSD: { ...SPEC, ...(opts.symbols?.XAUUSD ?? {}) } },
    ...opts,
  });
  const calls: string[] = [];
  const broker = new Proxy(sim, {
    get(target, prop) {
      if (prop === 'kind') return 'mt5';
      const v = Reflect.get(target, prop, target);
      if (typeof v !== 'function' || typeof prop !== 'string') return v;
      return (...args: unknown[]) => {
        calls.push(prop);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as BrokerAdapter;
  return { sim, broker, calls };
}

describe('broker assumptions (simulated)', () => {
  beforeEach(() => {
    h.fs = createFakeFirestore();
    h.skew = null;
    seq = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    invalidateExecutionControl();
    _resetAlertsForTests();
    _resetBrokerRouterForTests();
    _resetReconcilerForTests();
    _resetLifecycleManagerForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetBrokerRouterForTests();
  });

  describe('A1 correlation comment preservation', () => {
    it('the comment fits the 31-character MT5 limit and is deterministic per trade set', () => {
      const c = correlationComment(`${CHAT}_123`);
      expect(c).toMatch(/^BT-[0-9a-f]{12}$/);
      expect(c.length).toBeLessThanOrEqual(31);
      expect(correlationComment(`${CHAT}_123`)).toBe(c);
      expect(correlationComment(`${CHAT}_124`)).not.toBe(c);
    });

    it('a broker that rewrites comments is detected on the first fill (critical alert, trade event)', async () => {
      const { sim, broker } = mt5Like({ rewriteComment: (c) => `${c.slice(0, 6)}#` });
      await sim.setQuote('XAUUSD', 2000, 2000.2);
      setBrokerForTests('demo', broker);
      seedControl();

      const r = await handleSignalEvent(event('9001'));
      expect(r).toMatchObject({ outcome: 'submitted', state: 'OPEN' });
      expect(eventKeys('9001')).toContain('comment_not_preserved');
      expect(fs().peek(`alerts/correlation_mismatch__${CHAT}_9001`)).toMatchObject({ severity: 'critical', status: 'open' });
    });

    it('with a rewritten comment an ambiguous entry is NOT concluded "never executed": it stays SUBMIT_UNKNOWN for the operator', async () => {
      const { sim, broker, calls } = mt5Like({ rewriteComment: () => '' });
      await sim.setQuote('XAUUSD', 2000, 2000.2);
      setBrokerForTests('demo', broker);
      seedControl();
      sim.failNext('placeOrder', 'ambiguous');

      expect(await handleSignalEvent(event('9002'))).toMatchObject({ state: 'SUBMIT_UNKNOWN' });
      expect(await sim.getPositions()).toHaveLength(1);

      vi.setSystemTime(T0 + 30_000);
      calls.length = 0;
      await runReconciliation();
      expect(trade('9002').state).toBe('SUBMIT_UNKNOWN');
      expect(eventKeys('9002')).toContain('correlation_candidates');
      expect(fs().peek(`alerts/correlation_mismatch__${CHAT}_9002`)).toMatchObject({ severity: 'critical' });
      // Read-only: nothing was sent, cancelled or closed while deciding.
      expect(calls.filter((c) => ['placeOrder', 'closePosition', 'cancelOrder', 'modifyPosition', 'modifyPendingOrder'].includes(c))).toEqual([]);
      expect(await sim.getPositions()).toHaveLength(1);
    });

    it('with the comment preserved the same ambiguity resolves to OPEN by comment', async () => {
      const { sim, broker } = mt5Like();
      await sim.setQuote('XAUUSD', 2000, 2000.2);
      setBrokerForTests('demo', broker);
      seedControl();
      sim.failNext('placeOrder', 'ambiguous');
      await handleSignalEvent(event('9003'));
      vi.setSystemTime(T0 + 30_000);
      await runReconciliation();
      expect(trade('9003').state).toBe('OPEN');
    });

    it('an expired request with no trace at all is still concluded REJECTED (unchanged behaviour)', async () => {
      const { sim, broker } = mt5Like();
      await sim.setQuote('XAUUSD', 2000, 2000.2);
      setBrokerForTests('demo', broker);
      seedControl();
      sim.failNext('placeOrder', 'unavailable');
      // 'unavailable' on placeOrder is "not sent": REJECTED immediately with bridge_unavailable.
      expect(await handleSignalEvent(event('9004'))).toMatchObject({ state: 'REJECTED' });
    });
  });

  describe('A2 netting versus hedging', () => {
    it('refuses entries on a netting account (a second entry would merge positions)', async () => {
      const { sim, broker, calls } = mt5Like({}, { marginMode: 'NETTING' });
      await sim.setQuote('XAUUSD', 2000, 2000.2);
      setBrokerForTests('demo', broker);
      seedControl();
      expect(await handleSignalEvent(event('9010'))).toMatchObject({ outcome: 'skipped', reason: 'account_netting' });
      expect(calls).not.toContain('placeOrder');
    });
  });

  describe('A3 pending-order expiration', () => {
    const PENDING: GoldSignal = { ...BUY, orderType: 'buy_limit', entryLow: 1990, entryHigh: 1992, stopLoss: 1985 };

    it('a broker that ignores ORDER_TIME_SPECIFIED: recorded, then the worker cancels the order after its expiry', async () => {
      const { sim, broker } = mt5Like({ supportsExpiration: false });
      await sim.setQuote('XAUUSD', 2000, 2000.2);
      setBrokerForTests('demo', broker);
      seedControl();

      expect(await handleSignalEvent(event('9020', PENDING))).toMatchObject({ state: 'PENDING_ORDER' });
      const t = trade('9020');
      expect(t.broker_refs?.expiration_applied).toBe(false);
      expect(t.submission?.pending_expires_at).toBe(Math.floor(T0 / 1000) + 30 * 60);
      expect(eventKeys('9020')).toContain('pending_expiry_not_applied');

      // Still within expiry (+30 s grace): left alone.
      vi.setSystemTime(T0 + 30 * 60_000 + 20_000);
      await runLifecycleTick();
      expect(await sim.getOrders()).toHaveLength(1);

      vi.setSystemTime(T0 + 30 * 60_000 + 31_000);
      await runLifecycleTick();
      expect(await sim.getOrders()).toHaveLength(0);
      expect(eventKeys('9020')).toContain('pending_order_expired_by_worker');
      await runLifecycleTick();
      expect(trade('9020').state).toBe('CANCELLED');
    });

    it('a broker that honours the expiry removes the order itself; the worker only records it', async () => {
      const { sim, broker, calls } = mt5Like({ supportsExpiration: true });
      await sim.setQuote('XAUUSD', 2000, 2000.2);
      setBrokerForTests('demo', broker);
      seedControl();
      await handleSignalEvent(event('9021', PENDING));
      expect(trade('9021').broker_refs?.expiration_applied).toBe(true);
      vi.setSystemTime(T0 + 31 * 60_000);
      await sim.evaluate();
      calls.length = 0;
      await runLifecycleTick();
      expect(calls).not.toContain('cancelOrder');
      expect(trade('9021').state).toBe('CANCELLED');
    });
  });

  describe('A5 clock skew', () => {
    it('refuses new entries when the EA clock differs by more than MAX_CLOCK_SKEW_SEC', async () => {
      const { sim, broker, calls } = mt5Like();
      await sim.setQuote('XAUUSD', 2000, 2000.2);
      setBrokerForTests('demo', broker);
      seedControl();
      h.skew = -12;
      expect(await handleSignalEvent(event('9030'))).toMatchObject({ outcome: 'skipped', reason: 'clock_skew' });
      expect(calls).not.toContain('placeOrder');
      h.skew = 2;
      expect(await handleSignalEvent(event('9031'))).toMatchObject({ outcome: 'submitted' });
    });

    it('waits for the EA clock before concluding an ambiguous entry, when that clock runs behind', async () => {
      const { sim, broker } = mt5Like();
      await sim.setQuote('XAUUSD', 2000, 2000.2);
      setBrokerForTests('demo', broker);
      seedControl();
      h.skew = -4; // within the entry limit, but the EA accepts the request 4 s longer
      sim.failNext('placeOrder', 'ambiguous');
      await handleSignalEvent(event('9033'));
      const t = trade('9033');
      expect(t.state).toBe('SUBMIT_UNKNOWN');
      const exp = t.submission?.expires_at ?? 0;
      // expires + 5 s grace would be enough without skew; with the EA 4 s behind it must wait 4 s more.
      vi.setSystemTime((exp + 5 + 2) * 1000);
      await runReconciliation();
      expect(trade('9033').state).toBe('SUBMIT_UNKNOWN');
      vi.setSystemTime((exp + 5 + 5) * 1000);
      await runReconciliation();
      expect(trade('9033').state).toBe('OPEN');
    });
  });

  describe('A6 volume limits and partial-close constraints', () => {
    it('refuses an entry that would exceed SYMBOL_VOLUME_LIMIT', async () => {
      const { sim, broker, calls } = mt5Like({ symbols: { XAUUSD: { ...SPEC, volumeLimit: 0.08 } } });
      await sim.setQuote('XAUUSD', 2000, 2000.2);
      setBrokerForTests('demo', broker);
      seedControl();
      expect(await handleSignalEvent(event('9040'))).toMatchObject({ outcome: 'submitted' });
      expect(await handleSignalEvent(event('9041'))).toMatchObject({ outcome: 'skipped', reason: 'symbol_volume_limit' });
      expect(calls.filter((c) => c === 'placeOrder')).toHaveLength(1);
    });
  });
});
