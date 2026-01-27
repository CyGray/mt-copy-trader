import fs from 'fs';
import path from 'path';
import { decryptText, encryptText } from './crypto';

const DEFAULT_SESSION_PATH = path.resolve(
  process.cwd(),
  'worker',
  'data',
  'telegram.session.enc',
);

function getSessionPath(): string {
  return process.env.TELEGRAM_SESSION_PATH ?? DEFAULT_SESSION_PATH;
}

export function loadTelegramSession(): string | null {
  const sessionPath = getSessionPath();
  if (!fs.existsSync(sessionPath)) return null;
  const encrypted = fs.readFileSync(sessionPath, 'utf8');
  return decryptText(encrypted);
}

export function saveTelegramSession(session: string): void {
  const sessionPath = getSessionPath();
  const dir = path.dirname(sessionPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const encrypted = encryptText(session);
  fs.writeFileSync(sessionPath, encrypted, 'utf8');
}

export function clearTelegramSession(): void {
  const sessionPath = getSessionPath();
  if (fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
  }
}
