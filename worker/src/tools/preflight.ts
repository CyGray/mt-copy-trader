/**
 * preflight.ts — read-only deployment checks for the protocol-v2 rollout.
 *
 * Usage (from the repo root; the build ships this file as tools/preflight.js):
 *   node <build>/tools/preflight.js --stage pre  [--build <dir>] [--env-file <path>] [--units <dir>] [--live] [--firestore]
 *   node <build>/tools/preflight.js --stage post [--expect-account DEMO] [--firestore]
 *
 * It never writes, never sends a broker request and never prints a secret:
 *  - env checks report key names only, never values;
 *  - --live issues HTTP GET /health to the two services on 127.0.0.1;
 *  - --firestore reads settings/default (requires the service account in the env).
 * Exit code 0 when every check passed, 1 when any check failed, 2 on usage errors.
 *
 * Every check is a pure function below so it can be tested without a host.
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { initFirestore } from '../lib/firestoreAdmin';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

function pass(name: string, detail: string): CheckResult {
  return { name, status: 'pass', detail };
}
function warn(name: string, detail: string): CheckResult {
  return { name, status: 'warn', detail };
}
function fail(name: string, detail: string): CheckResult {
  return { name, status: 'fail', detail };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Pure checks
// ---------------------------------------------------------------------------

export function checkNodeVersion(version: string): CheckResult {
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  return major >= 20 ? pass('node_version', `node ${version}`) : fail('node_version', `node ${version}; need >= 20`);
}

/** Key names from a dotenv file. Values are never returned. */
export function envKeys(text: string): Map<string, boolean> {
  const keys = new Map<string, boolean>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^['"]|['"]$/g, '');
    keys.set(m[1], value.length > 0);
  }
  return keys;
}

/** Flags-only view of selected values that must be checked by content (never echoed). */
export interface EnvFacts {
  keys: Map<string, boolean>;
  liveTradingEnabled: boolean;
  zmqEndpointLoopback: boolean | null;
  hostOverrides: string[];
}

export function envFacts(text: string): EnvFacts {
  const keys = envKeys(text);
  let liveTradingEnabled = false;
  let zmqEndpointLoopback: boolean | null = null;
  const hostOverrides: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw.trim());
    if (!m) continue;
    const value = m[2].trim().replace(/^['"]|['"]$/g, '');
    if (m[1] === 'BYTRADER_LIVE_TRADING') liveTradingEnabled = value === 'enabled';
    if (m[1] === 'MT5_ZMQ_ENDPOINT') zmqEndpointLoopback = /^tcp:\/\/(127\.0\.0\.1|localhost):\d+$/.test(value);
    if ((m[1] === 'WORKER_HOST' || m[1] === 'AUTOTRADER_HOST') && !['127.0.0.1', 'localhost', '::1', ''].includes(value)) {
      hostOverrides.push(m[1]);
    }
  }
  return { keys, liveTradingEnabled, zmqEndpointLoopback, hostOverrides };
}

const REQUIRED_WORKER_KEYS = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
const RECOMMENDED_KEYS = ['WORKER_API_TOKEN'];

export function checkEnv(facts: EnvFacts): CheckResult[] {
  const out: CheckResult[] = [];
  const missing = REQUIRED_WORKER_KEYS.filter((k) => !facts.keys.get(k));
  out.push(missing.length === 0 ? pass('env_required', 'Firebase service account keys present') : fail('env_required', `missing or empty: ${missing.join(', ')}`));
  const recommended = RECOMMENDED_KEYS.filter((k) => !facts.keys.get(k));
  out.push(recommended.length === 0 ? pass('env_recommended', 'WORKER_API_TOKEN set') : warn('env_recommended', `not set: ${recommended.join(', ')} (loopback-only access)`));
  out.push(
    facts.liveTradingEnabled
      ? fail('env_live_trading', 'BYTRADER_LIVE_TRADING=enabled: the v2 rollout and the demo run must start with live trading impossible')
      : pass('env_live_trading', 'BYTRADER_LIVE_TRADING is not enabled'),
  );
  if (facts.zmqEndpointLoopback === false) {
    out.push(fail('env_zmq_endpoint', 'MT5_ZMQ_ENDPOINT is not a loopback address; the bridge must stay private'));
  } else {
    out.push(pass('env_zmq_endpoint', facts.zmqEndpointLoopback ? 'MT5_ZMQ_ENDPOINT is loopback' : 'MT5_ZMQ_ENDPOINT unset (default loopback)'));
  }
  out.push(
    facts.hostOverrides.length > 0
      ? fail('env_host_override', `${facts.hostOverrides.join(', ')} set to a non-loopback address in the env file`)
      : pass('env_host_override', 'no non-loopback bind address in the env file'),
  );
  if (facts.keys.has('ALERT_NOTIFICATIONS')) {
    out.push(pass('env_alert_notifications', 'ALERT_NOTIFICATIONS present (external notifications configured explicitly)'));
  }
  return out;
}

export interface BuildFacts {
  exists: boolean;
  files: Set<string>;
  mt5ClientSource: string | null;
}

export function checkBuild(facts: BuildFacts): CheckResult[] {
  if (!facts.exists) return [fail('build_present', 'build directory not found')];
  const out: CheckResult[] = [];
  const required = ['autotrader.js', 'index.js', 'lib/mt5Client.js', 'lib/signalFeed.js', 'lib/alerts.js', 'tools/preflight.js'];
  const missing = required.filter((f) => !facts.files.has(f));
  out.push(missing.length === 0 ? pass('build_files', 'entry points and v2 modules present') : fail('build_files', `missing: ${missing.join(', ')}`));
  const v2 = facts.mt5ClientSource !== null && /PROTOCOL_VERSION\s*=\s*2\b/.test(facts.mt5ClientSource);
  out.push(v2 ? pass('build_protocol', 'mt5Client speaks protocol v2') : fail('build_protocol', 'mt5Client does not declare PROTOCOL_VERSION = 2'));
  const legacy = ['lib/tradeEngine.js', 'lib/bybitClient.js'].filter((f) => facts.files.has(f));
  out.push(legacy.length === 0 ? pass('build_no_bybit', 'no legacy Bybit execution modules') : warn('build_no_bybit', `legacy modules in build: ${legacy.join(', ')}`));
  return out;
}

/** Installed user unit text: must run worker/dist from the repo with loopback binding. */
export function checkUnit(name: 'autotrader' | 'forwarder', text: string | null, repoRoot: string): CheckResult[] {
  const id = `unit_${name}`;
  if (text === null) return [fail(id, 'unit file not found')];
  const entry = name === 'autotrader' ? 'autotrader.js' : 'index.js';
  const exec = /^ExecStart=(.*)$/m.exec(text)?.[1] ?? '';
  const out: CheckResult[] = [];
  const expectedPath = path.join(repoRoot, 'worker', 'dist', entry);
  out.push(
    exec.includes(expectedPath) || exec.endsWith(` dist/${entry}`)
      ? pass(id, `ExecStart runs ${entry} from worker/dist`)
      : fail(id, `ExecStart does not run ${expectedPath}: ${exec || '(none)'}`),
  );
  const host = name === 'autotrader' ? 'AUTOTRADER_HOST' : 'WORKER_HOST';
  if (new RegExp(`^Environment=.*${host}=(?!127\\.0\\.0\\.1)`, 'm').test(text)) {
    out.push(fail(`${id}_bind`, `${host} is set to a non-loopback address in the unit`));
  }
  return out;
}

export function checkControl(settings: unknown, stage: 'pre' | 'post'): CheckResult[] {
  const s = isRecord(settings) ? settings : {};
  const execution = isRecord(s.execution) ? s.execution : {};
  const trading = isRecord(s.trading) ? s.trading : {};
  const mode = typeof execution.mode === 'string' ? execution.mode : 'missing';
  const out: CheckResult[] = [];
  out.push(
    mode === 'disabled' || mode === 'missing'
      ? pass('control_mode', `execution.mode is ${mode} (no new entries)`)
      : fail('control_mode', `execution.mode is ${mode}; set it to disabled before deploying`),
  );
  out.push(
    trading.kill_switch === true
      ? pass('control_kill_switch', 'kill switch engaged')
      : stage === 'pre'
        ? fail('control_kill_switch', 'kill switch is not engaged; engage it before deploying')
        : warn('control_kill_switch', 'kill switch is not engaged'),
  );
  return out;
}

export interface HealthExpectations {
  stage: 'pre' | 'post';
  expectAccount?: 'DEMO' | 'REAL';
}

export function checkAutotraderHealth(json: unknown, exp: HealthExpectations): CheckResult[] {
  if (!isRecord(json)) return [fail('autotrader_health', 'no /health response')];
  const out: CheckResult[] = [];
  const protocol = json.protocolVersion;
  if (exp.stage === 'pre') {
    out.push(
      protocol === 2
        ? warn('autotrader_version', 'the running AutoTrader is already v2')
        : pass('autotrader_version', 'the running AutoTrader is v1 (expected before the rollout)'),
    );
    return out;
  }
  out.push(protocol === 2 ? pass('autotrader_version', 'AutoTrader v2 is running') : fail('autotrader_version', 'the running AutoTrader is not v2'));
  out.push(json.firestore === true ? pass('autotrader_firestore', 'Firestore reachable') : fail('autotrader_firestore', 'Firestore not reachable'));
  const bridge = isRecord(json.bridge) ? json.bridge : {};
  out.push(bridge.reachable === true ? pass('bridge_reachable', 'EA answers PING') : fail('bridge_reachable', 'EA does not answer'));
  out.push(
    bridge.eaCompatible === true
      ? pass('bridge_protocol', `EA ${String(bridge.eaVersion)} speaks protocol v2`)
      : fail('bridge_protocol', `EA version ${String(bridge.eaVersion ?? 'unknown')} is not v2`),
  );
  out.push(bridge.terminalConnected === true ? pass('terminal_connected', 'terminal connected to the trade server') : fail('terminal_connected', 'terminal not connected'));
  const skew = typeof bridge.gmtSkewSec === 'number' ? bridge.gmtSkewSec : null;
  out.push(
    skew === null
      ? warn('clock_skew', 'clock skew unknown')
      : Math.abs(skew) <= 5
        ? pass('clock_skew', `EA clock within ${Math.abs(skew)} s`)
        : fail('clock_skew', `EA clock differs by ${skew} s`),
  );
  const account = isRecord(json.account) ? json.account : {};
  if (exp.expectAccount) {
    out.push(
      account.tradeMode === exp.expectAccount
        ? pass('account_mode', `connected account is ${exp.expectAccount}`)
        : fail('account_mode', `connected account is ${String(account.tradeMode ?? 'unknown')}, expected ${exp.expectAccount}`),
    );
  }
  const execution = isRecord(json.execution) ? json.execution : {};
  out.push(
    execution.mode === 'disabled' && execution.entriesAllowed === false
      ? pass('execution_disabled', 'execution disabled; no entries allowed')
      : fail('execution_disabled', `execution mode ${String(execution.mode)}, entries allowed ${String(execution.entriesAllowed)}; must start disabled`),
  );
  const loops = isRecord(json.loops) ? json.loops : {};
  const stopped = Object.entries(loops).filter(([, v]) => v !== true).map(([k]) => k);
  out.push(stopped.length === 0 ? pass('loops_running', 'all loops running') : fail('loops_running', `stopped: ${stopped.join(', ')}`));
  const queue = isRecord(json.signalQueue) ? json.signalQueue : {};
  out.push(
    queue.orderedQuery === false
      ? warn('signal_queue_index', 'signal_events composite index missing (unordered fallback in use); deploy firestore.indexes.json')
      : pass('signal_queue_index', 'signal queue uses the ordered query'),
  );
  const issues = Array.isArray(json.issues) ? json.issues.map(String) : [];
  const ignorable = new Set(['config_invalid']); // mode disabled without a profile is expected right after deploy
  const blocking = issues.filter((i) => !ignorable.has(i));
  out.push(blocking.length === 0 ? pass('monitor_issues', issues.length ? `only: ${issues.join(', ')}` : 'none') : fail('monitor_issues', blocking.join(', ')));
  return out;
}

export function checkForwarderHealth(json: unknown, exp: HealthExpectations): CheckResult[] {
  if (!isRecord(json)) return [fail('forwarder_health', 'no /health response')];
  const out: CheckResult[] = [];
  const authorized = json.telegram === 'authorized';
  out.push(
    authorized
      ? pass('telegram_session', 'Telegram session authorized')
      : exp.stage === 'pre'
        ? warn('telegram_session', `Telegram status ${String(json.telegram)} (signals are not being received)`)
        : fail('telegram_session', `Telegram status ${String(json.telegram)}`),
  );
  if (exp.stage === 'post') {
    out.push(json.listenerStarted === true ? pass('telegram_listener', 'listener running') : fail('telegram_listener', 'listener not started'));
    out.push(
      typeof json.signalOutbox === 'number' && json.signalOutbox === 0
        ? pass('signal_outbox', 'outbox empty')
        : warn('signal_outbox', `outbox depth ${String(json.signalOutbox ?? 'unknown')}`),
    );
  }
  return out;
}

export function summarize(results: CheckResult[]): { ok: boolean; text: string } {
  const icon: Record<CheckStatus, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
  const lines = results.map((r) => `${icon[r.status].padEnd(4)}  ${r.name.padEnd(24)} ${r.detail}`);
  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  lines.push('', `${results.length} checks: ${failed} failed, ${warned} warnings`);
  return { ok: failed === 0, text: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// I/O (CLI)
// ---------------------------------------------------------------------------

function listFiles(dir: string, base = dir, out = new Set<string>()): Set<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else out.add(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

async function getJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return await res.json();
  } catch {
    return null;
  }
}

/** Reads settings/default. Credentials come from the process env, else from the env file (values never printed). */
async function readSettings(envFile: string): Promise<unknown> {
  if (!process.env.FIREBASE_PROJECT_ID) dotenv.config({ path: envFile });
  const db = initFirestore();
  if (!db) return null;
  const snap = await db.collection('settings').doc('default').get();
  return snap.data() ?? {};
}

export interface CliOptions {
  stage: 'pre' | 'post';
  repoRoot: string;
  build: string;
  envFile: string;
  unitDir: string;
  live: boolean;
  firestore: boolean;
  expectAccount?: 'DEMO' | 'REAL';
  autotraderUrl: string;
  forwarderUrl: string;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions | string {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const stage = get('--stage');
  if (stage !== 'pre' && stage !== 'post') return 'usage: --stage pre|post is required';
  const repoRoot = path.resolve(get('--repo') ?? env.BYTRADER_ROOT ?? path.resolve(__dirname, '..', '..', '..'));
  const expect = get('--expect-account');
  if (expect !== undefined && expect !== 'DEMO' && expect !== 'REAL') return 'usage: --expect-account DEMO|REAL';
  return {
    stage,
    repoRoot,
    build: path.resolve(get('--build') ?? path.join(repoRoot, 'worker', 'dist')),
    envFile: path.resolve(get('--env-file') ?? path.join(repoRoot, '.env.local')),
    unitDir: path.resolve(get('--units') ?? path.join(env.HOME ?? '', '.config', 'systemd', 'user')),
    live: argv.includes('--live') || stage === 'post',
    firestore: argv.includes('--firestore'),
    expectAccount: expect as 'DEMO' | 'REAL' | undefined,
    autotraderUrl: env.PREFLIGHT_AUTOTRADER_URL ?? 'http://127.0.0.1:4001/health',
    forwarderUrl: env.PREFLIGHT_FORWARDER_URL ?? 'http://127.0.0.1:4000/health',
  };
}

export async function runPreflight(opts: CliOptions): Promise<CheckResult[]> {
  const results: CheckResult[] = [checkNodeVersion(process.version)];

  if (opts.stage === 'pre') {
    const exists = fs.existsSync(opts.build);
    results.push(
      ...checkBuild({
        exists,
        files: exists ? listFiles(opts.build) : new Set(),
        mt5ClientSource: readOrNull(path.join(opts.build, 'lib', 'mt5Client.js')),
      }),
    );
    const envText = readOrNull(opts.envFile);
    results.push(envText === null ? fail('env_file', `env file not found: ${opts.envFile}`) : pass('env_file', 'env file found'));
    if (envText !== null) results.push(...checkEnv(envFacts(envText)));
    results.push(...checkUnit('autotrader', readOrNull(path.join(opts.unitDir, 'bytrader-autotrader.service')), opts.repoRoot));
    results.push(...checkUnit('forwarder', readOrNull(path.join(opts.unitDir, 'bytrader-worker.service')), opts.repoRoot));
  }

  if (opts.live) {
    const exp: HealthExpectations = { stage: opts.stage, expectAccount: opts.expectAccount };
    results.push(...checkAutotraderHealth(await getJson(opts.autotraderUrl), exp));
    results.push(...checkForwarderHealth(await getJson(opts.forwarderUrl), exp));
  }

  if (opts.firestore) {
    let settings: unknown = null;
    try {
      settings = await readSettings(opts.envFile);
    } catch {
      settings = null;
    }
    results.push(settings === null ? fail('control_read', 'settings/default could not be read') : pass('control_read', 'settings/default read'));
    if (settings !== null) results.push(...checkControl(settings, opts.stage));
  }
  return results;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof opts === 'string') {
    console.error(opts);
    process.exit(2);
  }
  const results = await runPreflight(opts);
  const summary = summarize(results);
  console.log(`ByTrader preflight (${opts.stage})\n`);
  console.log(summary.text);
  process.exit(summary.ok ? 0 : 1);
}

if (require.main === module) {
  void main();
}
