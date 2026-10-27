/**
 * alerts.ts
 *
 * Durable operator alerts in `alerts/{type__subject}` with deduplication,
 * severity escalation, acknowledgement (dashboard) and auto-resolution, plus
 * optional external notifications.
 *
 * Contract:
 *  - raiseAlert / resolveAlert never throw. A Firestore failure is logged, and
 *    the external notification (if configured) is still attempted, so an
 *    operator can hear about problems that also take Firestore down.
 *  - One document per condition. A repeat raise of an open or acknowledged
 *    alert bumps `count` and `last_seen_at`; repeats within 60 s are coalesced
 *    in memory. A higher severity re-opens an acknowledged alert. A raise of a
 *    resolved alert re-opens it.
 *  - Every free-text field and `details` are passed through sanitizeDetails /
 *    redactSecrets before storage or notification.
 *
 * External notifications are off unless ALERT_NOTIFICATIONS=enabled and a
 * channel is configured:
 *   ALERT_WEBHOOK_URL                               POST JSON {source,type,severity,title,message,action,subject,at}
 *   ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID  Bot API sendMessage (a bot, not the forwarder's user session)
 *   ALERT_NOTIFY_MIN_SEVERITY                       default 'error'
 * A notification is sent when an alert opens, re-opens or escalates, at most
 * once per 15 minutes per alert. Notifications carry no `details`.
 */

import {
  ALERT_ACTIONS,
  alertDocId,
  isAlertSeverity,
  maxSeverity,
  redactSecrets,
  sanitizeDetails,
  severityRank,
} from './alertTypes';
import type { AlertDoc, AlertSeverity, AlertType } from './alertTypes';
import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';

export const ALERTS_COLLECTION = 'alerts';

const COALESCE_MS = 60_000;
const NOTIFY_INTERVAL_MS = 15 * 60_000;
const NOTIFY_TIMEOUT_MS = 5_000;
/** How long a local "resolved" memo suppresses resolve writes; another process may have re-opened it. */
const RESOLVED_MEMO_MS = 10 * 60_000;

export interface RaiseAlertInput {
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  /** Distinguishes instances of one type, for example a trade set id or ticket. */
  subject?: string;
  source: string;
  details?: Record<string, unknown>;
  /** Overrides the default operator action for the type. */
  action?: string;
}

interface MemoEntry {
  status: 'open' | 'resolved';
  severity: AlertSeverity;
  lastWriteMs: number;
  pendingCount: number;
}

const memo = new Map<string, MemoEntry>();
const lastNotifiedMs = new Map<string, number>();

type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
let fetcher: Fetcher | null = null;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nowIso(): string {
  return new Date().toISOString();
}

function clean(text: string, max: number): string {
  const red = redactSecrets(text);
  return red.length > max ? `${red.slice(0, max - 1)}…` : red;
}

export interface NotificationConfig {
  enabled: boolean;
  minSeverity: AlertSeverity;
  webhookUrl: string | null;
  telegramBotToken: string | null;
  telegramChatId: string | null;
}

export function getNotificationConfig(env: NodeJS.ProcessEnv = process.env): NotificationConfig {
  const minRaw = env.ALERT_NOTIFY_MIN_SEVERITY;
  const webhookUrl = env.ALERT_WEBHOOK_URL?.trim() || null;
  const telegramBotToken = env.ALERT_TELEGRAM_BOT_TOKEN?.trim() || null;
  const telegramChatId = env.ALERT_TELEGRAM_CHAT_ID?.trim() || null;
  const hasChannel = (webhookUrl !== null && /^https:\/\//i.test(webhookUrl)) || (telegramBotToken !== null && telegramChatId !== null);
  return {
    enabled: env.ALERT_NOTIFICATIONS === 'enabled' && hasChannel,
    minSeverity: isAlertSeverity(minRaw) ? minRaw : 'error',
    webhookUrl: webhookUrl && /^https:\/\//i.test(webhookUrl) ? webhookUrl : null,
    telegramBotToken,
    telegramChatId,
  };
}

/** Safe description for health output: which channels are on, never their values. */
export function describeNotificationConfig(): { enabled: boolean; minSeverity: AlertSeverity; channels: string[] } {
  const cfg = getNotificationConfig();
  const channels: string[] = [];
  if (cfg.webhookUrl) channels.push('webhook');
  if (cfg.telegramBotToken && cfg.telegramChatId) channels.push('telegram_bot');
  return { enabled: cfg.enabled, minSeverity: cfg.minSeverity, channels };
}

async function doFetch(url: string, body: unknown): Promise<boolean> {
  const f: Fetcher = fetcher ?? (globalThis.fetch as unknown as Fetcher);
  if (typeof f !== 'function') return false;
  try {
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

interface NotifyPayload {
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  action: string;
  subject: string;
  state: 'opened' | 'reopened' | 'escalated' | 'unrecorded';
}

/** Sends to the configured channels. Never throws; never logs channel URLs or tokens. */
async function notify(key: string, payload: NotifyPayload): Promise<void> {
  const cfg = getNotificationConfig();
  if (!cfg.enabled || severityRank(payload.severity) < severityRank(cfg.minSeverity)) return;
  const now = Date.now();
  const last = lastNotifiedMs.get(key);
  if (last !== undefined && now - last < NOTIFY_INTERVAL_MS && payload.state !== 'escalated') return;
  lastNotifiedMs.set(key, now);

  const at = nowIso();
  const results: Record<string, boolean> = {};
  if (cfg.webhookUrl) {
    results.webhook = await doFetch(cfg.webhookUrl, { source: 'bytrader', ...payload, at });
  }
  if (cfg.telegramBotToken && cfg.telegramChatId) {
    const text = [
      `[ByTrader ${payload.severity.toUpperCase()}] ${payload.title}`,
      payload.message,
      payload.subject ? `Subject: ${payload.subject}` : '',
      `Action: ${payload.action}`,
      payload.state === 'unrecorded' ? '(Firestore unavailable: this alert is not on the dashboard yet.)' : '',
    ]
      .filter(Boolean)
      .join('\n');
    results.telegram_bot = await doFetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      chat_id: cfg.telegramChatId,
      text: text.slice(0, 3500),
      disable_web_page_preview: true,
    });
  }
  const failed = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) logger.warn('alert_notification_failed', { alert: key, channels: failed });
}

/**
 * Opens or refreshes the alert for (type, subject). Returns true when the alert
 * is recorded (or coalesced into a recent write). Never throws.
 */
export async function raiseAlert(input: RaiseAlertInput): Promise<boolean> {
  const subject = input.subject ?? '';
  const key = alertDocId(input.type, subject);
  const title = clean(input.title, 200);
  const message = clean(input.message, 1000);
  const action = clean(input.action ?? ALERT_ACTIONS[input.type], 1000);
  const details = sanitizeDetails(input.details);
  const now = Date.now();

  const known = memo.get(key);
  if (
    known &&
    known.status === 'open' &&
    now - known.lastWriteMs < COALESCE_MS &&
    severityRank(input.severity) <= severityRank(known.severity)
  ) {
    known.pendingCount += 1;
    return true;
  }

  const firestore = initFirestore();
  if (!firestore) {
    logger.error('alert_not_recorded', { alert: key, severity: input.severity, reason: 'firestore_unavailable' });
    await notify(key, { type: input.type, severity: input.severity, title, message, action, subject, state: 'unrecorded' });
    return false;
  }

  const ref = firestore.collection(ALERTS_COLLECTION).doc(key);
  const at = nowIso();
  const extraCount = known?.pendingCount ?? 0;
  try {
    const outcome = await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? (snap.data() as Partial<AlertDoc>) : null;
      if (!current) {
        const doc: AlertDoc = {
          type: input.type,
          subject,
          severity: input.severity,
          status: 'open',
          title,
          message,
          action,
          source: input.source,
          details,
          count: 1 + extraCount,
          first_seen_at: at,
          last_seen_at: at,
          opened_at: at,
          reopened_count: 0,
          acknowledged_by: null,
          acknowledged_at: null,
          resolved_at: null,
          resolved_by: null,
          resolution: null,
          updated_at: at,
        };
        tx.set(ref, doc);
        return { state: 'opened' as const, severity: input.severity };
      }
      const prevSeverity: AlertSeverity = isAlertSeverity(current.severity) ? current.severity : 'info';
      const severity = maxSeverity(prevSeverity, input.severity);
      const escalated = severityRank(input.severity) > severityRank(prevSeverity);
      const count = (typeof current.count === 'number' ? current.count : 0) + 1 + extraCount;
      if (current.status === 'resolved') {
        tx.set(ref, {
          ...current,
          severity: input.severity,
          status: 'open',
          title,
          message,
          action,
          source: input.source,
          details,
          count,
          last_seen_at: at,
          opened_at: at,
          reopened_count: (current.reopened_count ?? 0) + 1,
          acknowledged_by: null,
          acknowledged_at: null,
          resolved_at: null,
          resolved_by: null,
          resolution: null,
          updated_at: at,
        });
        return { state: 'reopened' as const, severity: input.severity };
      }
      const reopenAck = current.status === 'acknowledged' && escalated;
      tx.set(
        ref,
        {
          severity,
          title,
          message,
          details,
          count,
          last_seen_at: at,
          updated_at: at,
          ...(reopenAck ? { status: 'open', acknowledged_by: null, acknowledged_at: null } : {}),
        },
        { merge: true },
      );
      return { state: escalated ? ('escalated' as const) : ('refreshed' as const), severity };
    });
    memo.set(key, { status: 'open', severity: outcome.severity, lastWriteMs: now, pendingCount: 0 });
    if (outcome.state !== 'refreshed') {
      logger.warn('alert_raised', { alert: key, severity: outcome.severity, state: outcome.state });
      await notify(key, { type: input.type, severity: outcome.severity, title, message, action, subject, state: outcome.state });
    }
    return true;
  } catch (err) {
    logger.error('alert_write_failed', { alert: key, error: errorMessage(err) });
    await notify(key, { type: input.type, severity: input.severity, title, message, action, subject, state: 'unrecorded' });
    return false;
  }
}

/**
 * Resolves the alert for (type, subject) when its condition has cleared. Calls
 * for alerts known to be resolved (or never raised in this process and absent)
 * do not write. Never throws.
 */
export async function resolveAlert(type: AlertType, subject = '', resolution = 'condition_cleared'): Promise<boolean> {
  const key = alertDocId(type, subject);
  const known = memo.get(key);
  if (known && known.status === 'resolved' && Date.now() - known.lastWriteMs < RESOLVED_MEMO_MS) return true;

  const firestore = initFirestore();
  if (!firestore) return false;
  const ref = firestore.collection(ALERTS_COLLECTION).doc(key);
  const at = nowIso();
  try {
    const changed = await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const current = snap.data() as Partial<AlertDoc>;
      if (current.status === 'resolved') return false;
      tx.set(
        ref,
        { status: 'resolved', resolved_at: at, resolved_by: 'system', resolution: clean(resolution, 200), updated_at: at },
        { merge: true },
      );
      return true;
    });
    memo.set(key, { status: 'resolved', severity: known?.severity ?? 'info', lastWriteMs: Date.now(), pendingCount: 0 });
    if (changed) logger.info('alert_resolved', { alert: key, resolution });
    return true;
  } catch (err) {
    logger.warn('alert_resolve_failed', { alert: key, error: errorMessage(err) });
    return false;
  }
}

/** Test seam: clears coalescing and notification memory, and optionally replaces fetch. */
export function _resetAlertsForTests(f: Fetcher | null = null): void {
  memo.clear();
  lastNotifiedMs.clear();
  fetcher = f;
}
