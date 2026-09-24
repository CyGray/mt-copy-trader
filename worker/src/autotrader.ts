/**
 * autotrader.ts — ByTrader AutoTrader service entry point.
 *
 * Runs the MT5 execution side of ByTrader, fully decoupled from the Telegram
 * forwarder:
 *   - consumes `signal_events` published by the forwarder (signalFeed)
 *   - executes signals on MetaTrader 5 via the ZeroMQ bridge (mt5TradeEngine)
 *   - manages open positions: break-even, trailing stop, cancellation
 *     (lifecycleManager)
 *
 * It never connects to Telegram, so it can be rebuilt/restarted without
 * touching the forwarder and vice-versa.
 */

import dotenv from 'dotenv';

dotenv.config({ path: '../.env.local' });
dotenv.config();

import express from 'express';
import { initFirestore } from './lib/firestoreAdmin';
import { logger } from './lib/logger';
import { writeSystemLog } from './lib/systemLog';
import { mt5HealthCheck } from './lib/mt5Client';
import { getMt5Config } from './lib/mt5Secrets';
import {
  isLifecycleManagerRunning,
  startLifecycleManager,
  stopLifecycleManager,
} from './lib/lifecycleManager';
import { isSignalFeedRunning, startSignalFeed, stopSignalFeed } from './lib/signalFeed';

const app = express();
const port = Number(process.env.AUTOTRADER_PORT ?? 4001);

app.use(express.json());

app.get('/health', async (_req, res) => {
  const firestoreStatus = await initFirestore();
  const mt5Status = await mt5HealthCheck();
  res.json({
    status: 'ok',
    firestore: firestoreStatus ? 'ok' : 'error',
    mt5Bridge: mt5Status.healthy ? 'ok' : 'unreachable',
    mt5LatencyMs: mt5Status.latencyMs ?? null,
    lifecycleManager: isLifecycleManagerRunning() ? 'running' : 'stopped',
    signalFeed: isSignalFeedRunning() ? 'running' : 'stopped',
    timestamp: new Date().toISOString(),
  });
});

app.get('/mt5/health', async (_req, res) => {
  const mt5Status = await mt5HealthCheck();
  res.json(mt5Status);
});

app.get('/mt5/config', async (_req, res) => {
  const config = await getMt5Config();
  res.json(config);
});

app.listen(port, () => {
  logger.info('autotrader_started', { port });
  void writeSystemLog('info', 'autotrader', 'autotrader_started', { port });

  // Consume signals published by the forwarder, and manage open positions.
  startSignalFeed();
  startLifecycleManager(Number(process.env.LIFECYCLE_INTERVAL_MS ?? 2000));
});

process.on('SIGTERM', () => {
  stopSignalFeed();
  stopLifecycleManager();
  process.exit(0);
});
process.on('SIGINT', () => {
  stopSignalFeed();
  stopLifecycleManager();
  process.exit(0);
});
