import dotenv from 'dotenv';

dotenv.config({ path: '../.env.local' });
dotenv.config();
import express from 'express';
import { initFirestore } from './lib/firestoreAdmin';
import { logger } from './lib/logger';
import { writeSystemLog } from './lib/systemLog';
import {
  getQrLoginState,
  getTelegramStatus,
  logoutTelegram,
  setAuthorizedHandler,
  startTelegramLogin,
  startTelegramQrLogin,
  submitTelegramCode,
  submitTelegramPassword,
} from './lib/telegramClient';
import {
  acquireInstanceLock,
  getInstanceId,
  holdsInstanceLock,
  releaseInstanceLock,
  startInstanceLockHeartbeat,
} from './lib/instanceLock';
import { startTelegramListener } from './lib/telegramListener';

const app = express();
const port = Number(process.env.WORKER_PORT ?? 4000);

app.use(express.json());

app.get('/health', async (_req, res) => {
  const firestoreStatus = await initFirestore();
  const telegramStatus = await getTelegramStatus();
  res.json({
    status: 'ok',
    firestore: firestoreStatus ? 'ok' : 'error',
    telegram: telegramStatus.status,
    telegramReauthRequired: telegramStatus.reauthRequired,
    timestamp: new Date().toISOString(),
  });
});

app.get('/telegram/status', async (_req, res) => {
  const status = await getTelegramStatus();
  res.json(status);
});

app.get('/telegram/qr', (_req, res) => {
  res.json(getQrLoginState());
});

app.post('/telegram/qr', async (_req, res) => {
  try {
    await startTelegramQrLogin();
    return res.json(getQrLoginState());
  } catch (error) {
    return res.status(500).json({ error: 'Failed to start QR login' });
  }
});

app.post('/telegram/start', async (req, res) => {
  const phone = req.body?.phone as string | undefined;
  if (!phone) {
    return res.status(400).json({ error: 'Missing phone' });
  }

  try {
    await startTelegramLogin(phone);
    const status = await getTelegramStatus();
    if (status.status === 'authorized' && holdsInstanceLock()) {
      await startTelegramListener();
    }
    return res.json(status);
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
    if (status.status === 'authorized' && holdsInstanceLock()) {
      await startTelegramListener();
    }
    return res.json(status);
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
    if (status.status === 'authorized' && holdsInstanceLock()) {
      await startTelegramListener();
    }
    return res.json(status);
  } catch (error) {
    return res.status(400).json({ error: 'Password not accepted' });
  }
});

app.post('/telegram/logout', async (_req, res) => {
  await logoutTelegram();
  res.json({ status: 'disconnected' });
});

async function ensureTelegramListener(): Promise<void> {
  if (!holdsInstanceLock()) return;

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
}

async function bootstrapTelegram(): Promise<void> {
  const acquired = await acquireInstanceLock();
  if (!acquired) {
    logger.warn('worker_instance_lock_held', { instanceId: getInstanceId() });
    await writeSystemLog('warn', 'worker', 'instance_lock_held', {
      instanceId: getInstanceId(),
    });
    return;
  }

  startInstanceLockHeartbeat();
  await ensureTelegramListener();
}

app.listen(port, () => {
  logger.info('worker_started', { port, instanceId: getInstanceId() });
  void writeSystemLog('info', 'worker', 'worker_started', {
    port,
    instanceId: getInstanceId(),
  });

  setAuthorizedHandler(() => {
    void ensureTelegramListener();
  });

  void bootstrapTelegram();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void releaseInstanceLock().finally(() => {
      process.exit(0);
    });
  });
}
