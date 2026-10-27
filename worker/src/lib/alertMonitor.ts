/**
 * alertMonitor.ts
 *
 * AutoTrader health checks that turn into operator alerts, plus the AutoTrader
 * heartbeat (serviceHealth.ts). Runs every ALERT_MONITOR_INTERVAL_MS (15 s).
 * Read-only towards the broker: PING and, in demo/live, the cached account
 * read the engine already uses. It never sends a mutation.
 *
 *   bridge_disconnected   PING failed twice in a row (critical in demo/live)
 *   ea_version_mismatch   EA does not report protocol v2 (critical)
 *   terminal_disconnected terminal offline (critical in demo/live) or AutoTrading off
 *   clock_skew            |EA TimeGMT − worker clock| above MAX_CLOCK_SKEW_SEC
 *   config_invalid        mode set but profile/safety invalid, unreadable config,
 *                         live without the env flag, or the account does not match the mode
 *   service_unhealthy     forwarder heartbeat stale (via serviceHealth)
 *   firestore_unavailable heartbeat writes failing (via serviceHealth)
 * Each alert resolves itself once its condition clears.
 */

import { raiseAlert, resolveAlert, describeNotificationConfig } from './alerts';
import type { AlertSeverity } from './alertTypes';
import { eaVersionCompatible, maxClockSkewSec, pingBridge, REQUIRED_EA_MAJOR } from './bridgeHealth';
import type { PingDetails } from './bridgeHealth';
import { getBroker, verifyAccountForMode } from './brokerRouter';
import { canOpenNewEntries, getExecutionControl } from './executionControl';
import type { ExecutionControl } from './executionControl';
import { logger } from './logger';
import { createHeartbeat } from './serviceHealth';
import type { Heartbeat, HeartbeatPayload } from './serviceHealth';
import { getSignalFeedStats } from './signalFeed';

const DEFAULT_INTERVAL_MS = 15_000;
const BRIDGE_FAILURES_BEFORE_ALERT = 2;

export interface MonitorSnapshot {
  checkedAt: string | null;
  bridge: PingDetails | null;
  accountMode: string | null;
  issues: string[];
}

export interface LoopFlags {
  signalFeed: boolean;
  lifecycle: boolean;
  reconciler: boolean;
  adminCommands: boolean;
}

let bridgeFailures = 0;
let last: MonitorSnapshot = { checkedAt: null, bridge: null, accountMode: null, issues: [] };
let heartbeat: Heartbeat | null = null;
let loopFlags: () => LoopFlags = () => ({ signalFeed: false, lifecycle: false, reconciler: false, adminCommands: false });

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tradingMode(control: ExecutionControl | null): boolean {
  return control?.mode === 'demo' || control?.mode === 'live';
}

async function checkBridge(control: ExecutionControl | null, issues: string[]): Promise<PingDetails> {
  const ping = await pingBridge();
  if (!ping.reachable) {
    bridgeFailures += 1;
    issues.push('bridge_unreachable');
    if (bridgeFailures >= BRIDGE_FAILURES_BEFORE_ALERT) {
      const severity: AlertSeverity = tradingMode(control) ? 'critical' : control?.mode === 'paper' ? 'error' : 'warning';
      await raiseAlert({
        type: 'bridge_disconnected',
        severity,
        source: 'autotrader',
        title: 'MT5 bridge unreachable',
        message: `${bridgeFailures} consecutive PINGs to VantageBridgeEA failed (mode ${control?.mode ?? 'unknown'}).`,
        details: { consecutive_failures: bridgeFailures, mode: control?.mode ?? null },
      });
    }
    return ping;
  }

  bridgeFailures = 0;
  await resolveAlert('bridge_disconnected', '', 'ping_ok');

  if (!eaVersionCompatible(ping.eaVersion)) {
    issues.push('ea_version_mismatch');
    await raiseAlert({
      type: 'ea_version_mismatch',
      severity: 'critical',
      source: 'autotrader',
      title: 'EA protocol version does not match the AutoTrader',
      message: `VantageBridgeEA reports version ${ping.eaVersion ?? 'unknown'}; the AutoTrader requires ${REQUIRED_EA_MAJOR}x.`,
      details: { ea_version: ping.eaVersion },
    });
  } else {
    await resolveAlert('ea_version_mismatch', '', 'ea_version_ok');
  }

  const skew = ping.gmtSkewSec;
  if (skew !== null && Math.abs(skew) > maxClockSkewSec()) {
    issues.push('clock_skew');
    await raiseAlert({
      type: 'clock_skew',
      severity: tradingMode(control) ? 'critical' : 'warning',
      source: 'autotrader',
      title: 'Terminal and worker clocks disagree',
      message: `EA TimeGMT() is ${skew > 0 ? 'ahead of' : 'behind'} the worker clock by ${Math.abs(skew)} s (limit ${maxClockSkewSec()} s). New entries are refused.`,
      details: { gmt_skew_sec: skew },
    });
  } else if (skew !== null) {
    await resolveAlert('clock_skew', '', 'clocks_agree');
  }

  if (ping.terminalConnected === false) {
    issues.push('terminal_disconnected');
    await raiseAlert({
      type: 'terminal_disconnected',
      subject: 'connection',
      severity: tradingMode(control) ? 'critical' : 'warning',
      source: 'autotrader',
      title: 'MT5 terminal not connected to the broker',
      message: 'The EA answers, but the terminal reports no connection to the Vantage trade server.',
    });
  } else if (ping.terminalConnected === true) {
    await resolveAlert('terminal_disconnected', 'connection', 'terminal_connected');
  }

  if (ping.tradeAllowed === false && tradingMode(control)) {
    issues.push('terminal_trade_not_allowed');
    await raiseAlert({
      type: 'terminal_disconnected',
      subject: 'trade_allowed',
      severity: 'error',
      source: 'autotrader',
      title: 'AutoTrading is disabled in the MT5 terminal',
      message: 'The terminal does not allow algorithmic trading, so orders, partial closes and stop moves will be refused.',
      action: 'Enable "Algo Trading" in the MT5 terminal toolbar and in the EA properties (deploy/MT5_GUI.md).',
    });
  } else if (ping.tradeAllowed === true || !tradingMode(control)) {
    await resolveAlert('terminal_disconnected', 'trade_allowed', 'trade_allowed');
  }
  return ping;
}

async function checkConfig(control: ExecutionControl | null, issues: string[]): Promise<void> {
  if (!control) return;
  const problems: string[] = [];
  let severity: AlertSeverity = 'critical';

  if (control.source === 'fail_closed') {
    // Firestore outages are reported by the heartbeat; anything else is unreadable config.
    if (!String(control.reason ?? '').startsWith('firestore_unavailable')) {
      problems.push(`execution config unreadable: ${control.reason ?? 'unknown'}`);
    }
  } else if (control.mode !== 'disabled') {
    problems.push(...control.safetyErrors.map((e) => `safety ${e}`));
    problems.push(...control.profileErrors.map((e) => `profile ${e}`));
    if (control.activeProfileDocId === null) problems.push('no active execution profile');
    if (control.mode === 'live' && !control.liveTradingEnvEnabled) {
      problems.push('mode is live but BYTRADER_LIVE_TRADING is not enabled');
    }
  } else if (String(control.reason ?? '').match(/mode_missing|unknown_mode/)) {
    severity = 'warning';
    problems.push(`execution mode not set correctly (${control.reason}); execution is disabled`);
  }

  if (problems.length > 0) {
    issues.push('config_invalid');
    await raiseAlert({
      type: 'config_invalid',
      subject: 'execution',
      severity,
      source: 'autotrader',
      title: severity === 'critical' ? 'Execution configuration invalid: new entries blocked' : 'Execution mode not configured',
      message: problems.slice(0, 5).join('; '),
      details: { mode: control.mode, problems: problems.slice(0, 10) },
    });
  } else {
    await resolveAlert('config_invalid', 'execution', 'config_valid');
  }
}

/**
 * Reports the connected account's trade mode whenever the bridge answers (a
 * read-only ACCOUNT_INFO through the MT5 adapter), so a deployment can confirm a
 * DEMO account while execution is still disabled. In demo/live the account must
 * also match the mode (demo ↔ DEMO, live ↔ REAL); a mismatch is critical.
 */
async function checkAccount(control: ExecutionControl | null, ping: PingDetails | null, issues: string[]): Promise<string | null> {
  if (!ping?.reachable) return null;
  const tradingMode = control?.mode === 'demo' || control?.mode === 'live' ? control.mode : null;
  try {
    // demo and live share one MT5 adapter; paper/disabled read the same terminal through it.
    const broker = await getBroker(tradingMode ?? 'demo');
    if (!tradingMode) {
      const account = await broker.getAccountInfo();
      return account.tradeMode;
    }
    const check = await verifyAccountForMode(tradingMode, broker);
    if (check.ok === false) {
      if (check.reason === 'account_unavailable') return null;
      issues.push(`account_${check.reason}`);
      await raiseAlert({
        type: 'config_invalid',
        subject: 'account_mode',
        severity: 'critical',
        source: 'autotrader',
        title: 'Connected account does not match the execution mode',
        message: `Mode ${tradingMode} refuses this account: ${check.reason}. No entries are sent until this is fixed.`,
        action:
          'Check which account the MT5 terminal is logged into. Demo mode requires a DEMO account; live mode requires a REAL account and BYTRADER_LIVE_TRADING=enabled.',
        details: { mode: tradingMode, reason: check.reason },
      });
      return (await broker.getAccountInfo().catch(() => null))?.tradeMode ?? null;
    }
    await resolveAlert('config_invalid', 'account_mode', 'account_matches_mode');
    return check.account?.tradeMode ?? null;
  } catch (err) {
    logger.warn('alert_monitor_account_check_failed', { error: errorMessage(err) });
    return null;
  }
}

/** One monitor pass. Never throws. */
export async function runAlertMonitor(): Promise<MonitorSnapshot> {
  const issues: string[] = [];
  let control: ExecutionControl | null = null;
  try {
    control = await getExecutionControl();
  } catch (err) {
    logger.warn('alert_monitor_control_failed', { error: errorMessage(err) });
  }
  let ping: PingDetails | null = null;
  try {
    ping = await checkBridge(control, issues);
    await checkConfig(control, issues);
  } catch (err) {
    logger.warn('alert_monitor_failed', { error: errorMessage(err) });
  }
  const accountMode = await checkAccount(control, ping, issues);
  last = { checkedAt: new Date().toISOString(), bridge: ping, accountMode, issues };
  return last;
}

async function collect(): Promise<HeartbeatPayload> {
  const snap = await runAlertMonitor();
  const control = await getExecutionControl().catch(() => null);
  const loops = loopFlags();
  const issues = [...snap.issues];
  for (const [name, running] of Object.entries(loops)) if (!running) issues.push(`loop_stopped:${name}`);
  const feed = getSignalFeedStats();
  if (feed?.lastError) issues.push(`signal_feed:${feed.lastError}`);
  const allowed = control ? canOpenNewEntries(control) : null;
  return {
    healthy: issues.length === 0,
    issues,
    details: {
      mode: control?.mode ?? null,
      kill_switch: control?.killSwitch ?? null,
      entries_allowed: allowed?.allowed ?? false,
      entries_blocked_reason: allowed && allowed.allowed === false ? allowed.reason : null,
      active_profile_doc_id: control?.activeProfileDocId ?? null,
      bridge_reachable: snap.bridge?.reachable ?? null,
      ea_version: snap.bridge?.eaVersion ?? null,
      terminal_connected: snap.bridge?.terminalConnected ?? null,
      terminal_trade_allowed: snap.bridge?.tradeAllowed ?? null,
      bridge_latency_ms: snap.bridge?.latencyMs ?? null,
      server_offset_sec: snap.bridge?.serverOffsetSec ?? null,
      gmt_skew_sec: snap.bridge?.gmtSkewSec ?? null,
      account_mode: snap.accountMode,
      loops,
      signal_feed: feed
        ? {
            active: feed.activeCount,
            oldest_active_created_at: feed.oldestActiveCreatedAt,
            dead_letters: feed.deadLetterCount,
            ordered_query: feed.orderedQuery,
            last_tick_at: feed.lastTickAt,
          }
        : null,
      notifications: describeNotificationConfig(),
    },
  };
}

export function getLastMonitorSnapshot(): MonitorSnapshot {
  return last;
}

export function startAlertMonitor(loops: () => LoopFlags, intervalMs = Number(process.env.ALERT_MONITOR_INTERVAL_MS) || DEFAULT_INTERVAL_MS): void {
  if (heartbeat) return;
  loopFlags = loops;
  heartbeat = createHeartbeat({ service: 'autotrader', peer: 'forwarder', intervalMs, collect });
  heartbeat.start();
  logger.info('alert_monitor_started', { intervalMs });
}

export function stopAlertMonitor(): void {
  heartbeat?.stop();
  heartbeat = null;
}

export function isAlertMonitorRunning(): boolean {
  return heartbeat !== null;
}

/** Test seam. */
export function _resetAlertMonitorForTests(): void {
  stopAlertMonitor();
  bridgeFailures = 0;
  last = { checkedAt: null, bridge: null, accountMode: null, issues: [] };
}
