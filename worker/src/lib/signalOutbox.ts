/**
 * signalOutbox.ts
 *
 * Forwarder-side local spool for signal events that could not be written to
 * Firestore. Without it, a Firestore outage at the moment a signal arrives
 * loses the event for good (Telegram does not redeliver it).
 *
 * - JSON lines file, mode 0600, at SIGNAL_OUTBOX_PATH (default: next to the
 *   Telegram session file, else `<cwd>/../.data/signal_outbox.jsonl`). It holds
 *   signal content and ids only, never credentials.
 * - Strict FIFO. While the outbox is not empty, new events are appended behind
 *   it instead of being written directly, so a later revision or cancel can
 *   never reach Firestore before the signal it refers to.
 * - Flushing writes each entry with create(): ALREADY_EXISTS counts as
 *   delivered, so a crash between the write and the file rewrite only causes a
 *   harmless second create. The first other failure stops the flush.
 * - Bounded at SIGNAL_OUTBOX_MAX entries (default 5000). When full, new events
 *   are refused (returned false) and logged, rather than dropping older ones.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface OutboxEntry {
  doc_id: string;
  data: Record<string, unknown>;
  spooled_at: string;
  attempts: number;
  last_error?: string;
}

const DEFAULT_MAX = 5000;

export function getOutboxPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SIGNAL_OUTBOX_PATH) return path.resolve(env.SIGNAL_OUTBOX_PATH);
  if (env.TELEGRAM_SESSION_PATH) return path.join(path.dirname(path.resolve(env.TELEGRAM_SESSION_PATH)), 'signal_outbox.jsonl');
  return path.resolve(process.cwd(), '..', '.data', 'signal_outbox.jsonl');
}

export function getOutboxMax(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SIGNAL_OUTBOX_MAX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX;
}

function isEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.doc_id === 'string' && !!v.data && typeof v.data === 'object' && typeof v.spooled_at === 'string';
}

/** Reads the outbox. Corrupt lines are skipped and reported through `onCorrupt`. Missing file → []. */
export function readOutbox(filePath = getOutboxPath(), onCorrupt?: (line: number) => void): OutboxEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: OutboxEntry[] = [];
  raw.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEntry(parsed)) out.push({ ...parsed, attempts: typeof parsed.attempts === 'number' ? parsed.attempts : 0 });
      else onCorrupt?.(i + 1);
    } catch {
      onCorrupt?.(i + 1);
    }
  });
  return out;
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

/** Appends one entry and fsyncs. Throws on I/O failure. */
export function appendOutbox(entry: OutboxEntry, filePath = getOutboxPath()): void {
  ensureDir(filePath);
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Replaces the outbox atomically (temp file + rename). An empty list removes the file. */
export function writeOutbox(entries: OutboxEntry[], filePath = getOutboxPath()): void {
  if (entries.length === 0) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return;
  }
  ensureDir(filePath);
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}
