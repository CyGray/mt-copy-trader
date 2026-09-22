import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { clearTelegramSession, loadTelegramSession, saveTelegramSession } from './telegramSession';
import { writeSystemLog } from './systemLog';

export type TelegramStatus =
  | 'disconnected'
  | 'awaiting_code'
  | 'awaiting_qr'
  | 'awaiting_password'
  | 'authorized'
  | 'error';

type Resolver = (value: string) => void;

interface InputQueue {
  request(): Promise<string>;
  submit(value: string): void;
  reset(): void;
}

function createInputQueue(): InputQueue {
  let resolver: Resolver | null = null;
  let buffered: string | null = null;

  return {
    request(): Promise<string> {
      if (buffered !== null) {
        const value = buffered;
        buffered = null;
        return Promise.resolve(value);
      }
      return new Promise<string>((resolve) => {
        resolver = resolve;
      });
    },
    submit(value: string): void {
      if (resolver) {
        const resolve = resolver;
        resolver = null;
        resolve(value);
        return;
      }
      buffered = value;
    },
    reset(): void {
      resolver = null;
      buffered = null;
    },
  };
}

const RETRYABLE_AUTH_ERRORS = [
  'PHONE_CODE_INVALID',
  'PHONE_CODE_EMPTY',
  'PASSWORD_HASH_INVALID',
];

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

let client: TelegramClient | null = null;
let status: TelegramStatus = 'disconnected';
let lastError: string | null = null;
let reauthRequired = false;
let phoneNumber: string | null = null;
let qrLink: string | null = null;
let qrExpiresAt: string | null = null;
const codeInput = createInputQueue();
const passwordInput = createInputQueue();

async function recordError(context: string, error: unknown): Promise<void> {
  const message = errorMessageOf(error);
  lastError = message || 'telegram_error';

  if (isSessionExpired(error)) {
    clearTelegramSession();
    reauthRequired = true;
    status = 'disconnected';
    await writeSystemLog('warn', 'telegram', 'session_expired', {
      context,
      error: message || 'session_expired',
    });
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
  if (
    status === 'awaiting_code' ||
    status === 'awaiting_password' ||
    status === 'awaiting_qr'
  ) {
    return;
  }

  phoneNumber = phone;
  lastError = null;
  reauthRequired = false;
  status = 'awaiting_code';
  codeInput.reset();
  passwordInput.reset();

  const nextClient = await ensureClient();

  void nextClient
    .start({
      phoneNumber: async () => phoneNumber ?? phone,
      phoneCode: async () => {
        status = 'awaiting_code';
        return codeInput.request();
      },
      password: async () => {
        status = 'awaiting_password';
        return passwordInput.request();
      },
      onError: async (err) => {
        await recordError('start_login', err);
        const message = errorMessageOf(err);
        return !RETRYABLE_AUTH_ERRORS.some((code) => message.includes(code));
      },
    })
    .then(() => {
      const sessionString = (nextClient.session as StringSession).save();
      saveTelegramSession(sessionString);
      status = 'authorized';
      reauthRequired = false;
      lastError = null;
      codeInput.reset();
      passwordInput.reset();
    })
    .catch((err) => {
      void recordError('start_login', err);
    });
}

export interface QrLoginState {
  status: TelegramStatus;
  link: string | null;
  expiresAt: string | null;
  lastError: string | null;
  reauthRequired: boolean;
}

export async function startTelegramQrLogin(): Promise<void> {
  if (
    status === 'awaiting_qr' ||
    status === 'awaiting_code' ||
    status === 'awaiting_password' ||
    status === 'authorized'
  ) {
    return;
  }

  const { apiId, apiHash } = getApiConfig();
  lastError = null;
  reauthRequired = false;
  qrLink = null;
  qrExpiresAt = null;
  status = 'awaiting_qr';
  passwordInput.reset();

  const nextClient = await ensureClient();

  void nextClient
    .signInUserWithQrCode(
      { apiId, apiHash },
      {
        qrCode: async ({ token, expires }) => {
          qrLink = `tg://login?token=${token.toString('base64url')}`;
          qrExpiresAt = new Date(expires * 1000).toISOString();
          status = 'awaiting_qr';
        },
        password: async () => {
          status = 'awaiting_password';
          return passwordInput.request();
        },
        onError: async (err) => {
          await recordError('qr_login', err);
          const message = errorMessageOf(err);
          return !RETRYABLE_AUTH_ERRORS.some((code) => message.includes(code));
        },
      },
    )
    .then(() => {
      const sessionString = (nextClient.session as StringSession).save();
      saveTelegramSession(sessionString);
      status = 'authorized';
      reauthRequired = false;
      lastError = null;
      qrLink = null;
      qrExpiresAt = null;
      passwordInput.reset();
    })
    .catch((err) => {
      void recordError('qr_login', err);
    });
}

export function getQrLoginState(): QrLoginState {
  return {
    status,
    link: qrLink,
    expiresAt: qrExpiresAt,
    lastError,
    reauthRequired,
  };
}

export function submitTelegramCode(code: string): void {
  if (status !== 'awaiting_code') {
    throw new Error('No pending code request.');
  }
  codeInput.submit(code);
}

export function submitTelegramPassword(password: string): void {
  if (status !== 'awaiting_password') {
    throw new Error('No pending password request.');
  }
  passwordInput.submit(password);
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
        lastError = null;
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
  qrLink = null;
  qrExpiresAt = null;
  lastError = null;
  reauthRequired = false;
  status = 'disconnected';
  codeInput.reset();
  passwordInput.reset();
  clearTelegramSession();
}
