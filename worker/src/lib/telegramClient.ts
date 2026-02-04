import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { clearTelegramSession, loadTelegramSession, saveTelegramSession } from './telegramSession';
import { writeSystemLog } from './systemLog';

export type TelegramStatus =
  | 'disconnected'
  | 'awaiting_code'
  | 'awaiting_password'
  | 'authorized'
  | 'error';

type Resolver = (value: string) => void;

let client: TelegramClient | null = null;
let status: TelegramStatus = 'disconnected';
let lastError: string | null = null;
let reauthRequired = false;
let phoneNumber: string | null = null;
let codeResolver: Resolver | null = null;
let passwordResolver: Resolver | null = null;

function getDcFromError(error: unknown): number | null {
  if (!error) return null;
  const candidate = error as { newDc?: number; errorMessage?: string };
  if (typeof candidate.newDc === 'number' && candidate.newDc > 0) {
    return candidate.newDc;
  }
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = message.match(/DC\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

async function handleDcMigrate(newDc: number): Promise<void> {
  await writeSystemLog('info', 'telegram', 'dc_migrate_detected', {
    newDc,
    message: `Phone is on DC ${newDc}. Resetting client for manual retry.`,
  });

  // Clean up client state completely
  if (client) {
    try {
      await client.disconnect();
    } catch {
      // Ignore
    }
    client = null;
  }

  codeResolver = null;
  passwordResolver = null;
  clearTelegramSession();
  status = 'disconnected';
  reauthRequired = true;
  lastError = `Phone number is on DC ${newDc}. Click "Change number" and try again.`;
}

async function recordError(context: string, error: unknown): Promise<void> {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  lastError = message || 'telegram_error';

  if (isSessionExpired(error)) {
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // Ignore
      }
    }
    client = null;
    codeResolver = null;
    passwordResolver = null;
    clearTelegramSession();
    reauthRequired = true;
    status = 'disconnected';
    await writeSystemLog('warn', 'telegram', 'session_expired', {
      context,
      error: message || 'session_expired',
    });
    return;
  }

  const migrateDc = getDcFromError(error);
  if (migrateDc) {
    await writeSystemLog('warn', 'telegram', 'phone_migrate', {
      context,
      error: message || 'phone_migrate',
      newDc: migrateDc,
    });
    await handleDcMigrate(migrateDc);
    return;
  }

  status = 'error';
  await writeSystemLog('error', 'telegram', 'telegram_error', {
    context,
    error: message || 'telegram_error',
  });
}

function isSessionExpired(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return (
    message.includes('AUTH_KEY_UNREGISTERED') ||
    message.includes('SESSION_REVOKED') ||
    message.includes('AUTH_KEY_INVALID')
  );
}

function getApiConfig(): { apiId: number; apiHash: string } {
  const apiId = Number(process.env.TELEGRAM_API_ID ?? 0);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) {
    throw new Error('TELEGRAM_API_ID/TELEGRAM_API_HASH not configured.');
  }
  return { apiId, apiHash };
}

async function createClient(sessionString?: string | null): Promise<TelegramClient> {
  const { apiId, apiHash } = getApiConfig();
  const session = new StringSession(sessionString ?? '');
  const nextClient = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
  });
  await nextClient.connect();
  return nextClient;
}

async function ensureClient(): Promise<TelegramClient> {
  if (client) return client;
  const savedSession = loadTelegramSession();
  client = await createClient(savedSession);
  return client;
}

export async function getTelegramClient(): Promise<TelegramClient> {
  return ensureClient();
}

export async function startTelegramLogin(phone: string): Promise<void> {
  if (status === 'awaiting_code' || status === 'awaiting_password') {
    return;
  }

  phoneNumber = phone;
  lastError = null;
  reauthRequired = false;
  status = 'awaiting_code';

  // Clear any existing session and client to start fresh
  if (client) {
    try {
      await client.disconnect();
    } catch {
      // Ignore
    }
    client = null;
  }
  clearTelegramSession();

  const nextClient = await createClient();

  const codePromise = new Promise<string>((resolve) => {
    codeResolver = resolve;
  });

  const passwordPromise = new Promise<string>((resolve) => {
    passwordResolver = resolve;
  });

  // Don't set global client until auth succeeds to avoid race conditions
  void nextClient
    .start({
      phoneNumber: async () => phoneNumber ?? phone,
      phoneCode: async () => {
        status = 'awaiting_code';
        return codePromise;
      },
      password: async () => {
        status = 'awaiting_password';
        return passwordPromise;
      },
      onError: (err) => {
        void recordError('start_login', err);
      },
    })
    .then(() => {
      // Only set global client after successful authentication
      client = nextClient;
      const sessionString = (nextClient.session as StringSession).save();
      saveTelegramSession(sessionString);
      status = 'authorized';
      reauthRequired = false;
    })
    .catch((err) => {
      void recordError('start_login', err);
    });
}

export function submitTelegramCode(code: string): void {
  if (!codeResolver) {
    throw new Error('No pending code request.');
  }
  codeResolver(code);
  codeResolver = null;
}

export function submitTelegramPassword(password: string): void {
  if (!passwordResolver) {
    throw new Error('No pending password request.');
  }
  passwordResolver(password);
  passwordResolver = null;
}

export async function getTelegramStatus(): Promise<{
  status: TelegramStatus;
  phone: string | null;
  lastError: string | null;
  reauthRequired: boolean;
}> {
  if (status === 'disconnected') {
    try {
      const nextClient = await ensureClient();
      const me = await nextClient.getMe();
      if (me) {
        status = 'authorized';
        reauthRequired = false;
      }
    } catch (err) {
      if (loadTelegramSession()) {
        await recordError('status_check', err);
      }
    }
  }

  return { status, phone: phoneNumber, lastError, reauthRequired };
}

export async function logoutTelegram(): Promise<void> {
  if (client) {
    try {
      const maybeLogOut = (client as { logOut?: () => Promise<void> }).logOut;
      if (maybeLogOut) {
        await maybeLogOut();
      } else {
        await client.invoke(new Api.auth.LogOut());
      }
    } catch {
      // Ignore
    }
    try {
      await client.disconnect();
    } catch {
      // Ignore
    }
  }
  client = null;
  phoneNumber = null;
  lastError = null;
  reauthRequired = false;
  status = 'disconnected';
  clearTelegramSession();
}
