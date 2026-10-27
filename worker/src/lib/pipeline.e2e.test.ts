/**
 * pipeline.e2e.test.ts
 *
 * Offline end-to-end tests for the whole signal chain, in one process against
 * one in-memory Firestore:
 *
 *   Telegram message -> forwarder (telegramListener) -> forward to destination
 *   -> signal_events -> AutoTrader tickSignalFeed -> engine gates -> simulated
 *   broker -> reconciler -> lifecycle (checkpoints, stops) -> CLOSED
 *
 * Nothing touches Telegram, Firestore, ZeroMQ or a real broker. The Firestore is
 * the fake in testing/fakeFirestore.ts, the broker is createSimulatedBroker, and
 * the Telegram client is a recording fake. Modes that must never reach a broker
 * get a tripwire broker that fails the test on any call.
 *
 * Each test resets the module graph and builds a new world, so state never leaks
 * between scenarios. Production modules are loaded dynamically after the mocks
 * are registered, so their module-level caches start empty.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeFirestore } from './testing/fakeFirestore.js';
import { createFakeFirestore } from './testing/fakeFirestore.js';
import {
  DEST,
  FOREIGN_MAGIC,
  MAGIC,
  PROFILE_DOC_ID,
  SETTINGS_PATH,
  SOURCE,
  T0_MS,
  channelMessage,
  eventDocs,
  eventTypes,
  firestoreView,
  forwardedText,
  fakeTelegram,
  memoryStore,
  simOptions,
  profileDoc,
  recordingBroker,
  settingsDoc,
  tripwireBroker,
  type FakeTelegram,
} from './testing/e2eHarness.js';
import type { BrokerAdapter } from './brokerTypes.js';
import type { SimulatedBroker } from './simulatedBroker.js';
import type { MemoryStore } from './testing/e2eHarness.js';
import type { TradeSetDoc } from './tradeSetTypes.js';
import { correlationComment, tradeSetIdFor } from './tradeSetTypes.js';

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

interface World {
  fake: FakeFirestore;
  firestore: FirebaseFirestore.Firestore;
  /** When false, production code sees initFirestore() === null (unavailable). */
  firestoreUp: boolean;
  tg: FakeTelegram;
  demo: SimulatedBroker;
  paper: SimulatedBroker;
}

let world: World;

function createWorld(mods: Mods): World {
  const fake = createFakeFirestore();
  return {
    fake,
    firestore: firestoreView(fake),
    firestoreUp: true,
    tg: fakeTelegram(),
    demo: mods.sim.createSimulatedBroker(simOptions(MAGIC)),
    paper: mods.sim.createSimulatedBroker(simOptions(MAGIC)),
  };
}

/** Simulated broker from the same module graph as the engine (see simOptions). */
function simFor(magic: number, store?: MemoryStore): SimulatedBroker {
  return mods.sim.createSimulatedBroker(simOptions(magic, store));
}

function registerMocks(): void {
  vi.doMock('./firestoreAdmin', () => ({
    initFirestore: () => (world.firestoreUp ? world.firestore : null),
    getFirestore: () => (world.firestoreUp ? world.firestore : null),
  }));
  vi.doMock('./telegramClient', () => ({
    getTelegramStatus: async () => ({ status: 'authorized', phone: null, lastError: null, reauthRequired: false }),
    getTelegramClient: async () => world.tg.client,
  }));
  vi.doMock('./logger', () => ({
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  }));
  // Any attempt to build the real MT5 broker (ZeroMQ) must fail loudly.
  vi.doMock('./mt5Broker', () => ({
    createMt5Broker: () => {
      throw new Error('e2e: the real MT5 broker must not be created');
    },
  }));
}

async function loadModules() {
  const listener = await import('./telegramListener.js');
  const feed = await import('./signalFeed.js');
  const router = await import('./brokerRouter.js');
  const control = await import('./executionControl.js');
  const secrets = await import('./mt5Secrets.js');
  const lifecycle = await import('./lifecycleManager.js');
  const reconciler = await import('./reconciler.js');
  const admin = await import('./adminCommands.js');
  const sim = await import('./simulatedBroker.js');
  return { listener, feed, router, control, secrets, lifecycle, reconciler, admin, sim };
}

type Mods = Awaited<ReturnType<typeof loadModules>>;
let mods: Mods;

/** Feed cursor starts a minute before the test clock, so every event in the test is read. */
function resetFeed(m: Mods): void {
  m.feed._resetSignalFeedForTests(new Date(T0_MS - 60_000).toISOString());
}

function installBrokers(m: Mods, demo: BrokerAdapter, paper: BrokerAdapter, live: BrokerAdapter): void {
  m.router.setBrokerForTests('demo', demo);
  m.router.setBrokerForTests('paper', paper);
  m.router.setBrokerForTests('live', live);
}

/** Shared tripwire for live: any call fails the test. */
let liveTrip: ReturnType<typeof tripwireBroker>;

beforeEach(async () => {
  vi.resetModules();
  registerMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0_MS);
  mods = await loadModules();
  world = createWorld(mods);
  world.fake.seed(SETTINGS_PATH, settingsDoc());
  world.fake.seed(`execution_profiles/${PROFILE_DOC_ID}`, profileDoc());
  resetFeed(mods);
  liveTrip = tripwireBroker('live', MAGIC);
  installBrokers(mods, world.demo, world.paper, liveTrip.broker);
  await mods.listener.startTelegramListener();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Pipeline drivers
// ---------------------------------------------------------------------------

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Feeds a message to the forwarder listener (the latest registered one). */
async function deliver(text: string, id: number, opts: { edit?: boolean } = {}): Promise<void> {
  const name = opts.edit ? 'EditedMessage' : 'NewMessage';
  const reg = [...world.tg.handlers].reverse().find((h) => h.name === name);
  if (!reg) throw new Error(`no ${name} handler registered; start the listener first`);
  await reg.handler({ message: channelMessage(text, id, nowSec(), opts.edit) });
}

/** Sets the same quote on every simulated broker in the world. */
async function quote(bid: number, ask: number): Promise<void> {
  await world.demo.setQuote('XAUUSD', bid, ask);
  await world.paper.setQuote('XAUUSD', bid, ask);
}

/** One AutoTrader pass in the order the service runs it: feed, reconcile, lifecycle. */
async function cycle(): Promise<void> {
  await mods.feed.tickSignalFeed();
  await mods.reconciler.runReconciliation();
  await mods.lifecycle.runLifecycleTick();
}

function tradeSetId(messageId: number): string {
  return tradeSetIdFor(SOURCE, String(messageId));
}

function tradeSet(messageId: number): TradeSetDoc {
  const doc = world.fake.peek(`trade_sets/${tradeSetId(messageId)}`);
  if (!doc) throw new Error(`no trade set for message ${messageId}`);
  return doc as unknown as TradeSetDoc;
}

function signalEventCount(): number {
  return world.fake.docs('signal_events').length;
}

/** Event types for a trade set, in insertion order. */
function types(messageId: number): string[] {
  return eventTypes(world.fake, tradeSetId(messageId));
}

function eventsOf(messageId: number, type: string): Record<string, unknown>[] {
  return eventDocs(world.fake, tradeSetId(messageId)).filter((d) => d.type === type);
}

async function positionsOf(sim: SimulatedBroker) {
  return sim.getPositions();
}

/** Closing deals (OUT) of the bot's positions, as the simulated account records them. */
async function outDeals(sim: SimulatedBroker): Promise<number> {
  const state = await sim.getState();
  return state.deals.filter((d) => d.entry === 'OUT' && d.magic === MAGIC).length;
}

// ---------------------------------------------------------------------------
// Happy path, shared by the BUY and SELL scenarios
// ---------------------------------------------------------------------------

interface Plan {
  direction: 'buy' | 'sell';
  messageId: number;
  text: string;
  /** Stop-loss and take-profit prices as signalled. */
  sl: number;
  tps: [number, number, number];
  /** Quote that sits inside the entry range (fill price is ask for BUY, bid for SELL). */
  open: [bid: number, ask: number];
  /** Quotes that reach each checkpoint (priceCurrent is bid for BUY, ask for SELL). */
  hit: { tp1: [number, number]; tp2: [number, number]; tp3: [number, number] };
  /** Stop after each checkpoint, from the example profile's stop_loss rules. */
  slAfterTp1: number;
  slAfterTp2: number;
}

const BUY: Plan = {
  direction: 'buy',
  messageId: 3001,
  text: 'BUY XAUUSD\nOPEN : 2000-2002\nSL : 1995\nTP1 : 2005\nTP2 : 2010\nTP3 : 2020',
  sl: 1995,
  tps: [2005, 2010, 2020],
  open: [2000.9, 2001.0],
  hit: { tp1: [2005.0, 2005.1], tp2: [2010.0, 2010.1], tp3: [2020.0, 2020.1] },
  slAfterTp1: 2001.2,
  slAfterTp2: 2005,
};

const SELL: Plan = {
  direction: 'sell',
  messageId: 3002,
  text: 'SELL XAUUSD\nOPEN : 2000-2002\nSL : 2007\nTP1 : 1997\nTP2 : 1992\nTP3 : 1982',
  sl: 2007,
  tps: [1997, 1992, 1982],
  open: [2001.0, 2001.1],
  hit: { tp1: [1996.9, 1997.0], tp2: [1991.9, 1992.0], tp3: [1981.9, 1982.0] },
  slAfterTp1: 2000.8,
  slAfterTp2: 1997,
};

/** Trade-event types of a full run: every stage of the chain, in order. */
const FULL_RUN_EVENTS = [
  'signal_received',
  'signal_validated',
  'entry_submitted',
  'entry_confirmed',
  'protection_confirmed',
  'tp_checkpoint_reached', // TP1
  'partial_close_requested',
  'partial_close_confirmed',
  'sl_modified', // after TP1
  'tp_checkpoint_reached', // TP2
  'partial_close_requested',
  'partial_close_confirmed',
  'sl_modified', // after TP2
  'position_closed', // final TP
];

/**
 * Runs a signal from Telegram to CLOSED and asserts every stage. Returns the
 * stop-loss history so the caller can compare directions.
 */
async function runFullTrade(plan: Plan): Promise<{ slHistory: number[] }> {
  const forwardedTps = plan.tps;
  const sign = plan.direction === 'buy' ? 1 : -1;

  // 1. Telegram -> forwarder -> destination and signal_events.
  await quote(plan.open[0], plan.open[1]);
  await deliver(plan.text, plan.messageId);
  expect(world.tg.sent).toEqual([
    { entity: { id: `entity:${DEST}` }, text: forwardedText(plan.direction, forwardedTps, plan.sl) },
  ]);
  expect(signalEventCount()).toBe(1);
  expect(world.fake.docs('signal_events')[0].data).toMatchObject({
    chat_id: SOURCE,
    message_id: String(plan.messageId),
    kind: 'signal',
  });

  // 2. AutoTrader cycle opens the trade.
  await cycle();
  const opened = tradeSet(plan.messageId);
  expect(opened.state).toBe('OPEN');
  expect(opened.mode).toBe('demo');
  expect(opened.broker).toBe('simulated');
  expect(opened.profile).toEqual({ doc_id: PROFILE_DOC_ID, profile_id: 'optimal-report-xauusd-example', version: 1 });
  // Risk 0.5% of 10000 is capped at 50 money. A 6.00 stop gives 600 per lot, so 0.08 lots (48 money).
  expect(opened.plan?.volume).toBeCloseTo(0.08, 8);
  expect(opened.plan?.risk_money).toBeCloseTo(48, 2);
  expect(opened.plan?.sl).toBe(plan.sl);
  expect(opened.plan?.broker_tp).toBe(plan.tps[2]);
  expect(opened.plan?.checkpoints.map((c) => c.price)).toEqual(plan.tps);
  expect(opened.correlation_comment).toBe(correlationComment(tradeSetId(plan.messageId)));

  let positions = await positionsOf(world.demo);
  expect(positions).toHaveLength(1);
  expect(positions[0]).toMatchObject({
    comment: opened.correlation_comment,
    volume: 0.08,
    sl: plan.sl,
    tp: plan.tps[2],
  });
  expect(types(plan.messageId)).toEqual(FULL_RUN_EVENTS.slice(0, 5));

  // 3. TP1 reached: partial close of 50 percent, then SL moves after the checkpoint.
  await quote(plan.hit.tp1[0], plan.hit.tp1[1]);
  await cycle();
  let trade = tradeSet(plan.messageId);
  expect(trade.state).toBe('PARTIALLY_CLOSED');
  expect(trade.lifecycle?.checkpoints[0]).toMatchObject({ status: 'done', target_remaining_volume: 0.04 });
  expect(trade.lifecycle?.checkpoints[0].deal_ticket).toBeGreaterThan(0);
  positions = await positionsOf(world.demo);
  expect(positions[0].volume).toBeCloseTo(0.04, 8);
  expect(positions[0].sl).toBe(plan.sl); // the close cycle does not also move the stop
  expect(await outDeals(world.demo)).toBe(1);

  // Same price, next cycle: the stop moves to the after-TP1 level.
  await cycle();
  positions = await positionsOf(world.demo);
  expect(positions[0].sl).toBe(plan.slAfterTp1);
  expect(await outDeals(world.demo)).toBe(1);

  // Repeated cycles at the same price must not close again.
  await cycle();
  await cycle();
  expect(await outDeals(world.demo)).toBe(1);
  positions = await positionsOf(world.demo);
  expect(positions[0].volume).toBeCloseTo(0.04, 8);
  expect(positions[0].sl).toBe(plan.slAfterTp1);

  // 4. TP2 reached: second partial close, then the stop moves to TP1.
  await quote(plan.hit.tp2[0], plan.hit.tp2[1]);
  await cycle();
  trade = tradeSet(plan.messageId);
  expect(trade.state).toBe('PARTIALLY_CLOSED');
  expect(trade.lifecycle?.checkpoints[1]).toMatchObject({ status: 'done', target_remaining_volume: 0.02 });
  positions = await positionsOf(world.demo);
  expect(positions[0].volume).toBeCloseTo(0.02, 8);
  expect(await outDeals(world.demo)).toBe(2);

  await cycle();
  positions = await positionsOf(world.demo);
  expect(positions[0].sl).toBe(plan.slAfterTp2);

  // 5. TP3 (broker TP at the final checkpoint): the position closes.
  await quote(plan.hit.tp3[0], plan.hit.tp3[1]);
  await cycle();
  expect(await positionsOf(world.demo)).toHaveLength(0);
  trade = tradeSet(plan.messageId);
  expect(trade.state).toBe('CLOSED');
  expect(trade.result?.close_reason).toBe('checkpoints_complete');
  // Realized money: 0.04 @ 4.00 + 0.02 @ 9.00 + 0.02 @ 19.00 points of 1 USD per 0.01 per lot, i.e. 16 + 18 + 38.
  expect(trade.result?.realized_pnl).toBeCloseTo(72, 2);
  expect(trade.result?.realized_pnl).toBeGreaterThan(0);
  expect(trade.lifecycle?.current_volume).toBe(0);
  expect(await outDeals(world.demo)).toBe(3);

  // A trailing cycle changes nothing.
  await cycle();
  expect(tradeSet(plan.messageId).state).toBe('CLOSED');

  // The audit trail, in order.
  expect(types(plan.messageId)).toEqual(FULL_RUN_EVENTS);
  const closed = eventsOf(plan.messageId, 'position_closed');
  expect(closed).toHaveLength(1);
  expect(closed[0].reason_code).toBe('checkpoints_complete');

  // Stop history: strictly tightening in trade direction.
  const slHistory = [plan.sl, plan.slAfterTp1, plan.slAfterTp2];
  for (let i = 1; i < slHistory.length; i++) {
    expect(sign * (slHistory[i] - slHistory[i - 1])).toBeGreaterThan(0);
  }
  return { slHistory };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('signal pipeline end to end (offline)', () => {
  it('1. BUY XAUUSD: forward, open with risk sizing, checkpoints, SL moves, CLOSED with a positive realized PnL', async () => {
    const { slHistory } = await runFullTrade(BUY);
    expect(slHistory).toEqual([1995, 2001.2, 2005]);
  });

  it('2. SELL XAUUSD mirrors BUY: same volume, checkpoint sequence and stop tightening, opposite prices', async () => {
    const { slHistory } = await runFullTrade(SELL);
    expect(slHistory).toEqual([2007, 2000.8, 1997]);
  });

  it('3. duplicate delivery and a restart with feed re-dispatch open exactly one position', async () => {
    await quote(BUY.open[0], BUY.open[1]);
    await deliver(BUY.text, BUY.messageId);
    await cycle();
    expect(await positionsOf(world.demo)).toHaveLength(1);

    // Telegram delivers the same message again: the forwarder skips it, nothing is published or sent.
    await deliver(BUY.text, BUY.messageId);
    expect(world.tg.sent).toHaveLength(1);
    expect(signalEventCount()).toBe(1);

    // Restart: fresh module graph, same Firestore and broker state. The feed re-reads the window.
    vi.resetModules();
    mods = await loadModules();
    resetFeed(mods);
    installBrokers(mods, world.demo, world.paper, liveTrip.broker);
    await mods.listener.startTelegramListener();
    await deliver(BUY.text, BUY.messageId);
    await cycle();
    await cycle();

    expect(await positionsOf(world.demo)).toHaveLength(1);
    expect(world.tg.sent).toHaveLength(1);
    expect(signalEventCount()).toBe(1);
    expect(eventsOf(BUY.messageId, 'entry_submitted')).toHaveLength(1);
    expect(eventsOf(BUY.messageId, 'entry_confirmed')).toHaveLength(1);
    // The event's durable queue status survived the restart, so it was not dispatched again.
    const [signalDoc] = world.fake.docs('signal_events');
    expect(signalDoc.data.autotrader).toMatchObject({ status: 'done', outcome: 'submitted', attempts: 1 });
  });

  it('4. an edit after fill tightens the stop at the broker; a looser edit is ignored; an unparseable edit does not close', async () => {
    await quote(BUY.open[0], BUY.open[1]);
    await deliver(BUY.text, BUY.messageId);
    await cycle();
    expect(tradeSet(BUY.messageId).state).toBe('OPEN');

    // Tighter stop: applied (after_fill is apply_tighten_only in the example profile).
    await deliver('BUY XAUUSD\nOPEN : 2000-2002\nSL : 1997\nTP1 : 2005\nTP2 : 2010\nTP3 : 2020', BUY.messageId, {
      edit: true,
    });
    await cycle();
    let positions = await positionsOf(world.demo);
    expect(positions[0].sl).toBe(1997);
    let trade = tradeSet(BUY.messageId);
    expect(trade.signal_revisions).toHaveLength(1);
    expect(trade.signal_revisions[0]).toMatchObject({ outcome: 'applied', reason: 'sl_applied; tp_unchanged' });
    expect(eventsOf(BUY.messageId, 'sl_modified').some((e) => e.sl === 1997)).toBe(true);
    // The correction is forwarded as a correction.
    expect(world.tg.sent).toHaveLength(2);
    expect(world.tg.sent[1].text).toBe(forwardedText('buy', BUY.tps, 1997, true));

    // Looser stop: ignored, the stop stays at 1997.
    await deliver('BUY XAUUSD\nOPEN : 2000-2002\nSL : 1990\nTP1 : 2005\nTP2 : 2010\nTP3 : 2020', BUY.messageId, {
      edit: true,
    });
    await cycle();
    positions = await positionsOf(world.demo);
    expect(positions[0].sl).toBe(1997);
    trade = tradeSet(BUY.messageId);
    expect(trade.signal_revisions[1]).toMatchObject({ outcome: 'ignored', reason: 'sl_loosen_ignored; tp_unchanged' });

    // Unparseable edit: the open position is left alone.
    await deliver('Market is choppy, waiting for a cleaner set-up', BUY.messageId, { edit: true });
    await cycle();
    positions = await positionsOf(world.demo);
    expect(positions).toHaveLength(1);
    expect(positions[0].volume).toBeCloseTo(0.08, 8);
    expect(await outDeals(world.demo)).toBe(0);
    trade = tradeSet(BUY.messageId);
    expect(trade.state).toBe('OPEN');
    expect(trade.cancel_requested).toBeUndefined();
    expect(types(BUY.messageId)).not.toContain('position_closed');
  });

  it('5. kill switch: a new signal is skipped, while an open trade still gets its TP1 partial close', async () => {
    await quote(BUY.open[0], BUY.open[1]);
    await deliver(BUY.text, BUY.messageId);
    await cycle();
    expect(tradeSet(BUY.messageId).state).toBe('OPEN');

    world.fake.seed(SETTINGS_PATH, settingsDoc({ trading: { kill_switch: true } }));
    mods.control.invalidateExecutionControl();
    mods.secrets.invalidateMt5Config();

    const second = 3005;
    await deliver(BUY.text, second);
    await cycle();
    expect(tradeSet(second).state).toBe('SKIPPED');
    expect(tradeSet(second).skip_reason).toBe('kill_switch');
    expect(eventsOf(second, 'execution_skipped')[0].reason_code).toBe('kill_switch');
    expect(await positionsOf(world.demo)).toHaveLength(1);

    // Management continues under the kill switch.
    await quote(BUY.hit.tp1[0], BUY.hit.tp1[1]);
    await cycle();
    expect(tradeSet(BUY.messageId).state).toBe('PARTIALLY_CLOSED');
    expect((await positionsOf(world.demo))[0].volume).toBeCloseTo(0.04, 8);
    expect(await positionsOf(world.demo)).toHaveLength(1);
  });

  it('6. paper mode: the simulated paper broker takes the order and the demo broker is never called', async () => {
    world.fake.seed(
      SETTINGS_PATH,
      settingsDoc({ execution: { mode: 'paper', active_profile_doc_id: PROFILE_DOC_ID } }),
    );
    mods.control.invalidateExecutionControl();
    const demoTrip = tripwireBroker('demo', MAGIC);
    mods.router.setBrokerForTests('demo', demoTrip.broker);

    await quote(BUY.open[0], BUY.open[1]);
    await deliver(BUY.text, BUY.messageId);
    await cycle();
    expect(tradeSet(BUY.messageId)).toMatchObject({ state: 'OPEN', mode: 'paper', broker: 'simulated' });
    expect(await positionsOf(world.paper)).toHaveLength(1);

    await quote(BUY.hit.tp1[0], BUY.hit.tp1[1]);
    await cycle();
    expect(tradeSet(BUY.messageId).state).toBe('PARTIALLY_CLOSED');
    expect(demoTrip.calls).toEqual([]);
    expect(liveTrip.calls).toEqual([]);
  });

  it('7. execution mode missing (disabled): the signal is forwarded but skipped as execution_disabled', async () => {
    world.fake.seed(SETTINGS_PATH, settingsDoc({ execution: { active_profile_doc_id: PROFILE_DOC_ID } }));
    mods.control.invalidateExecutionControl();

    await quote(BUY.open[0], BUY.open[1]);
    await deliver(BUY.text, BUY.messageId);
    expect(world.tg.sent).toHaveLength(1);
    await cycle();

    const trade = tradeSet(BUY.messageId);
    expect(trade.state).toBe('SKIPPED');
    expect(trade.skip_reason).toBe('execution_disabled');
    expect(await positionsOf(world.demo)).toHaveLength(0);
    expect(types(BUY.messageId)).toEqual(['signal_received', 'execution_skipped']);
  });

  // BUG (wiring, not asserted here): runReconciliation is called directly below, but
  // startReconciler() is not called from autotrader.ts, so a running AutoTrader never
  // resolves SUBMIT_UNKNOWN on its own. Same for startAdminCommandPoller() and scenario 10.
  it('8. ambiguous entry: the request is recorded as SUBMIT_UNKNOWN, then resolved to OPEN after expiry without a second order', async () => {
    world.demo.failNext('placeOrder', 'ambiguous');
    await quote(BUY.open[0], BUY.open[1]);
    await deliver(BUY.text, BUY.messageId);
    await cycle();

    // The simulated broker executed the order before the reply was lost.
    expect(tradeSet(BUY.messageId).state).toBe('SUBMIT_UNKNOWN');
    expect(types(BUY.messageId)).toContain('entry_unknown');
    expect(await positionsOf(world.demo)).toHaveLength(1);

    // Still inside the window (expires_at + 5 s): the reconciler must not decide yet.
    await cycle();
    expect(tradeSet(BUY.messageId).state).toBe('SUBMIT_UNKNOWN');

    // Past the window: the reconciler finds the position by correlation comment.
    vi.setSystemTime(T0_MS + 14_000);
    await cycle();
    const trade = tradeSet(BUY.messageId);
    expect(trade.state).toBe('OPEN');
    const positions = await positionsOf(world.demo);
    expect(positions).toHaveLength(1);
    expect(trade.broker_refs?.position_ticket).toBe(positions[0].ticket);
    expect(types(BUY.messageId)).toContain('entry_confirmed');
    expect(types(BUY.messageId)).toContain('reconciliation');
  });

  it('9. broker rejection: REJECTED with the retcode recorded, and no position', async () => {
    world.demo.failNext('placeOrder', 'reject', 10019);
    await quote(BUY.open[0], BUY.open[1]);
    await deliver(BUY.text, BUY.messageId);
    await cycle();

    const trade = tradeSet(BUY.messageId);
    expect(trade.state).toBe('REJECTED');
    expect(trade.error).toContain('broker_rejected');
    expect(await positionsOf(world.demo)).toHaveLength(0);
    const rejected = eventsOf(BUY.messageId, 'entry_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].retcode).toBe(10019);
    expect(types(BUY.messageId)).not.toContain('position_closed');
  });

  it('10. close_all: the bot position is closed, the kill switch is engaged, and a foreign-magic position is untouched', async () => {
    // One shared account state: the bot and a foreign EA trade on the same account.
    const account = memoryStore();
    world.demo = simFor(MAGIC, account);
    mods.router.setBrokerForTests('demo', world.demo);
    await quote(BUY.open[0], BUY.open[1]);
    await deliver(BUY.text, BUY.messageId);
    await cycle();
    expect(await positionsOf(world.demo)).toHaveLength(1);

    const foreign = simFor(FOREIGN_MAGIC, account);
    await foreign.setQuote('XAUUSD', BUY.open[0], BUY.open[1]);
    await foreign.placeOrder({
      symbol: 'XAUUSD',
      orderType: 'BUY',
      volume: 0.01,
      price: 0,
      sl: 1990,
      tp: 2030,
      deviationPoints: 30,
      comment: 'FOREIGN-EA',
    });

    // Reopen the bot's view of the same account: the foreign position is in the shared state.
    world.demo = simFor(MAGIC, account);
    mods.router.setBrokerForTests('demo', world.demo);
    expect(await positionsOf(world.demo)).toHaveLength(1);

    // Skip the settle wait between the two close-all sweeps (the wait is a real 10 s delay).
    mods.admin.setCloseAllSettleMsForTests(0);
    world.fake.seed('admin_commands/close-all-1', {
      type: 'close_all',
      status: 'pending',
      confirm: 'CLOSE ALL',
      requested_at: new Date(Date.now()).toISOString(),
    });
    expect(await mods.admin.runAdminCommands()).toBe(1);

    const command = world.fake.peek('admin_commands/close-all-1');
    expect(command?.status).toBe('done');
    expect(world.fake.peek(SETTINGS_PATH)?.trading).toEqual({ kill_switch: true });
    const results = (command?.result as { results: { kind: string; ticket?: number; ok: boolean }[] }).results;
    const positionResults = results.filter((r) => r.kind === 'position');
    expect(positionResults.every((r) => r.ok)).toBe(true);
    expect(positionResults.map((r) => r.ticket)).toEqual([tradeSet(BUY.messageId).broker_refs?.position_ticket]);

    await cycle();
    const trade = tradeSet(BUY.messageId);
    expect(trade.state).toBe('CLOSED');
    expect(trade.result?.close_reason).toBe('close_all');

    // The foreign position is still open on the shared account.
    const shared = account.state();
    const remaining = shared?.positions ?? [];
    expect(remaining.map((p) => ({ magic: p.magic, comment: p.comment, volume: p.volume }))).toEqual([
      { magic: FOREIGN_MAGIC, comment: 'FOREIGN-EA', volume: 0.01 },
    ]);
  });

  it('11. AutoTrader without Firestore: no broker call at all; the event is picked up once Firestore returns', async () => {
    const rec = recordingBroker(world.demo);
    mods.router.setBrokerForTests('demo', rec.broker);
    await quote(BUY.open[0], BUY.open[1]);

    // The forwarder still has Firestore and publishes the signal.
    await deliver(BUY.text, BUY.messageId);
    expect(signalEventCount()).toBe(1);

    world.firestoreUp = false;
    mods.control.invalidateExecutionControl();
    mods.secrets.invalidateMt5Config();
    await cycle();
    expect(rec.calls).toEqual([]);
    expect(await positionsOf(world.demo)).toHaveLength(0);

    // Firestore returns: the event is still queued and is executed exactly once.
    world.firestoreUp = true;
    mods.control.invalidateExecutionControl();
    mods.secrets.invalidateMt5Config();
    await cycle();
    await cycle();
    expect(tradeSet(BUY.messageId).state).toBe('OPEN');
    expect(rec.calls.filter((c) => c === 'placeOrder')).toHaveLength(1);
    expect(await positionsOf(world.demo)).toHaveLength(1);
  });

  it('12. a profile that violates safety at runtime blocks new entries but not management of the open trade', async () => {
    await quote(BUY.open[0], BUY.open[1]);
    await deliver(BUY.text, BUY.messageId);
    await cycle();
    expect(tradeSet(BUY.messageId).state).toBe('OPEN');

    // Safety tightened below the profile's 0.5 percent risk. The profile stays active but is no longer valid.
    world.fake.seed(
      SETTINGS_PATH,
      settingsDoc({
        safety: {
          max_risk_percent_per_trade: 0.4,
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
        },
      }),
    );
    mods.control.invalidateExecutionControl();
    mods.secrets.invalidateMt5Config();

    await deliver(BUY.text, 3012);
    await cycle();
    expect(tradeSet(3012).state).toBe('SKIPPED');
    expect(tradeSet(3012).skip_reason).toBe('invalid_profile');
    expect(await positionsOf(world.demo)).toHaveLength(1);

    // The open trade is still managed under its frozen snapshot.
    await quote(BUY.hit.tp1[0], BUY.hit.tp1[1]);
    await cycle();
    expect(tradeSet(BUY.messageId).state).toBe('PARTIALLY_CLOSED');
    expect(tradeSet(BUY.messageId).profile_snapshot?.sizing.risk_percent).toBe(0.5);
  });
  // -------------------------------------------------------------------------
  // Durable signal queue (Phase 1 of the hardening pass)
  // -------------------------------------------------------------------------

  it('13. an ambiguous entry is never re-sent: not after a restart, and not after an expired lease', async () => {
    const rec = recordingBroker(world.demo);
    mods.router.setBrokerForTests('demo', rec.broker);
    world.demo.failNext('placeOrder', 'ambiguous');
    await quote(BUY.open[0], BUY.open[1]);
    await deliver(BUY.text, BUY.messageId);
    await cycle();
    expect(tradeSet(BUY.messageId).state).toBe('SUBMIT_UNKNOWN');
    const [ev] = world.fake.docs('signal_events');
    expect(ev.data.autotrader).toMatchObject({ status: 'done', state: 'SUBMIT_UNKNOWN', attempts: 1 });

    // Worst case: the worker died after the send but before recording completion.
    world.fake.seed(`signal_events/${ev.id}`, {
      ...ev.data,
      autotrader: {
        ...(ev.data.autotrader as Record<string, unknown>),
        status: 'processing',
        lease_id: 'crashed-lease',
        lease_owner: 'crashed-worker',
        lease_expires_at: new Date(T0_MS - 1).toISOString(),
      },
    });

    vi.resetModules();
    mods = await loadModules();
    resetFeed(mods);
    installBrokers(mods, rec.broker, world.paper, liveTrip.broker);
    await cycle();
    await cycle();
    expect(rec.calls.filter((c) => c === 'placeOrder')).toHaveLength(1);
    expect(world.fake.peek(`signal_events/${ev.id}`)?.autotrader).toMatchObject({ status: 'done', attempts: 2, outcome: 'noop' });

    // The reconciler, not a retry, resolves the ambiguity from broker state.
    vi.setSystemTime(T0_MS + 14_000);
    await cycle();
    expect(tradeSet(BUY.messageId).state).toBe('OPEN');
    expect(await positionsOf(world.demo)).toHaveLength(1);
    expect(rec.calls.filter((c) => c === 'placeOrder')).toHaveLength(1);
  });

  it('14. a worker that died mid-gates: the re-run after the lease expires sends nothing for a stale signal', async () => {
    const rec = recordingBroker(world.demo);
    mods.router.setBrokerForTests('demo', rec.broker);
    await quote(BUY.open[0], BUY.open[1]);
    await deliver(BUY.text, BUY.messageId);
    const [ev] = world.fake.docs('signal_events');
    // State the crash left behind: trade set claimed, event leased by a dead worker.
    world.fake.seed(`trade_sets/${tradeSetId(BUY.messageId)}`, {
      schema: 2,
      trade_set_id: tradeSetId(BUY.messageId),
      chat_id: SOURCE,
      message_id: String(BUY.messageId),
      event_id: ev.id,
      signal: ev.data.signal as Record<string, unknown>,
      signal_revisions: [],
      symbol: 'XAUUSD',
      broker_symbol: null,
      direction: 'buy',
      order_type: null,
      mode: 'demo',
      broker: null,
      profile: null,
      profile_snapshot: null,
      limits_snapshot: null,
      state: 'CLAIMED',
      correlation_comment: correlationComment(tradeSetId(BUY.messageId)),
      claim: { attempts: 1, claimed_at: new Date(T0_MS).toISOString(), owner: 'crashed-worker' },
      plan: null,
      submission: null,
      broker_refs: null,
      lifecycle: null,
      result: null,
      created_at: new Date(T0_MS).toISOString(),
      updated_at: new Date(T0_MS).toISOString(),
    });
    world.fake.seed(`signal_events/${ev.id}`, {
      ...ev.data,
      autotrader: {
        ...(ev.data.autotrader as Record<string, unknown>),
        status: 'processing',
        attempts: 1,
        lease_id: 'crashed-lease',
        lease_owner: 'crashed-worker',
        lease_expires_at: new Date(T0_MS + 120_000).toISOString(),
      },
    });

    vi.setSystemTime(T0_MS + 3 * 60_000);
    await cycle();
    expect(tradeSet(BUY.messageId).state).toBe('SKIPPED');
    expect(tradeSet(BUY.messageId).skip_reason).toBe('signal_too_old');
    expect(rec.calls).not.toContain('placeOrder');
    expect(world.fake.peek(`signal_events/${ev.id}`)?.autotrader).toMatchObject({ status: 'done', attempts: 2, outcome: 'skipped' });
  });

  it('15. two AutoTrader workers on one queue: each event is executed once and the edit waits for its signal', async () => {
    const rec = recordingBroker(world.demo);
    mods.router.setBrokerForTests('demo', rec.broker);
    await quote(BUY.open[0], BUY.open[1]);
    await deliver(BUY.text, BUY.messageId);
    await deliver(BUY.text.replace('SL : 1995', 'SL : 1997'), BUY.messageId, { edit: true });
    expect(signalEventCount()).toBe(2);

    const workerB = mods.feed.createSignalFeed({ workerId: 'worker-b', rand: () => 0.5 });
    await Promise.all([mods.feed.tickSignalFeed(), workerB.tick()]);
    await Promise.all([mods.feed.tickSignalFeed(), workerB.tick()]);

    expect(rec.calls.filter((c) => c === 'placeOrder')).toHaveLength(1);
    expect(await positionsOf(world.demo)).toHaveLength(1);
    const trade = tradeSet(BUY.messageId);
    expect(trade.state).toBe('OPEN');
    expect(trade.signal_revisions).toHaveLength(1);
    expect(trade.signal_revisions[0].outcome).toBe('applied');
    expect((await positionsOf(world.demo))[0].sl).toBe(1997);
    for (const doc of world.fake.docs('signal_events')) {
      expect(doc.data.autotrader).toMatchObject({ status: 'done', attempts: 1 });
    }
  });

  it('16. a 30-minute Firestore outage: events are spooled by the forwarder, applied in order afterwards, and a stale entry is not executed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bytrader-e2e-outbox-'));
    const saved = {
      FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
      FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
      FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY,
      SIGNAL_OUTBOX_PATH: process.env.SIGNAL_OUTBOX_PATH,
    };
    // Presence only (the outbox is used when Firestore is configured); the client is the fake.
    process.env.FIREBASE_PROJECT_ID = 'demo-e2e';
    process.env.FIREBASE_CLIENT_EMAIL = 'e2e@example.invalid';
    process.env.FIREBASE_PRIVATE_KEY = 'not-a-key';
    process.env.SIGNAL_OUTBOX_PATH = path.join(dir, 'signal_outbox.jsonl');
    const events = await import('./signalEvents.js');
    events._resetSignalEventsForTests();
    try {
      const rec = recordingBroker(world.demo);
      mods.router.setBrokerForTests('demo', rec.broker);
      await quote(BUY.open[0], BUY.open[1]);
      await deliver(BUY.text, BUY.messageId);
      await cycle();
      expect(tradeSet(BUY.messageId).state).toBe('OPEN');

      world.fake.setOffline(true);
      vi.setSystemTime(T0_MS + 60_000);
      // A stop tightening for the open trade, then a brand-new signal, both during the outage.
      await deliver(BUY.text.replace('SL : 1995', 'SL : 1997'), BUY.messageId, { edit: true });
      vi.setSystemTime(T0_MS + 90_000);
      await deliver(SELL.text, SELL.messageId);
      expect(events.getSignalOutboxDepth()).toBe(2);

      // The AutoTrader keeps polling and failing closed for half an hour.
      for (let m = 2; m <= 31; m += 1) {
        vi.setSystemTime(T0_MS + m * 60_000);
        await mods.feed.tickSignalFeed().catch(() => undefined);
        await mods.reconciler.runReconciliation().catch(() => undefined);
        await mods.lifecycle.runLifecycleTick().catch(() => undefined);
      }
      expect(rec.calls.filter((c) => c === 'placeOrder')).toHaveLength(1);

      world.fake.setOffline(false);
      mods.control.invalidateExecutionControl();
      mods.secrets.invalidateMt5Config();
      await events.flushSignalOutbox();
      expect(events.getSignalOutboxDepth()).toBe(0);
      await cycle();
      await cycle();

      // The edit was applied to the open trade; the 30-minute-old entry was refused.
      expect((await positionsOf(world.demo)).map((p) => p.sl)).toEqual([1997]);
      expect(tradeSet(BUY.messageId).signal_revisions.map((r) => r.outcome)).toEqual(['applied']);
      expect(tradeSet(SELL.messageId).state).toBe('SKIPPED');
      expect(tradeSet(SELL.messageId).skip_reason).toBe('signal_too_old');
      expect(rec.calls.filter((c) => c === 'placeOrder')).toHaveLength(1);
      for (const doc of world.fake.docs('signal_events')) expect((doc.data.autotrader as { status: string }).status).toBe('done');
    } finally {
      events._resetSignalEventsForTests();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
