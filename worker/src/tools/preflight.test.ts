import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkAutotraderHealth,
  checkBuild,
  checkControl,
  checkEnv,
  checkForwarderHealth,
  checkNodeVersion,
  checkUnit,
  envFacts,
  envKeys,
  parseArgs,
  runPreflight,
  summarize,
  type CheckResult,
} from './preflight.js';

const status = (results: CheckResult[], name: string) => results.find((r) => r.name === name)?.status;

const HEALTHY_V2 = {
  ok: true,
  service: 'autotrader',
  protocolVersion: 2,
  firestore: true,
  bridge: { reachable: true, eaVersion: '2.0.0', eaCompatible: true, terminalConnected: true, tradeAllowed: true, gmtSkewSec: 1 },
  account: { tradeMode: 'DEMO' },
  execution: { mode: 'disabled', killSwitch: true, entriesAllowed: false },
  loops: { signalFeed: true, lifecycle: true, reconciler: true, adminCommands: true, alertMonitor: true },
  signalQueue: { orderedQuery: true },
  issues: [],
};

describe('preflight: environment', () => {
  const env = [
    '# comment',
    'FIREBASE_PROJECT_ID=demo',
    'FIREBASE_CLIENT_EMAIL="x@y"',
    "FIREBASE_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----'",
    'WORKER_API_TOKEN=abc',
    'MT5_ZMQ_ENDPOINT=tcp://127.0.0.1:5555',
  ].join('\n');

  it('reads key names and emptiness, never values', () => {
    const keys = envKeys(`${env}\nEMPTY=\n`);
    expect([...keys.keys()]).toContain('FIREBASE_PRIVATE_KEY');
    expect(keys.get('EMPTY')).toBe(false);
    const results = checkEnv(envFacts(env));
    expect(JSON.stringify(results)).not.toContain('secret');
    expect(JSON.stringify(results)).not.toContain('abc');
    expect(results.every((r) => r.status === 'pass')).toBe(true);
  });

  it('fails when live trading is enabled, the bridge is not loopback, or a bind address is overridden', () => {
    const bad = checkEnv(envFacts(`${env}\nBYTRADER_LIVE_TRADING=enabled\nMT5_ZMQ_ENDPOINT=tcp://0.0.0.0:5555\nWORKER_HOST=0.0.0.0`));
    expect(status(bad, 'env_live_trading')).toBe('fail');
    expect(status(bad, 'env_zmq_endpoint')).toBe('fail');
    expect(status(bad, 'env_host_override')).toBe('fail');
    expect(status(checkEnv(envFacts(`${env}\nWORKER_HOST=127.0.0.1\nAUTOTRADER_HOST=127.0.0.1`)), 'env_host_override')).toBe('pass');
  });

  it('fails on missing Firebase keys and warns without WORKER_API_TOKEN', () => {
    const r = checkEnv(envFacts('FIREBASE_PROJECT_ID=demo\nFIREBASE_PRIVATE_KEY='));
    expect(status(r, 'env_required')).toBe('fail');
    expect(r.find((x) => x.name === 'env_required')?.detail).toContain('FIREBASE_CLIENT_EMAIL');
    expect(status(r, 'env_recommended')).toBe('warn');
  });
});

describe('preflight: build, units, control', () => {
  it('accepts a complete v2 build and rejects a v1 one', () => {
    const files = new Set(['autotrader.js', 'index.js', 'lib/mt5Client.js', 'lib/signalFeed.js', 'lib/alerts.js', 'tools/preflight.js']);
    expect(checkBuild({ exists: true, files, mt5ClientSource: 'exports.PROTOCOL_VERSION = 2;' }).every((r) => r.status === 'pass')).toBe(true);
    const v1 = checkBuild({ exists: true, files: new Set(['autotrader.js', 'index.js', 'lib/mt5Client.js', 'lib/tradeEngine.js']), mt5ClientSource: 'const v = 1' });
    expect(status(v1, 'build_files')).toBe('fail');
    expect(status(v1, 'build_protocol')).toBe('fail');
    expect(status(v1, 'build_no_bybit')).toBe('warn');
    expect(checkBuild({ exists: false, files: new Set(), mt5ClientSource: null })[0].status).toBe('fail');
  });

  it('checks the installed units run worker/dist from the repo on loopback', () => {
    const unit = 'ExecStart=/home/u/.nvm/node /repo/worker/dist/autotrader.js\nEnvironment=AUTOTRADER_PORT=4001\n';
    expect(checkUnit('autotrader', unit, '/repo').map((r) => r.status)).toEqual(['pass']);
    expect(checkUnit('autotrader', 'ExecStart=/usr/bin/node /elsewhere/x.js', '/repo')[0].status).toBe('fail');
    expect(checkUnit('forwarder', 'ExecStart=/n /repo/worker/dist/index.js\nEnvironment=WORKER_HOST=0.0.0.0', '/repo').map((r) => r.status)).toEqual(['pass', 'fail']);
    expect(checkUnit('forwarder', null, '/repo')[0].status).toBe('fail');
  });

  it('requires execution disabled and the kill switch engaged before deploying', () => {
    expect(checkControl({ execution: { mode: 'disabled' }, trading: { kill_switch: true } }, 'pre').every((r) => r.status === 'pass')).toBe(true);
    expect(status(checkControl({ execution: { mode: 'demo' }, trading: { kill_switch: true } }, 'pre'), 'control_mode')).toBe('fail');
    expect(status(checkControl({ execution: { mode: 'disabled' } }, 'pre'), 'control_kill_switch')).toBe('fail');
    expect(status(checkControl({ execution: { mode: 'disabled' } }, 'post'), 'control_kill_switch')).toBe('warn');
  });

  it('checks the node version', () => {
    expect(checkNodeVersion('v24.20.0').status).toBe('pass');
    expect(checkNodeVersion('v18.19.0').status).toBe('fail');
  });
});

describe('preflight: health after the swap', () => {
  it('passes a healthy v2 deployment on a DEMO account with execution disabled', () => {
    const r = checkAutotraderHealth(HEALTHY_V2, { stage: 'post', expectAccount: 'DEMO' });
    expect(r.filter((x) => x.status !== 'pass')).toEqual([]);
  });

  it('fails a REAL account when DEMO is expected, so a live account cannot be mistaken for demo', () => {
    const r = checkAutotraderHealth({ ...HEALTHY_V2, account: { tradeMode: 'REAL' } }, { stage: 'post', expectAccount: 'DEMO' });
    expect(status(r, 'account_mode')).toBe('fail');
  });

  it('fails a v1 EA, a stopped loop, enabled execution, a large clock skew and an unreachable bridge', () => {
    const r = checkAutotraderHealth(
      {
        ...HEALTHY_V2,
        bridge: { reachable: false, eaVersion: '1.2.0', eaCompatible: false, terminalConnected: false, gmtSkewSec: 30 },
        execution: { mode: 'demo', entriesAllowed: true },
        loops: { ...HEALTHY_V2.loops, reconciler: false },
        issues: ['bridge_unreachable'],
      },
      { stage: 'post' },
    );
    for (const name of ['bridge_reachable', 'bridge_protocol', 'terminal_connected', 'clock_skew', 'execution_disabled', 'loops_running', 'monitor_issues']) {
      expect(status(r, name), name).toBe('fail');
    }
  });

  it('reports a v1 AutoTrader before the rollout as expected, and no response as a failure', () => {
    expect(status(checkAutotraderHealth({ ok: true, service: 'autotrader' }, { stage: 'pre' }), 'autotrader_version')).toBe('pass');
    expect(checkAutotraderHealth(null, { stage: 'post' })[0].status).toBe('fail');
  });

  it('checks the forwarder session, listener and outbox', () => {
    expect(checkForwarderHealth({ telegram: 'authorized', listenerStarted: true, signalOutbox: 0 }, { stage: 'post' }).every((r) => r.status === 'pass')).toBe(true);
    const r = checkForwarderHealth({ telegram: 'disconnected', listenerStarted: false, signalOutbox: 3 }, { stage: 'post' });
    expect(r.map((x) => x.status)).toEqual(['fail', 'fail', 'warn']);
  });

  it('summarizes with a failing exit when any check fails', () => {
    const s = summarize([{ name: 'a', status: 'pass', detail: 'x' }, { name: 'b', status: 'fail', detail: 'y' }]);
    expect(s.ok).toBe(false);
    expect(s.text).toContain('1 failed');
  });
});

describe('preflight: end to end on a sandbox tree (read-only)', () => {
  it('runs the pre stage against files only and changes nothing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bytrader-preflight-'));
    const build = path.join(root, 'stage');
    fs.mkdirSync(path.join(build, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(build, 'tools'), { recursive: true });
    for (const f of ['autotrader.js', 'index.js', 'lib/signalFeed.js', 'lib/alerts.js', 'tools/preflight.js']) fs.writeFileSync(path.join(build, f), '');
    fs.writeFileSync(path.join(build, 'lib/mt5Client.js'), 'exports.PROTOCOL_VERSION = 2;');
    fs.writeFileSync(path.join(root, '.env.local'), 'FIREBASE_PROJECT_ID=p\nFIREBASE_CLIENT_EMAIL=e\nFIREBASE_PRIVATE_KEY=k\n');
    const units = path.join(root, 'units');
    fs.mkdirSync(units);
    fs.writeFileSync(path.join(units, 'bytrader-autotrader.service'), `ExecStart=/node ${root}/worker/dist/autotrader.js\n`);
    fs.writeFileSync(path.join(units, 'bytrader-worker.service'), `ExecStart=/node ${root}/worker/dist/index.js\n`);
    const before = JSON.stringify(fs.readdirSync(root, { recursive: true }));

    const opts = parseArgs(['--stage', 'pre', '--repo', root, '--build', build, '--units', units]);
    expect(typeof opts).toBe('object');
    const results = await runPreflight(opts as Exclude<typeof opts, string>);
    expect(results.filter((r) => r.status === 'fail')).toEqual([]);
    expect(JSON.stringify(fs.readdirSync(root, { recursive: true }))).toBe(before);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects bad arguments', () => {
    expect(parseArgs([])).toMatch(/--stage/);
    expect(parseArgs(['--stage', 'pre', '--expect-account', 'LIVE'])).toMatch(/expect-account/);
  });
});
