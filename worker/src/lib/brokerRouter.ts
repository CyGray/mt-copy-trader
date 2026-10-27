/**
 * brokerRouter.ts
 *
 * Picks the BrokerAdapter for an execution mode and checks the account before
 * trading (contracts §2).
 *
 * - paper: simulated broker. Quotes and symbol specs come from the MT5 bridge's
 *   read-only SYMBOL_INFO. State persists to Firestore paper_broker/state, or
 *   stays in memory when Firestore is unavailable.
 * - demo / live: the MT5 broker. demo and live share one instance, and
 *   verifyAccountForMode enforces which account is allowed.
 *
 * Deviation from contracts §2: getBroker is async because the magic comes from
 * getMt5Config() (Firestore), and paper needs one SYMBOL_INFO call.
 */

import type { ExecutionMode } from './executionControl';
import type { AccountInfo, BrokerAdapter } from './brokerTypes';
import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';
import { createMt5Broker } from './mt5Broker';
import { getMt5Config } from './mt5Secrets';
import { createSimulatedBroker, type SimState } from './simulatedBroker';

export type BrokerMode = Exclude<ExecutionMode, 'disabled'>;

export type AccountCheckReason =
  | 'account_not_demo'
  | 'account_not_real'
  | 'live_env_not_enabled'
  | 'trading_not_allowed'
  | 'account_netting'
  | 'account_unavailable';

/** `account` is null only for paper, where the account is informational. */
export type AccountCheck =
  | { ok: true; account: AccountInfo | null }
  | { ok: false; reason: AccountCheckReason };

const ACCOUNT_CACHE_MS = 30_000;
const PAPER_START_BALANCE = 10000;
const PAPER_COLLECTION = 'paper_broker';
const PAPER_DOC = 'state';
/** Paper symbol specs are re-read from the bridge at least this often. */
const DEFAULT_PAPER_SPEC_TTL_MS = 15 * 60_000;
/** A paper quote older than this is a closed market (no fills, no SL/TP triggers). */
const DEFAULT_MAX_QUOTE_AGE_MS = 60_000;

function positiveEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const overrides = new Map<BrokerMode, BrokerAdapter | null>();
const accountCache = new WeakMap<BrokerAdapter, { at: number; account: AccountInfo }>();
let mt5Instance: { magic: number; broker: BrokerAdapter } | null = null;
let paperPromise: Promise<BrokerAdapter> | null = null;
let paperWarned = false;

async function createPaperBroker(): Promise<BrokerAdapter> {
  // Creation must not require the bridge. Symbol specs and quotes are fetched
  // on demand, so the first symbol-dependent call is where an outage surfaces.
  const cfg = await getMt5Config();
  const bridge = createMt5Broker({ magic: cfg.magic });

  const firestore = initFirestore();
  let persistence: Parameters<typeof createSimulatedBroker>[0]['persistence'];
  if (firestore) {
    const ref = firestore.collection(PAPER_COLLECTION).doc(PAPER_DOC);
    persistence = {
      load: async (): Promise<SimState | null> => {
        const snap = await ref.get();
        return snap.exists ? (snap.data() as unknown as SimState) : null;
      },
      save: async (state: SimState): Promise<void> => {
        await ref.set(state as unknown as Record<string, unknown>);
      },
    };
  } else if (!paperWarned) {
    paperWarned = true;
    logger.warn('paper_broker_in_memory', { reason: 'firestore_unavailable' });
  }

  return createSimulatedBroker({
    magic: cfg.magic,
    account: {
      balance: PAPER_START_BALANCE,
      currency: 'USD',
      tradeMode: 'DEMO',
      server: 'PAPER',
      company: 'ByTrader paper',
    },
    symbols: {},
    // Paper mode reads from the bridge and never sends it a mutation: only SYMBOL_INFO is used.
    symbolProvider: (symbol: string) => bridge.getSymbolInfo(symbol),
    quoteProvider: async (symbol: string) => {
      const info = await bridge.getSymbolInfo(symbol);
      return { bid: info.bid, ask: info.ask, ...(info.tickTimeMsc > 0 ? { timeMsc: info.tickTimeMsc } : {}) };
    },
    specTtlMs: positiveEnv('PAPER_SPEC_TTL_MS', DEFAULT_PAPER_SPEC_TTL_MS),
    maxQuoteAgeMs: positiveEnv('PAPER_MAX_QUOTE_AGE_MS', DEFAULT_MAX_QUOTE_AGE_MS),
    persistence,
  });
}

function getPaperBroker(): Promise<BrokerAdapter> {
  if (!paperPromise) {
    paperPromise = createPaperBroker().catch((err: unknown) => {
      paperPromise = null; // retry on the next call
      throw err;
    });
  }
  return paperPromise;
}

/**
 * Returns the broker for a mode. May reject with BrokerUnavailableError when
 * paper mode cannot read symbol specs from the bridge.
 */
export async function getBroker(mode: BrokerMode): Promise<BrokerAdapter> {
  const override = overrides.get(mode);
  if (override) return override;
  if (mode === 'paper') return getPaperBroker();

  const cfg = await getMt5Config();
  if (!mt5Instance || mt5Instance.magic !== cfg.magic) {
    mt5Instance = { magic: cfg.magic, broker: createMt5Broker({ magic: cfg.magic }) };
  }
  return mt5Instance.broker;
}

async function cachedAccount(broker: BrokerAdapter): Promise<AccountInfo> {
  const hit = accountCache.get(broker);
  if (hit && Date.now() - hit.at < ACCOUNT_CACHE_MS) return hit.account;
  const account = await broker.getAccountInfo();
  accountCache.set(broker, { at: Date.now(), account });
  return account;
}

/**
 * Checks that the broker's account matches the mode. The account read is cached
 * for 30 s. The mode and env rules run on every call, so an env change applies
 * immediately.
 */
export async function verifyAccountForMode(mode: BrokerMode, broker: BrokerAdapter): Promise<AccountCheck> {
  if (mode === 'paper') {
    const account = await broker.getAccountInfo().catch(() => null);
    return { ok: true, account };
  }

  let account: AccountInfo;
  try {
    account = await cachedAccount(broker);
  } catch {
    return { ok: false, reason: 'account_unavailable' };
  }

  if (mode === 'demo' && account.tradeMode !== 'DEMO') return { ok: false, reason: 'account_not_demo' };
  if (mode === 'live') {
    if (account.tradeMode !== 'REAL') return { ok: false, reason: 'account_not_real' };
    if (process.env.BYTRADER_LIVE_TRADING !== 'enabled') return { ok: false, reason: 'live_env_not_enabled' };
  }
  if (!(account.tradeAllowed && account.tradeExpert && account.terminalTradeAllowed)) {
    return { ok: false, reason: 'trading_not_allowed' };
  }
  // The engine keeps one position per trade set. On a netting (or exchange) account a second
  // entry on the same symbol merges into the existing position, so those accounts are refused.
  if (account.marginMode !== 'HEDGING') return { ok: false, reason: 'account_netting' };
  return { ok: true, account };
}

/** Test seam: force the broker returned for a mode. Pass null to clear. */
export function setBrokerForTests(mode: BrokerMode, broker: BrokerAdapter | null): void {
  overrides.set(mode, broker);
}

/** Test seam: drop singletons, overrides and the paper-warning latch. */
export function _resetBrokerRouterForTests(): void {
  overrides.clear();
  mt5Instance = null;
  paperPromise = null;
  paperWarned = false;
}
