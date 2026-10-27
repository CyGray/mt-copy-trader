import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionControl } from './executionControl.js';
import { DEFAULT_SAFETY_LIMITS } from './executionProfile.js';
import type { ExecutionProfile, SafetyLimits } from './executionProfile.js';

const state = vi.hoisted(() => ({ firestore: null as unknown }));

vi.mock('./firestoreAdmin', () => ({ initFirestore: vi.fn(() => state.firestore) }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./systemLog', () => ({ writeSystemLog: vi.fn(async () => true) }));

type Mod = typeof import('./executionControl.js');

const PROFILE_BODY = {
  schema_version: 1,
  profile_id: 'gold-optimal-1',
  version: 1,
  name: 'Gold optimal',
  source: { type: 'manual' },
  broker: 'vantage_mt5',
  symbols: [{ signal_symbol: 'XAUUSD', broker_symbol: 'XAUUSD+' }],
  entry: {
    policy: 'follow_signal',
    market_tolerance_price: 0.5,
    pending_expiry_minutes: 60,
    allow_market_fallback: false,
  },
  sizing: { mode: 'fixed_lots', fixed_lots: 0.05, below_min_volume: 'skip' },
  take_profit: {
    checkpoints: [
      { tp_index: 1, close_percent: 50 },
      { tp_index: 2, close_percent: 50 },
    ],
    missing_tp: 'skip_trade',
    infeasible_split: 'skip_trade',
    broker_tp: 'final_checkpoint',
  },
  stop_loss: { min_distance_price: 1, max_distance_price: 20, after_checkpoint: [] },
  break_even: { enabled: false, trigger: 'after_tp_index', trigger_value: 1, buffer_price: 0 },
  trailing: {
    enabled: false,
    activation: 'after_tp_index',
    activation_value: 1,
    distance_price: 2,
    step_price: 0.5,
  },
  limits: {
    max_concurrent_positions: 1,
    max_positions_per_symbol: 1,
    max_spread_price: 0.5,
    max_deviation_points: 20,
    signal_max_age_sec: 120,
    daily_loss_limit_money: 100,
    max_total_risk_percent: 3,
  },
  edits: {
    before_fill: 'ignore',
    after_fill: 'ignore',
    unparseable_edit: 'ignore',
    explicit_cancel: 'ignore',
  },
};

const PROFILE_ID = 'gold-optimal-1__v1';
const ENVELOPE = {
  validation: { ok: true, errors: [], warnings: [], validated_at: '2026-10-18T09:00:00.000Z' },
  created_at: '2026-10-18T08:00:00.000Z',
  created_by: 'admin@example.com',
  updated_at: '2026-10-18T09:00:00.000Z',
  approved_at: '2026-10-18T09:00:00.000Z',
  approved_by: 'admin@example.com',
};

type Docs = Record<string, Record<string, unknown>>;

function settingsDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    execution: { mode: 'paper', active_profile_doc_id: PROFILE_ID },
    trading: { kill_switch: false },
    safety: { ...DEFAULT_SAFETY_LIMITS },
    ...overrides,
  };
}

function profileDoc(status: string, body: Record<string, unknown> = PROFILE_BODY) {
  return { ...body, status, ...ENVELOPE };
}

function defaultDocs(overrides: Docs = {}): Docs {
  return {
    'settings/default': settingsDoc(),
    [`execution_profiles/${PROFILE_ID}`]: profileDoc('approved'),
    ...overrides,
  };
}

/** Fake Firestore. `failOn` makes reads of that path reject. Counts reads per path. */
function makeFakeFirestore(docs: Docs, failOn?: string) {
  const reads: string[] = [];
  const firestore = {
    collection: (name: string) => ({
      doc: (id: string) => {
        const path = `${name}/${id}`;
        return {
          get: async () => {
            reads.push(path);
            if (failOn === path) throw new Error('14 UNAVAILABLE: connection reset');
            const data = docs[path];
            return { exists: data !== undefined, data: () => data };
          },
        };
      },
    }),
  };
  return { firestore, reads };
}

let mod: Mod;
let logger: { warn: ReturnType<typeof vi.fn> };
let writeSystemLog: ReturnType<typeof vi.fn>;

function useFirestore(docs: Docs, failOn?: string) {
  const fake = makeFakeFirestore(docs, failOn);
  state.firestore = fake.firestore;
  return fake;
}

beforeEach(async () => {
  vi.resetModules();
  mod = await import('./executionControl.js');
  logger = (await import('./logger.js')).logger as unknown as typeof logger;
  writeSystemLog = (await import('./systemLog.js')).writeSystemLog as unknown as typeof writeSystemLog;
  vi.clearAllMocks();
  state.firestore = null;
  vi.stubEnv('BYTRADER_LIVE_TRADING', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('getExecutionControl: fail closed', () => {
  it('fails closed when Firestore is unavailable and logs', async () => {
    state.firestore = null;
    const c = await mod.getExecutionControl();

    expect(c).toMatchObject({
      mode: 'disabled',
      killSwitch: true,
      activeProfileDocId: null,
      activeProfile: null,
      safety: null,
      source: 'fail_closed',
      reason: 'firestore_unavailable',
    });
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: false, reason: 'config_unavailable' });
    expect(logger.warn).toHaveBeenCalledWith('execution_control_fail_closed', expect.any(Object));
    expect(writeSystemLog).toHaveBeenCalledWith('warn', 'execution_control', expect.any(String), expect.any(Object));
  });

  it('fails closed on a settings read error', async () => {
    useFirestore(defaultDocs(), 'settings/default');
    const c = await mod.getExecutionControl();

    expect(c.source).toBe('fail_closed');
    expect(c.killSwitch).toBe(true);
    expect(c.mode).toBe('disabled');
    expect(c.reason).toMatch(/^read_error: 14 UNAVAILABLE/);
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: false, reason: 'config_unavailable' });
  });

  it('fails closed on a profile read error', async () => {
    useFirestore(defaultDocs(), `execution_profiles/${PROFILE_ID}`);
    const c = await mod.getExecutionControl();

    expect(c.source).toBe('fail_closed');
    expect(c.reason).toMatch(/^read_error/);
  });

  it('rate-limits the system log to once per 60 seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T10:00:00.000Z'));
    state.firestore = null;

    await mod.getExecutionControl();
    mod.invalidateExecutionControl();
    vi.setSystemTime(new Date('2026-10-18T10:00:30.000Z'));
    await mod.getExecutionControl();
    expect(writeSystemLog).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(2);

    mod.invalidateExecutionControl();
    vi.setSystemTime(new Date('2026-10-18T10:01:01.000Z'));
    await mod.getExecutionControl();
    expect(writeSystemLog).toHaveBeenCalledTimes(2);
  });
});

describe('getExecutionControl: mode and kill switch', () => {
  it('reads a valid paper configuration', async () => {
    useFirestore(defaultDocs());
    const c = await mod.getExecutionControl();

    expect(c.source).toBe('firestore');
    expect(c.mode).toBe('paper');
    expect(c.killSwitch).toBe(false);
    expect(c.reason).toBeUndefined();
    expect(c.activeProfileDocId).toBe(PROFILE_ID);
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: true });
  });

  it('treats a missing execution.mode as disabled', async () => {
    useFirestore(defaultDocs({ 'settings/default': settingsDoc({ execution: { active_profile_doc_id: PROFILE_ID } }) }));
    const c = await mod.getExecutionControl();

    expect(c.mode).toBe('disabled');
    expect(c.source).toBe('firestore');
    expect(c.reason).toBe('mode_missing');
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: false, reason: 'execution_disabled' });
  });

  it('treats an unknown mode as disabled with a reason', async () => {
    useFirestore(defaultDocs({ 'settings/default': settingsDoc({ execution: { mode: 'turbo', active_profile_doc_id: PROFILE_ID } }) }));
    const c = await mod.getExecutionControl();

    expect(c.mode).toBe('disabled');
    expect(c.reason).toBe('unknown_mode:turbo');
  });

  it('reports kill_switch true as a kill switch that blocks entries', async () => {
    useFirestore(defaultDocs({ 'settings/default': settingsDoc({ trading: { kill_switch: true } }) }));
    const c = await mod.getExecutionControl();

    expect(c.killSwitch).toBe(true);
    expect(c.reason).toBe('kill_switch_active');
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: false, reason: 'kill_switch' });
  });

  it('fails closed on a malformed kill_switch value', async () => {
    useFirestore(defaultDocs({ 'settings/default': settingsDoc({ trading: { kill_switch: 'no' } }) }));
    const c = await mod.getExecutionControl();

    expect(c.killSwitch).toBe(true);
    expect(c.reason).toBe('kill_switch_malformed:string');
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: false, reason: 'kill_switch' });
  });

  it('keeps the kill switch off when trading.kill_switch is absent', async () => {
    useFirestore(defaultDocs({ 'settings/default': settingsDoc({ trading: undefined }) }));
    const c = await mod.getExecutionControl();

    expect(c.killSwitch).toBe(false);
  });
});

describe('getExecutionControl: safety limits', () => {
  it('uses DEFAULT_SAFETY_LIMITS (as a copy) when settings.safety is absent', async () => {
    useFirestore(defaultDocs({ 'settings/default': settingsDoc({ safety: undefined }) }));
    const c = await mod.getExecutionControl();

    expect(c.safety).toEqual(DEFAULT_SAFETY_LIMITS);
    expect(c.safety).not.toBe(DEFAULT_SAFETY_LIMITS);
    expect(c.safetyErrors).toEqual([]);
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: true });
  });

  it('blocks entries with safety null and errors when settings.safety is invalid', async () => {
    useFirestore(defaultDocs({ 'settings/default': settingsDoc({ safety: {} }) }));
    const c = await mod.getExecutionControl();

    expect(c.safety).toBeNull();
    expect(c.safetyErrors.length).toBeGreaterThan(0);
    for (const error of c.safetyErrors) expect(error).toMatch(/: /);
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: false, reason: 'invalid_safety' });
  });
});

describe('getExecutionControl: active profile', () => {
  it('reports no active profile when active_profile_doc_id is unset', async () => {
    useFirestore(defaultDocs({ 'settings/default': settingsDoc({ execution: { mode: 'paper' } }) }));
    const c = await mod.getExecutionControl();

    expect(c.activeProfileDocId).toBeNull();
    expect(c.activeProfile).toBeNull();
    expect(c.profileErrors).toEqual([]);
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: false, reason: 'no_active_profile' });
  });

  it('reports active_profile_not_found when the profile doc is missing', async () => {
    useFirestore(defaultDocs({ [`execution_profiles/${PROFILE_ID}`]: undefined as unknown as Record<string, unknown> }));
    const c = await mod.getExecutionControl();

    expect(c.activeProfileDocId).toBe(PROFILE_ID);
    expect(c.activeProfile).toBeNull();
    expect(c.profileErrors).toEqual(['active_profile_not_found']);
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: false, reason: 'invalid_profile' });
  });

  it('rejects a draft profile by status', async () => {
    useFirestore(defaultDocs({ [`execution_profiles/${PROFILE_ID}`]: profileDoc('draft') }));
    const c = await mod.getExecutionControl();

    expect(c.activeProfile).toBeNull();
    expect(c.profileErrors).toEqual(['profile_status_draft']);
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: false, reason: 'invalid_profile' });
  });

  it('reports a missing status as profile_status_missing', async () => {
    const noStatus: Record<string, unknown> = { ...profileDoc('active') };
    delete noStatus.status;
    useFirestore(defaultDocs({ [`execution_profiles/${PROFILE_ID}`]: noStatus }));
    const c = await mod.getExecutionControl();

    expect(c.profileErrors).toEqual(['profile_status_missing']);
  });

  it('loads an approved profile, stripping envelope metadata before validation', async () => {
    useFirestore(defaultDocs());
    const c = await mod.getExecutionControl();

    expect(c.profileErrors).toEqual([]);
    expect(c.activeProfile).not.toBeNull();
    expect(c.activeProfile?.profile_id).toBe('gold-optimal-1');
    expect(c.activeProfile).not.toHaveProperty('status');
    expect(c.activeProfile).not.toHaveProperty('validation');
    expect(c.activeProfile).not.toHaveProperty('approved_by');
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: true });
  });

  it('loads a profile stored with every envelope field the web routes write (regression: demo run 2026-10-23)', async () => {
    const stored = {
      ...profileDoc('active'),
      doc_id: PROFILE_ID,
      created_by_uid: 'u1',
      updated_by: 'ops@example.com',
      updated_by_uid: 'u1',
      approved_by_uid: 'u1',
      activated_by_uid: 'u1',
      superseded_at: null,
    };
    useFirestore(defaultDocs({ [`execution_profiles/${PROFILE_ID}`]: stored }));
    const c = await mod.getExecutionControl();

    expect(c.profileErrors).toEqual([]);
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: true });
  });

  it('loads an active profile', async () => {
    useFirestore(defaultDocs({ [`execution_profiles/${PROFILE_ID}`]: profileDoc('active') }));
    const c = await mod.getExecutionControl();

    expect(c.activeProfile?.version).toBe(1);
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: true });
  });

  it('refuses a valid profile that exceeds the current safety limits', async () => {
    const tighter: SafetyLimits = { ...DEFAULT_SAFETY_LIMITS, max_lots_per_trade: 0.01 };
    useFirestore(defaultDocs({ 'settings/default': settingsDoc({ safety: tighter }) }));
    const c = await mod.getExecutionControl();

    expect(c.activeProfile).toBeNull();
    expect(c.profileErrors.some((e) => e.startsWith('sizing.fixed_lots: '))).toBe(true);
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: false, reason: 'invalid_profile' });
  });

  it('refuses a profile whose symbol is not in allowed_signal_symbols', async () => {
    const otherSymbols: SafetyLimits = { ...DEFAULT_SAFETY_LIMITS, allowed_signal_symbols: ['EURUSD'] };
    useFirestore(defaultDocs({ 'settings/default': settingsDoc({ safety: otherSymbols }) }));
    const c = await mod.getExecutionControl();

    expect(c.activeProfile).toBeNull();
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: false, reason: 'invalid_profile' });
  });

  it('nulls an invalid profile and reports errors as path: message', async () => {
    const broken = { ...PROFILE_BODY, entry: undefined };
    useFirestore(defaultDocs({ [`execution_profiles/${PROFILE_ID}`]: profileDoc('active', broken) }));
    const c = await mod.getExecutionControl();

    expect(c.activeProfile).toBeNull();
    expect(c.profileErrors.length).toBeGreaterThan(0);
    for (const error of c.profileErrors) expect(error).toMatch(/: /);
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: false, reason: 'invalid_profile' });
  });
});

describe('getExecutionControl: TTL cache', () => {
  it('serves the cached value within 5 seconds and reloads afterwards', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T10:00:00.000Z'));
    const fake = useFirestore(defaultDocs());

    const first = await mod.getExecutionControl();
    vi.setSystemTime(new Date('2026-10-18T10:00:04.999Z'));
    const second = await mod.getExecutionControl();
    expect(second).toBe(first);
    expect(fake.reads.filter((p) => p === 'settings/default')).toHaveLength(1);

    vi.setSystemTime(new Date('2026-10-18T10:00:05.000Z'));
    const third = await mod.getExecutionControl();
    expect(third).not.toBe(first);
    expect(fake.reads.filter((p) => p === 'settings/default')).toHaveLength(2);
    expect(third.loadedAt).toBe(Date.parse('2026-10-18T10:00:05.000Z'));
  });

  it('invalidateExecutionControl forces the next call to reload', async () => {
    const fake = useFirestore(defaultDocs());
    await mod.getExecutionControl();
    mod.invalidateExecutionControl();
    await mod.getExecutionControl();

    expect(fake.reads.filter((p) => p === 'settings/default')).toHaveLength(2);
  });

  it('getExecutionControlSync is null before any load and returns the last value after', async () => {
    expect(mod.getExecutionControlSync()).toBeNull();
    useFirestore(defaultDocs());
    const c = await mod.getExecutionControl();

    expect(mod.getExecutionControlSync()).toBe(c);
    mod.invalidateExecutionControl();
    expect(mod.getExecutionControlSync()).toBeNull();
  });
});

describe('live trading gate', () => {
  it('blocks live mode without BYTRADER_LIVE_TRADING=enabled', async () => {
    useFirestore(defaultDocs({ 'settings/default': settingsDoc({ execution: { mode: 'live', active_profile_doc_id: PROFILE_ID } }) }));
    const c = await mod.getExecutionControl();

    expect(c.mode).toBe('live');
    expect(c.liveTradingEnvEnabled).toBe(false);
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: false, reason: 'live_not_enabled' });
  });

  it('allows live mode when the env flag is enabled', async () => {
    vi.stubEnv('BYTRADER_LIVE_TRADING', 'enabled');
    useFirestore(defaultDocs({ 'settings/default': settingsDoc({ execution: { mode: 'live', active_profile_doc_id: PROFILE_ID } }) }));
    const c = await mod.getExecutionControl();

    expect(c.liveTradingEnvEnabled).toBe(true);
    expect(mod.canOpenNewEntries(c)).toEqual({ allowed: true });
  });
});

describe('canOpenNewEntries', () => {
  const base = (): ExecutionControl => ({
    mode: 'demo',
    killSwitch: false,
    activeProfileDocId: PROFILE_ID,
    activeProfile: { profile_id: 'gold-optimal-1' } as unknown as ExecutionProfile,
    profileErrors: [],
    safety: { max_lots_per_trade: 0.1 } as unknown as SafetyLimits,
    safetyErrors: [],
    liveTradingEnvEnabled: false,
    source: 'firestore',
    loadedAt: 0,
  });

  it('allows entries when every gate passes', () => {
    expect(mod.canOpenNewEntries(base())).toEqual({ allowed: true });
  });

  it('returns each reason in documented order', () => {
    expect(mod.canOpenNewEntries({ ...base(), source: 'fail_closed', mode: 'disabled', killSwitch: true })).toEqual({
      allowed: false,
      reason: 'config_unavailable',
    });
    expect(mod.canOpenNewEntries({ ...base(), mode: 'disabled', killSwitch: true })).toEqual({
      allowed: false,
      reason: 'execution_disabled',
    });
    expect(mod.canOpenNewEntries({ ...base(), killSwitch: true, mode: 'live' })).toEqual({
      allowed: false,
      reason: 'kill_switch',
    });
    expect(mod.canOpenNewEntries({ ...base(), mode: 'live' })).toEqual({ allowed: false, reason: 'live_not_enabled' });
    expect(mod.canOpenNewEntries({ ...base(), mode: 'live', liveTradingEnvEnabled: true })).toEqual({ allowed: true });
    expect(mod.canOpenNewEntries({ ...base(), safety: null })).toEqual({ allowed: false, reason: 'invalid_safety' });
    expect(mod.canOpenNewEntries({ ...base(), activeProfileDocId: null, activeProfile: null })).toEqual({
      allowed: false,
      reason: 'no_active_profile',
    });
    expect(mod.canOpenNewEntries({ ...base(), activeProfile: null })).toEqual({
      allowed: false,
      reason: 'invalid_profile',
    });
  });
});
