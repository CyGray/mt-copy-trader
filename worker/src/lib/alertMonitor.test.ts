import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionControl } from './executionControl.js';

const h = vi.hoisted(() => ({
  fs: null as unknown,
  ping: null as unknown,
  control: null as unknown,
  account: { ok: true, account: { tradeMode: 'DEMO' } } as unknown,
  brokerCalls: [] as string[],
}));

vi.mock('./firestoreAdmin', () => ({ initFirestore: () => h.fs }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./bridgeHealth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bridgeHealth.js')>();
  return { ...actual, pingBridge: vi.fn(async () => h.ping) };
});
vi.mock('./executionControl', () => ({
  getExecutionControl: vi.fn(async () => h.control),
  canOpenNewEntries: vi.fn(() => ({ allowed: true })),
}));
vi.mock('./brokerRouter', () => ({
  getBroker: vi.fn(async (mode: string) => {
    h.brokerCalls.push(`getBroker:${mode}`);
    return {
      getAccountInfo: vi.fn(async () => {
        h.brokerCalls.push('getAccountInfo');
        return { tradeMode: 'DEMO' };
      }),
    };
  }),
  verifyAccountForMode: vi.fn(async () => h.account),
}));
vi.mock('./signalFeed', () => ({ getSignalFeedStats: vi.fn(() => null) }));

import { _resetAlertsForTests } from './alerts.js';
import { _resetAlertMonitorForTests, runAlertMonitor } from './alertMonitor.js';
import { createFakeFirestore, type FakeFirestore } from './testing/fakeFirestore.js';

const T0 = Date.parse('2026-10-18T10:00:00.000Z');

function fs(): FakeFirestore {
  return h.fs as FakeFirestore;
}

function alert(id: string): Record<string, unknown> | undefined {
  return fs().peek(`alerts/${id}`);
}

function control(over: Partial<ExecutionControl> = {}): ExecutionControl {
  return {
    mode: 'demo',
    killSwitch: false,
    activeProfileDocId: 'p__v1',
    activeProfile: {} as ExecutionControl['activeProfile'],
    profileErrors: [],
    safety: {} as ExecutionControl['safety'],
    safetyErrors: [],
    liveTradingEnvEnabled: false,
    source: 'firestore',
    loadedAt: 0,
    ...over,
  };
}

const healthyPing = { reachable: true, eaVersion: '2.0.0', terminalConnected: true, tradeAllowed: true, latencyMs: 3, serverOffsetSec: 7200 };
const downPing = { reachable: false, eaVersion: null, terminalConnected: null, tradeAllowed: null, latencyMs: 5000, serverOffsetSec: null };

describe('alert monitor', () => {
  beforeEach(() => {
    h.fs = createFakeFirestore();
    h.ping = healthyPing;
    h.control = control();
    h.account = { ok: true, account: { tradeMode: 'DEMO' } };
    h.brokerCalls = [];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    _resetAlertsForTests(async () => ({ ok: true, status: 200 }));
    _resetAlertMonitorForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a healthy pass raises nothing and reports the account mode', async () => {
    const snap = await runAlertMonitor();
    expect(snap.issues).toEqual([]);
    expect(snap.accountMode).toBe('DEMO');
    expect(fs().docs('alerts')).toEqual([]);
  });

  it('raises bridge_disconnected (critical in demo) after two failed pings and resolves it on recovery', async () => {
    h.ping = downPing;
    await runAlertMonitor();
    expect(alert('bridge_disconnected')).toBeUndefined();
    await runAlertMonitor();
    expect(alert('bridge_disconnected')).toMatchObject({ severity: 'critical', status: 'open' });

    h.ping = healthyPing;
    await runAlertMonitor();
    expect(alert('bridge_disconnected')).toMatchObject({ status: 'resolved' });
  });

  it('a bridge outage in disabled mode is only a warning', async () => {
    h.control = control({ mode: 'disabled', reason: undefined });
    h.ping = downPing;
    await runAlertMonitor();
    await runAlertMonitor();
    expect(alert('bridge_disconnected')).toMatchObject({ severity: 'warning' });
  });

  it('raises ea_version_mismatch for the v1 EA', async () => {
    h.ping = { ...healthyPing, eaVersion: '1.2.0' };
    await runAlertMonitor();
    expect(alert('ea_version_mismatch')).toMatchObject({ severity: 'critical', status: 'open' });
  });

  it('raises terminal alerts for a disconnected terminal and disabled AutoTrading', async () => {
    h.ping = { ...healthyPing, terminalConnected: false, tradeAllowed: false };
    await runAlertMonitor();
    expect(alert('terminal_disconnected__connection')).toMatchObject({ severity: 'critical' });
    expect(alert('terminal_disconnected__trade_allowed')).toMatchObject({ severity: 'error' });
  });

  it('raises config_invalid when a trading mode has an invalid profile and resolves it once valid', async () => {
    h.control = control({ activeProfile: null, profileErrors: ['sizing.fixed_lots: 5 exceeds limit 1'] });
    await runAlertMonitor();
    expect(alert('config_invalid__execution')).toMatchObject({ severity: 'critical', status: 'open' });
    expect(String(alert('config_invalid__execution')?.message)).toContain('fixed_lots');

    h.control = control();
    await runAlertMonitor();
    expect(alert('config_invalid__execution')).toMatchObject({ status: 'resolved' });
  });

  it('flags live mode without the environment flag', async () => {
    h.control = control({ mode: 'live', liveTradingEnvEnabled: false });
    h.account = { ok: false, reason: 'live_env_not_enabled' };
    await runAlertMonitor();
    expect(String(alert('config_invalid__execution')?.message)).toContain('BYTRADER_LIVE_TRADING');
    expect(alert('config_invalid__account_mode')).toMatchObject({ severity: 'critical' });
  });

  it('flags a demo mode connected to a REAL account', async () => {
    h.account = { ok: false, reason: 'account_not_demo' };
    const snap = await runAlertMonitor();
    expect(snap.issues).toContain('account_account_not_demo');
    expect(alert('config_invalid__account_mode')).toMatchObject({ severity: 'critical', status: 'open' });
    expect(String(alert('config_invalid__account_mode')?.message)).toContain('account_not_demo');
  });

  it('a missing execution mode is a warning, and a Firestore fail-closed is left to the heartbeat', async () => {
    h.control = control({ mode: 'disabled', reason: 'mode_missing' });
    await runAlertMonitor();
    expect(alert('config_invalid__execution')).toMatchObject({ severity: 'warning' });

    _resetAlertsForTests(async () => ({ ok: true, status: 200 }));
    h.fs = createFakeFirestore();
    h.control = control({ mode: 'disabled', source: 'fail_closed', reason: 'firestore_unavailable', killSwitch: true });
    await runAlertMonitor();
    expect(alert('config_invalid__execution')).toBeUndefined();
  });

  it('reports the account mode read-only outside demo/live, and skips the broker while the bridge is down', async () => {
    h.control = control({ mode: 'disabled' });
    const snap = await runAlertMonitor();
    expect(snap.accountMode).toBe('DEMO');
    expect(h.brokerCalls).toEqual(['getBroker:demo', 'getAccountInfo']);
    expect(fs().docs('alerts')).toEqual([]);

    h.brokerCalls = [];
    h.control = control();
    h.ping = downPing;
    await runAlertMonitor();
    expect(h.brokerCalls).toEqual([]);
  });
});
