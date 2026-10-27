import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SRC = __dirname;
const FORBIDDEN_MODULES = [
  'telegramClient',
  'telegramListener',
  'telegramSession',
  'signalForwarding',
  'tradeEngine',
  'bybitClient',
  'bybitSecrets',
];
const MAGIC = 98801;
const CHAT_ID = '-1003271337051';
const TOKEN = 'test-token';

vi.mock('./lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./lib/systemLog', () => ({ writeSystemLog: vi.fn(async () => true) }));
vi.mock('./lib/firestoreAdmin', () => ({ initFirestore: vi.fn(() => ({})) }));
vi.mock('./lib/executionControl', () => ({
  getExecutionControl: vi.fn(async () => ({
    mode: 'demo',
    killSwitch: false,
    activeProfileDocId: 'xau-test__v1',
    activeProfile: null,
    profileErrors: [],
    safety: null,
    safetyErrors: [],
    liveTradingEnvEnabled: false,
    source: 'firestore',
    loadedAt: 0,
  })),
  canOpenNewEntries: vi.fn(() => ({ allowed: true })),
}));
vi.mock('./lib/mt5Client', () => ({
  mt5Request: vi.fn(async () => ({
    server_time: 1000,
    gmt_time: 1000,
    ea_version: '2.0.0',
    terminal_connected: true,
    terminal_trade_allowed: true,
  })),
  refreshServerTimeOffset: vi.fn(async () => 0),
  getCachedServerTimeOffsetSec: vi.fn(() => 0),
  getCachedGmtSkewSec: vi.fn(() => 0),
}));
vi.mock('./lib/mt5Secrets', () => ({
  getMt5Config: vi.fn(async () => ({
    symbolBase: 'XAUUSD',
    symbolSuffix: '',
    symbol: 'XAUUSD',
    magic: MAGIC,
    deviation: 20,
    volume: 0.05,
    sourceChatIds: [CHAT_ID],
  })),
}));
vi.mock('./lib/lifecycleManager', () => ({
  isLifecycleManagerRunning: vi.fn(() => true),
  startLifecycleManager: vi.fn(),
  stopLifecycleManager: vi.fn(),
}));
vi.mock('./lib/reconciler', () => ({
  isReconcilerRunning: vi.fn(() => false),
  runReconciliation: vi.fn(async () => ({})),
  startReconciler: vi.fn(),
  stopReconciler: vi.fn(),
}));
vi.mock('./lib/adminCommands', () => ({
  isAdminCommandPollerRunning: vi.fn(() => true),
  startAdminCommandPoller: vi.fn(),
  stopAdminCommandPoller: vi.fn(),
}));
vi.mock('./lib/signalFeed', () => ({
  isSignalFeedRunning: vi.fn(() => true),
  startSignalFeed: vi.fn(),
  stopSignalFeed: vi.fn(),
  getSignalFeedStats: vi.fn(() => ({
    running: true,
    workerId: 'w',
    cursor: null,
    activeCount: 2,
    oldestActiveCreatedAt: '2026-10-18T10:00:00.000Z',
    deadLetterCount: 1,
    lastTickAt: null,
    lastError: null,
    orderedQuery: true,
  })),
}));
vi.mock('./lib/alertMonitor', () => ({
  getLastMonitorSnapshot: vi.fn(() => ({ checkedAt: null, bridge: null, accountMode: 'DEMO', issues: [] })),
  isAlertMonitorRunning: vi.fn(() => true),
  startAlertMonitor: vi.fn(),
  stopAlertMonitor: vi.fn(),
}));

import { createAutotraderApp } from './autotrader.js';

/** Relative import specifiers in a source file. */
function importsOf(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]);
}

function resolveImport(from: string, spec: string): string {
  return path.resolve(path.dirname(from), spec.replace(/\.js$/, '')) + '.ts';
}

/** Every file reachable from `entry` through relative imports under src. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      const target = resolveImport(file, spec);
      if (target.startsWith(SRC) && fs.existsSync(target)) queue.push(target);
    }
  }
  return seen;
}

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = createAutotraderApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('autotrader entry point', () => {
  const originalToken = process.env.WORKER_API_TOKEN;

  beforeEach(() => {
    process.env.WORKER_API_TOKEN = TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.WORKER_API_TOKEN;
    else process.env.WORKER_API_TOKEN = originalToken;
  });

  describe('static guard', () => {
    it('does not import Telegram or legacy Bybit modules, directly or transitively', () => {
      const files = reachableFrom(path.join(SRC, 'autotrader.ts'));
      expect([...files].some((f) => f.endsWith(`${path.sep}lifecycleManager.ts`))).toBe(true);
      expect([...files].some((f) => f.endsWith(`${path.sep}reconciler.ts`))).toBe(true);

      for (const file of files) {
        for (const spec of importsOf(file)) {
          const name = path.basename(spec.replace(/\.js$/, ''));
          expect(FORBIDDEN_MODULES, `${file} imports ${spec}`).not.toContain(name);
        }
      }
    });
  });

  describe('GET /health', () => {
    it('is public and reports the service shape without secrets', async () => {
      const body = await withServer(async (base) => {
        const res = await fetch(`${base}/health`);
        expect(res.status).toBe(200);
        return res.text();
      });

      const json = JSON.parse(body) as Record<string, unknown>;
      expect(json).toEqual({
        ok: true,
        service: 'autotrader',
        protocolVersion: 2,
        firestore: true,
        bridge: {
          reachable: true,
          eaVersion: '2.0.0',
          eaCompatible: true,
          terminalConnected: true,
          tradeAllowed: true,
          latencyMs: expect.any(Number),
          serverOffsetSec: 0,
          gmtSkewSec: 0,
        },
        account: { tradeMode: 'DEMO', checkedAt: null },
        execution: {
          mode: 'demo',
          killSwitch: false,
          activeProfileDocId: 'xau-test__v1',
          entriesAllowed: true,
          reason: null,
        },
        loops: { signalFeed: true, lifecycle: true, reconciler: false, adminCommands: true, alertMonitor: true },
        signalQueue: {
          active: 2,
          oldestActiveCreatedAt: '2026-10-18T10:00:00.000Z',
          deadLetters: 1,
          orderedQuery: true,
          lastTickAt: null,
          lastError: null,
        },
        issues: [],
        notifications: { enabled: false, minSeverity: 'error', channels: [] },
      });
      expect(body).not.toContain(String(MAGIC));
      expect(body).not.toContain(CHAT_ID);
    });

    it('reuses a fresh monitor PING instead of queueing a new one (fast during a bridge outage)', async () => {
      const { getLastMonitorSnapshot } = await import('./lib/alertMonitor.js');
      const { mt5Request } = await import('./lib/mt5Client.js');
      vi.mocked(mt5Request).mockClear();
      vi.mocked(getLastMonitorSnapshot).mockReturnValueOnce({
        checkedAt: new Date().toISOString(),
        bridge: { reachable: false, eaVersion: null, terminalConnected: null, tradeAllowed: null, latencyMs: 10000, serverOffsetSec: null, gmtSkewSec: null },
        accountMode: null,
        issues: ['bridge_unreachable'],
      });
      const json = await withServer(async (base) => (await fetch(`${base}/health`)).json() as Promise<Record<string, unknown>>);
      expect(json.ok).toBe(false);
      expect(json.bridge).toMatchObject({ reachable: false });
      expect(mt5Request).not.toHaveBeenCalled();
    });

    it('is not ok when the EA does not speak protocol v2 (deployment mismatch)', async () => {
      const { mt5Request } = await import('./lib/mt5Client.js');
      vi.mocked(mt5Request).mockResolvedValueOnce({ ea_version: '1.3.0', terminal_connected: true });
      const json = await withServer(async (base) => (await fetch(`${base}/health`)).json() as Promise<Record<string, unknown>>);
      expect(json.ok).toBe(false);
      expect(json.bridge).toMatchObject({ eaVersion: '1.3.0', eaCompatible: false });
    });
  });

  describe('GET /mt5/config', () => {
    it('refuses a request without the bearer token', async () => {
      const status = await withServer(async (base) => (await fetch(`${base}/mt5/config`)).status);
      expect(status).toBe(401);
    });

    it('refuses a request with the wrong token', async () => {
      const status = await withServer(
        async (base) => (await fetch(`${base}/mt5/config`, { headers: { Authorization: 'Bearer nope' } })).status,
      );
      expect(status).toBe(401);
    });

    it('returns only the symbol, deviation and a magic flag to a caller with the token', async () => {
      const body = await withServer(async (base) => {
        const res = await fetch(`${base}/mt5/config`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        expect(res.status).toBe(200);
        return res.text();
      });

      expect(JSON.parse(body)).toEqual({ symbol: 'XAUUSD', deviation: 20, magicConfigured: true });
      expect(body).not.toContain(String(MAGIC));
      expect(body).not.toContain(CHAT_ID);
    });
  });

  describe('GET /mt5/health', () => {
    it('refuses a request without the bearer token', async () => {
      const status = await withServer(async (base) => (await fetch(`${base}/mt5/health`)).status);
      expect(status).toBe(401);
    });

    it('returns the bridge ping details to a caller with the token', async () => {
      const json = await withServer(async (base) => {
        const res = await fetch(`${base}/mt5/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        return (await res.json()) as Record<string, unknown>;
      });

      expect(json).toMatchObject({ reachable: true, eaVersion: '2.0.0', terminalConnected: true, tradeAllowed: true });
    });
  });
});
