/**
 * autotrader.ts — ByTrader AutoTrader service entry point.
 *
 * Runs the MT5 execution side of ByTrader, fully decoupled from the Telegram
 * forwarder. It never imports the Telegram modules, so it can be rebuilt or
 * restarted without touching the forwarder, and the reverse.
 *
 * HTTP (bound to AUTOTRADER_HOST, default 127.0.0.1, port AUTOTRADER_PORT):
 *   GET /health      public on the bound interface; no secrets. `ok` requires
 *                    Firestore, a reachable bridge and a protocol-v2 EA; the
 *                    body also carries the account trade mode, loop flags,
 *                    durable signal queue stats and current monitor issues.
 *   GET /mt5/health  bridge ping details; bearer token or loopback
 *   GET /mt5/config  symbol and deviation only; bearer token or loopback
 *
 * Startup: the HTTP server listens first, then the bridge is pinged, the server
 * time offset is refreshed, and one reconciliation pass runs before any loop
 * starts. The alert monitor (alertMonitor.ts) then writes the heartbeat and
 * raises operator alerts. If Firestore is unavailable the loops still start, and every loop
 * fails closed on the missing persistence (no entries, no state changes).
 *
 * Shutdown (SIGINT/SIGTERM): loops stop their timers and the server closes. The
 * modules do not expose in-flight ticks, so a tick mid-send is not awaited. A
 * submission cut short stays SUBMITTING and is resolved by the stale-submitting
 * rule and the reconciler.
 */

import dotenv from 'dotenv';
import type { Express, RequestHandler, Response } from 'express';
import express from 'express';
import { getLastMonitorSnapshot, isAlertMonitorRunning, startAlertMonitor, stopAlertMonitor } from './lib/alertMonitor';
import { describeNotificationConfig } from './lib/alerts';
import { eaVersionCompatible, pingBridge, REQUIRED_EA_MAJOR } from './lib/bridgeHealth';
import { canOpenNewEntries, getExecutionControl } from './lib/executionControl';
import { initFirestore } from './lib/firestoreAdmin';
import { requireBearerToken, resolveListenHost } from './lib/httpAuth';
import { logger } from './lib/logger';
import { refreshServerTimeOffset } from './lib/mt5Client';
import { getMt5Config } from './lib/mt5Secrets';
import {
  isLifecycleManagerRunning,
  startLifecycleManager,
  stopLifecycleManager,
} from './lib/lifecycleManager';
import { isReconcilerRunning, runReconciliation, startReconciler, stopReconciler } from './lib/reconciler';
import {
  isAdminCommandPollerRunning,
  startAdminCommandPoller,
  stopAdminCommandPoller,
} from './lib/adminCommands';
import { getSignalFeedStats, isSignalFeedRunning, startSignalFeed, stopSignalFeed } from './lib/signalFeed';
import { writeSystemLog } from './lib/systemLog';

export type { PingDetails } from './lib/bridgeHealth';

const DEFAULT_PORT = 4001;
const DEFAULT_LIFECYCLE_INTERVAL_MS = 2000;
const FORCED_EXIT_MS = 5000;
/** Reported by /health so a deployment can check the worker and EA protocol versions. */
export const AUTOTRADER_PROTOCOL_VERSION = 2;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function loopFlags() {
  return {
    signalFeed: isSignalFeedRunning(),
    lifecycle: isLifecycleManagerRunning(),
    reconciler: isReconcilerRunning(),
    adminCommands: isAdminCommandPollerRunning(),
  };
}

/** Monitor results this recent are reused by /health instead of a new PING. */
const HEALTH_PING_MAX_AGE_MS = 30_000;

/**
 * Bridge status for /health. Reuses the alert monitor's last PING when it is
 * fresh, so /health answers at once even while the bridge is down (a new PING
 * would queue behind timing-out requests). Otherwise pings directly.
 */
async function currentBridge() {
  const snap = getLastMonitorSnapshot();
  const at = snap.checkedAt ? Date.parse(snap.checkedAt) : NaN;
  if (snap.bridge && Number.isFinite(at) && Date.now() - at < HEALTH_PING_MAX_AGE_MS) return snap.bridge;
  return pingBridge();
}

/** Wraps an async handler so a rejection becomes a 500 with no detail. */
function handle(fn: (res: Response) => Promise<void>): RequestHandler {
  return (_req, res) => {
    fn(res).catch((err: unknown) => {
      logger.error('autotrader_route_failed', { error: errorMessage(err) });
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    });
  };
}

/** Express app with the AutoTrader routes. Does not listen. */
export function createAutotraderApp(): Express {
  const app = express();
  app.use(express.json());

  app.get(
    '/health',
    handle(async (res) => {
      const firestore = initFirestore() !== null;
      const bridge = await currentBridge();
      const control = await getExecutionControl();
      const allowed = canOpenNewEntries(control);
      const loops = loopFlags();
      const feed = getSignalFeedStats();
      const monitor = getLastMonitorSnapshot();
      const eaCompatible = eaVersionCompatible(bridge.eaVersion);
      res.json({
        ok: firestore && bridge.reachable && eaCompatible,
        service: 'autotrader',
        protocolVersion: AUTOTRADER_PROTOCOL_VERSION,
        firestore,
        bridge: {
          reachable: bridge.reachable,
          eaVersion: bridge.eaVersion,
          eaCompatible,
          terminalConnected: bridge.terminalConnected,
          tradeAllowed: bridge.tradeAllowed,
          latencyMs: bridge.latencyMs,
          serverOffsetSec: bridge.serverOffsetSec,
          gmtSkewSec: bridge.gmtSkewSec,
        },
        account: { tradeMode: monitor.accountMode, checkedAt: monitor.checkedAt },
        execution: {
          mode: control.mode,
          killSwitch: control.killSwitch,
          activeProfileDocId: control.activeProfileDocId,
          entriesAllowed: allowed.allowed,
          reason: allowed.allowed === false ? allowed.reason : null,
        },
        loops: { ...loops, alertMonitor: isAlertMonitorRunning() },
        signalQueue: feed
          ? {
              active: feed.activeCount,
              oldestActiveCreatedAt: feed.oldestActiveCreatedAt,
              deadLetters: feed.deadLetterCount,
              orderedQuery: feed.orderedQuery,
              lastTickAt: feed.lastTickAt,
              lastError: feed.lastError,
            }
          : null,
        issues: monitor.issues,
        notifications: describeNotificationConfig(),
      });
    }),
  );

  app.get(
    '/mt5/health',
    requireBearerToken(),
    handle(async (res) => {
      res.json(await pingBridge());
    }),
  );

  app.get(
    '/mt5/config',
    requireBearerToken(),
    handle(async (res) => {
      const cfg = await getMt5Config();
      res.json({ symbol: cfg.symbol, deviation: cfg.deviation, magicConfigured: cfg.magic > 0 });
    }),
  );

  return app;
}

/** Startup after the HTTP server is listening. Every step is best effort except the loops. */
async function bootstrap(): Promise<void> {
  if (initFirestore() === null) {
    logger.error('autotrader_firestore_unavailable', { effect: 'loops start and fail closed' });
    await writeSystemLog('error', 'autotrader', 'autotrader_firestore_unavailable', {
      effect: 'loops start and fail closed',
    });
  }

  const ping = await pingBridge();
  if (!ping.reachable) {
    logger.warn('autotrader_bridge_unreachable', {});
    await writeSystemLog('warn', 'autotrader', 'autotrader_bridge_unreachable', {});
  } else if (!eaVersionCompatible(ping.eaVersion)) {
    // The v1 EA rejects protocol v2 requests, so this is a deployment mismatch.
    logger.warn('autotrader_ea_version_mismatch', { eaVersion: ping.eaVersion, expected: `${REQUIRED_EA_MAJOR}x` });
    await writeSystemLog('warn', 'autotrader', 'autotrader_ea_version_mismatch', {
      eaVersion: ping.eaVersion,
      expected: `${REQUIRED_EA_MAJOR}x`,
    });
  }

  try {
    await refreshServerTimeOffset();
  } catch (err) {
    logger.warn('autotrader_offset_refresh_failed', { error: errorMessage(err) });
    await writeSystemLog('warn', 'autotrader', 'autotrader_offset_refresh_failed', { error: errorMessage(err) });
  }

  // Ambiguous submissions from an earlier run are resolved before new signals are consumed.
  const summary = await runReconciliation();
  logger.info('autotrader_startup_reconciled', { ...summary });
  await writeSystemLog('info', 'autotrader', 'autotrader_startup_reconciled', { ...summary });

  startSignalFeed();
  startLifecycleManager(Number(process.env.LIFECYCLE_INTERVAL_MS) || DEFAULT_LIFECYCLE_INTERVAL_MS);
  startReconciler();
  startAdminCommandPoller();
  startAlertMonitor(loopFlags);
  logger.info('autotrader_loops_started', {});
  await writeSystemLog('info', 'autotrader', 'autotrader_loops_started', {});
}

function stopLoops(): void {
  stopSignalFeed();
  stopLifecycleManager();
  stopReconciler();
  stopAdminCommandPoller();
  stopAlertMonitor();
}

async function main(): Promise<void> {
  dotenv.config({ path: '../.env.local' });
  dotenv.config();

  const port = Number(process.env.AUTOTRADER_PORT ?? DEFAULT_PORT);
  const host = resolveListenHost('AUTOTRADER_HOST');
  logger.info('autotrader_starting', { port, host });
  await writeSystemLog('info', 'autotrader', 'autotrader_starting', { port, host });

  const server = createAutotraderApp().listen(port, host, () => {
    logger.info('autotrader_started', { port, host });
    void writeSystemLog('info', 'autotrader', 'autotrader_started', { port, host });
  });
  server.on('error', (err: Error) => {
    logger.error('autotrader_listen_failed', { error: err.message, port, host });
    void writeSystemLog('error', 'autotrader', 'autotrader_listen_failed', { error: err.message, port, host });
    process.exit(1);
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info('autotrader_stopping', { signal });
    void writeSystemLog('info', 'autotrader', 'autotrader_stopping', { signal });
    stopLoops();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), FORCED_EXIT_MS).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await bootstrap();
}

if (require.main === module) {
  main().catch((err: unknown) => {
    logger.error('autotrader_fatal', { error: errorMessage(err) });
    process.exit(1);
  });
}
