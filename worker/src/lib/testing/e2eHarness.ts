/**
 * e2eHarness.ts
 *
 * Data-layer helpers for the offline end-to-end pipeline tests
 * (pipeline.e2e.test.ts). Test-only; no network access and no vitest imports,
 * so module mocking stays in the test file where vi.doMock paths resolve.
 *
 * Provides:
 *  - a Firestore view over the in-memory fake that also offers root-level
 *    doc('collection/id'), which the forwarder reads for settings/default
 *  - a settings/default and execution profile seeder (profile built from the
 *    canonical example JSON)
 *  - simulated brokers with the XAUUSD spec from the design contracts
 *  - tripwire brokers that record and reject every call (for modes that must
 *    never reach a broker)
 *  - a fake GramJS client that records forwarded messages and event handlers
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FakeData, FakeFirestore, FakeTransaction } from './fakeFirestore.js';
import { DEFAULT_SAFETY_LIMITS, profileDocId } from '../executionProfile.js';
import type { ExecutionProfile } from '../executionProfile.js';
import type { AccountInfo, BrokerAdapter, SymbolInfo } from '../brokerTypes.js';
import type { SimState, SimulatedBrokerOptions } from '../simulatedBroker.js';

export const T0_ISO = '2026-10-18T10:00:00.000Z';
export const T0_MS = Date.parse(T0_ISO);
/** Forwarder source channel (signal chat). */
export const SOURCE = '-1003271337051';
/** Destination channel the forwarder copies signals to. */
export const DEST = '-1001234567890';
export const MAGIC = 98801;
/** Magic of a foreign EA sharing the same account (not ours). */
export const FOREIGN_MAGIC = 55501;
export const PROFILE_ID = 'optimal-report-xauusd-example';
export const PROFILE_DOC_ID = profileDocId(PROFILE_ID, 1);
export const SETTINGS_PATH = 'settings/default';

export const SPEC: SymbolInfo = {
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

export const ACCOUNT: Partial<AccountInfo> = {
  login: 1001,
  tradeMode: 'DEMO',
  balance: 10000,
  equity: 10000,
  tradeAllowed: true,
  tradeExpert: true,
  terminalTradeAllowed: true,
  server: 'SIMULATED-E2E',
  company: 'ByTrader e2e',
};

/** Canonical example profile, read from docs so the test tracks the published shape. */
export function loadExampleProfile(): Record<string, unknown> {
  const path = resolve(__dirname, '../../../../docs/project_memory/examples/optimal_report_profile.example.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** Approved, active profile document as stored in execution_profiles. */
export function profileDoc(overrides: Record<string, unknown> = {}): FakeData {
  return {
    ...loadExampleProfile(),
    status: 'active',
    validation: { ok: true, errors: [], warnings: [], validated_at: new Date(T0_MS).toISOString() },
    created_at: new Date(T0_MS).toISOString(),
    updated_at: new Date(T0_MS).toISOString(),
    ...overrides,
  };
}

/** Parsed profile, for asserting against the frozen snapshot. */
export function exampleProfileValue(): ExecutionProfile {
  return loadExampleProfile() as unknown as ExecutionProfile;
}

/**
 * settings/default. `patch` replaces top-level keys (use it to drop or change one
 * block, e.g. `{ execution: { active_profile_doc_id } }` removes the mode).
 */
export function settingsDoc(patch: FakeData = {}): FakeData {
  return {
    execution: { mode: 'demo', active_profile_doc_id: PROFILE_DOC_ID },
    trading: { kill_switch: false },
    safety: { ...DEFAULT_SAFETY_LIMITS, allowed_signal_symbols: [...DEFAULT_SAFETY_LIMITS.allowed_signal_symbols] },
    mt5: { source_chat_ids: [SOURCE], symbol_base: 'XAUUSD', magic: MAGIC },
    telegram: { signal_forward_enabled: true, forward_chat_id: DEST, signal_source_chat_ids: [SOURCE] },
    ...patch,
  };
}

/** Firestore view for production code: collection(), root doc('a/b'), runTransaction. */
export function firestoreView(fake: FakeFirestore): FirebaseFirestore.Firestore {
  const view = {
    collection: (name: string) => fake.collection(name),
    doc: (path: string) => {
      const parts = path.split('/');
      if (parts.length !== 2) throw new Error(`e2e firestore view: bad document path ${path}`);
      return fake.collection(parts[0]).doc(parts[1]);
    },
    runTransaction: (fn: (tx: FakeTransaction) => unknown) => fake.runTransaction(fn),
  };
  return view as unknown as FirebaseFirestore.Firestore;
}

/**
 * Options for createSimulatedBroker on the XAUUSD spec. Pass the factory from the
 * same module graph as the engine (see the test's loadModules), or instanceof
 * checks on BrokerRejectedError and BrokerAmbiguousError fail across graphs.
 * Optional shared persistence lets two instances share one account state.
 */
export function simOptions(magic: number, persistence?: MemoryStore): SimulatedBrokerOptions {
  return {
    magic,
    account: { ...ACCOUNT },
    symbols: { XAUUSD: { ...SPEC } },
    persistence: persistence?.persistence(),
  };
}

/** In-memory SimState store that copies on every load and save, like Firestore. */
export interface MemoryStore {
  readonly state: () => SimState | null;
  persistence(): { load(): Promise<SimState | null>; save(s: SimState): Promise<void> };
}

export function memoryStore(): MemoryStore {
  let saved: SimState | null = null;
  return {
    state: () => (saved === null ? null : (JSON.parse(JSON.stringify(saved)) as SimState)),
    persistence: () => ({
      load: async () => (saved === null ? null : (JSON.parse(JSON.stringify(saved)) as SimState)),
      save: async (s: SimState) => {
        saved = JSON.parse(JSON.stringify(s)) as SimState;
      },
    }),
  };
}

/**
 * Broker that fails the test on any call. Every call is recorded in `calls`.
 * Used for modes that must never reach a broker (demo while paper runs, live).
 */
export function tripwireBroker(label: string, magic: number): { broker: BrokerAdapter; calls: string[] } {
  const calls: string[] = [];
  const trip =
    (method: string) =>
    async (): Promise<never> => {
      calls.push(method);
      throw new Error(`${label}: unexpected broker call ${method}`);
    };
  const broker: BrokerAdapter = {
    kind: 'mt5',
    magic,
    ping: trip('ping'),
    getAccountInfo: trip('getAccountInfo'),
    getSymbolInfo: trip('getSymbolInfo'),
    getPositions: trip('getPositions'),
    getOrders: trip('getOrders'),
    getDeals: trip('getDeals'),
    checkOrder: trip('checkOrder'),
    placeOrder: trip('placeOrder'),
    modifyPosition: trip('modifyPosition'),
    modifyPendingOrder: trip('modifyPendingOrder'),
    closePosition: trip('closePosition'),
    cancelOrder: trip('cancelOrder'),
  };
  return { broker, calls };
}

/** Wraps a broker so every method call is recorded by name before it runs. */
export function recordingBroker(inner: BrokerAdapter): { broker: BrokerAdapter; calls: string[] } {
  const calls: string[] = [];
  const broker = new Proxy(inner, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        calls.push(prop);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as BrokerAdapter;
  return { broker, calls };
}

export interface SentMessage {
  entity: unknown;
  text: string;
}

export interface TelegramHandler {
  name: string;
  handler: (event: { message?: unknown }) => Promise<void>;
}

/** Fake GramJS client. Records sendMessage calls and every registered event handler. */
export interface FakeTelegram {
  readonly sent: SentMessage[];
  readonly handlers: TelegramHandler[];
  readonly client: {
    getMe(): Promise<{ id: bigint }>;
    getEntity(id: string): Promise<{ id: string }>;
    getDialogs(opts: { limit: number }): Promise<never[]>;
    sendMessage(entity: unknown, params: { message: string }): Promise<Record<string, never>>;
    addEventHandler(handler: TelegramHandler['handler'], event: object): void;
  };
}

export function fakeTelegram(): FakeTelegram {
  const sent: SentMessage[] = [];
  const handlers: TelegramHandler[] = [];
  return {
    sent,
    handlers,
    client: {
      getMe: async () => ({ id: 1n }),
      getEntity: async (id: string) => ({ id: `entity:${id}` }),
      getDialogs: async (): Promise<never[]> => [],
      sendMessage: async (entity: unknown, params: { message: string }) => {
        sent.push({ entity, text: params.message });
        return {};
      },
      addEventHandler: (handler, event) => {
        handlers.push({ name: event.constructor.name, handler });
      },
    },
  };
}

/** Telegram channel message as GramJS delivers it for a channel post. */
export function channelMessage(text: string, id: number, dateSec: number, edit = false): Record<string, unknown> {
  const channelId = BigInt(SOURCE.replace(/^-100/, ''));
  return {
    message: text,
    id,
    peerId: { channelId },
    date: dateSec,
    out: false,
    ...(edit ? { editDate: dateSec } : {}),
  };
}

/** The forwarded text for a signal, as formatSignalMessage renders it. */
export function forwardedText(direction: 'buy' | 'sell', tps: number[], sl: number, correction = false): string {
  const header = direction === 'buy' ? '🟢 BUY XAUUSD' : '🔴 SELL XAUUSD';
  const lines = [...(correction ? ['♻️ CORRECTION', ''] : []), header, '', 'Entry: 2000 - 2002', `SL: ${sl}`];
  tps.forEach((tp, i) => lines.push(`TP${i + 1}: ${tp}`));
  return lines.join('\n');
}

/** Stored trade event types for one trade set, in insertion order. */
export function eventTypes(fake: FakeFirestore, tradeSetId: string): string[] {
  return fake.docs('trade_events').filter((d) => d.data.trade_set_id === tradeSetId).map((d) => String(d.data.type));
}

/** Stored trade event documents for one trade set, in insertion order. */
export function eventDocs(fake: FakeFirestore, tradeSetId: string): FakeData[] {
  return fake.docs('trade_events').filter((d) => d.data.trade_set_id === tradeSetId).map((d) => d.data);
}
