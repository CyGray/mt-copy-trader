import dotenv from 'dotenv';

dotenv.config({ path: '../.env.local' });
dotenv.config();
import express from 'express';
import { initFirestore } from './lib/firestoreAdmin';
import { requireBearerToken, resolveListenHost } from './lib/httpAuth';
import { logger } from './lib/logger';
import { createHeartbeat } from './lib/serviceHealth';
import { getSignalOutboxDepth, startSignalOutbox } from './lib/signalEvents';
import { writeSystemLog } from './lib/systemLog';
import {
  getTelegramStatus,
  logoutTelegram,
  startTelegramLogin,
  submitTelegramCode,
  submitTelegramPassword,
} from './lib/telegramClient';
import { isTelegramListenerStarted, startTelegramListener } from './lib/telegramListener';

const app = express();
const port = Number(process.env.WORKER_PORT ?? 4000);
const host = resolveListenHost('WORKER_HOST');

function maskPhone(phone: string | null): string | null {
  if (!phone) return phone;
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 3 ? '***' : `***${digits.slice(-3)}`;
}

function maskTelegramStatus<T extends { phone: string | null }>(status: T): T {
  return { ...status, phone: maskPhone(status.phone) };
}

app.use(express.json());
app.use('/telegram', requireBearerToken());

app.get('/health', async (_req, res) => {
  const firestoreStatus = await initFirestore();
  const telegramStatus = await getTelegramStatus();
  res.json({
    status: 'ok',
    service: 'forwarder',
    firestore: firestoreStatus ? 'ok' : 'error',
    telegram: telegramStatus.status,
    telegramReauthRequired: telegramStatus.reauthRequired,
    listenerStarted: isTelegramListenerStarted(),
    signalOutbox: getSignalOutboxDepth(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/telegram/status', async (_req, res) => {
  const status = await getTelegramStatus();
  res.json(maskTelegramStatus(status));
});

app.post('/telegram/start', async (req, res) => {
  const phone = req.body?.phone as string | undefined;
  if (!phone) {
    return res.status(400).json({ error: 'Missing phone' });
  }

  try {
    await startTelegramLogin(phone);
    const status = await getTelegramStatus();
    if (status.status === 'authorized') {
      await startTelegramListener();
    }
    return res.json(maskTelegramStatus(status));
  } catch (error) {
    return res.status(500).json({ error: 'Failed to start login' });
  }
});

app.post('/telegram/verify-otp', async (req, res) => {
  const code = req.body?.code as string | undefined;
  if (!code) {
    return res.status(400).json({ error: 'Missing code' });
  }

  try {
    submitTelegramCode(code);
    const status = await getTelegramStatus();
    if (status.status === 'authorized') {
      await startTelegramListener();
    }
    return res.json(maskTelegramStatus(status));
  } catch (error) {
    return res.status(400).json({ error: 'OTP not accepted' });
  }
});

app.post('/telegram/verify-password', async (req, res) => {
  const password = req.body?.password as string | undefined;
  if (!password) {
    return res.status(400).json({ error: 'Missing password' });
  }

  try {
    submitTelegramPassword(password);
    const status = await getTelegramStatus();
    if (status.status === 'authorized') {
      await startTelegramListener();
    }
    return res.json(maskTelegramStatus(status));
  } catch (error) {
    return res.status(400).json({ error: 'Password not accepted' });
  }
});

app.post('/telegram/logout', async (_req, res) => {
  await logoutTelegram();
  res.json({ status: 'disconnected' });
});

// Heartbeat in service_status/forwarder, and a watchdog on the AutoTrader's heartbeat.
const heartbeat = createHeartbeat({
  service: 'forwarder',
  peer: 'autotrader',
  collect: async () => {
    const telegram = await getTelegramStatus();
    const outbox = getSignalOutboxDepth();
    const issues: string[] = [];
    if (telegram.status !== 'authorized') issues.push(`telegram_${telegram.status}`);
    if (telegram.reauthRequired) issues.push('telegram_reauth_required');
    if (telegram.status === 'authorized' && !isTelegramListenerStarted()) issues.push('listener_not_started');
    if (outbox > 0) issues.push(`signal_outbox_pending:${outbox}`);
    return {
      healthy: issues.length === 0,
      issues,
      details: { telegram: telegram.status, listener_started: isTelegramListenerStarted(), signal_outbox: outbox },
    };
  },
});

app.listen(port, host, () => {
  logger.info('worker_started', { port, host });
  void writeSystemLog('info', 'worker', 'worker_started', { port, host });
  // Events spooled while Firestore was failing are retried first, in order.
  startSignalOutbox();
  heartbeat.start();

  // Periodic Telegram listener health check
  setInterval(async () => {
    try {
      const status = await getTelegramStatus();
      if (status.status === 'authorized') {
        await startTelegramListener();
      }
    } catch (error) {
      logger.warn('telegram_listener_check_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, 10000);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  process.exit(0);
});
process.on('SIGINT', () => {
  process.exit(0);
});

