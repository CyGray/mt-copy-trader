/**
 * alertTypes.ts
 *
 * Pure definitions for operator alerts (no imports, no I/O). Shared by the
 * worker services, which raise and resolve alerts, and the web dashboard
 * (via `@shared/alertTypes`), which lists, acknowledges and resolves them.
 *
 * Document: `alerts/{alertDocId(type, subject)}`. One document per condition,
 * so a recurring problem increments `count` instead of creating new alerts.
 */

export type AlertSeverity = 'critical' | 'error' | 'warning' | 'info';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved';

export type AlertType =
  | 'bridge_disconnected'
  | 'terminal_disconnected'
  | 'ea_version_mismatch'
  | 'submit_unknown'
  | 'partial_close_failed'
  | 'sl_modify_failed'
  | 'protection_missing'
  | 'unknown_position'
  | 'reconciliation_failed'
  | 'firestore_unavailable'
  | 'config_invalid'
  | 'service_unhealthy'
  | 'signal_dead_letter'
  | 'signal_backlog'
  | 'signal_publish_failed'
  | 'close_all_failed'
  | 'clock_skew'
  | 'correlation_mismatch';

export interface AlertDoc {
  type: AlertType;
  subject: string;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  message: string;
  action: string;
  source: string;
  details: Record<string, unknown>;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
  opened_at: string;
  reopened_count?: number;
  acknowledged_by?: string | null;
  acknowledged_at?: string | null;
  resolved_at?: string | null;
  resolved_by?: string | null;
  resolution?: string | null;
  updated_at: string;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, error: 2, critical: 3 };

export const ALERT_SEVERITIES: readonly AlertSeverity[] = ['critical', 'error', 'warning', 'info'];

export function severityRank(severity: AlertSeverity): number {
  return SEVERITY_RANK[severity] ?? 0;
}

export function isAlertSeverity(value: unknown): value is AlertSeverity {
  return typeof value === 'string' && value in SEVERITY_RANK;
}

export function maxSeverity(a: AlertSeverity, b: AlertSeverity): AlertSeverity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

/** Deterministic id: `type__subject`, restricted to [A-Za-z0-9_.-] and 300 characters. */
export function alertDocId(type: AlertType, subject = ''): string {
  const clean = subject.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 200);
  return clean ? `${type}__${clean}` : type;
}

/** Operator guidance shown with each alert type. */
export const ALERT_ACTIONS: Record<AlertType, string> = {
  bridge_disconnected:
    'Check the MT5 terminal and VantageBridgeEA on the VPS (deploy/MT5_GUI.md). New entries are blocked while the bridge is down; broker-side SL/TP still protect open positions, but partial closes and SL moves are paused.',
  terminal_disconnected:
    'The MT5 terminal reports no broker connection. Check the terminal login and network. Partial closes and SL moves cannot run until it reconnects.',
  ea_version_mismatch:
    'The AutoTrader speaks bridge protocol v2. Attach VantageBridgeEA v2 (or roll the worker back) per VANTAGE_EXECUTION_GUIDE.md §17. Keep execution mode disabled until versions match.',
  submit_unknown:
    'An entry order was sent but its outcome is unknown. It is never resent. Check the MT5 terminal for a position or order with the trade set comment; the reconciler resolves it automatically when the bridge answers.',
  partial_close_failed:
    'A partial take-profit could not be closed after its retries. Close the checkpoint volume manually in MT5 if needed, then acknowledge.',
  sl_modify_failed:
    'A stop-loss move (break-even, trailing or after-checkpoint) failed repeatedly. Verify the position stop in MT5; the broker-side SL from the previous move still applies.',
  protection_missing:
    'A filled position could not be confirmed to carry its stop loss. Check the position in MT5 now and set the SL manually if it is missing.',
  unknown_position:
    'A position or order exists at the broker that no trade set owns. The AutoTrader never touches it. Decide manually whether to keep or close it.',
  reconciliation_failed:
    'Reconciliation against broker state is failing. Ambiguous orders and stale states are not being resolved. Check the bridge and Firestore.',
  firestore_unavailable:
    'Firestore was unreachable. New entries were blocked (fail closed) and state could not be recorded. Check credentials, network and Firebase status.',
  config_invalid:
    'Execution configuration is invalid, so new entries are blocked. Open Settings / Profiles, fix the reported fields, and re-activate a valid profile.',
  service_unhealthy:
    'A ByTrader service stopped reporting its heartbeat. Check `systemctl --user status` for the service and its logs (deploy/SERVICES.md).',
  signal_dead_letter:
    'A signal event exhausted its retries and was not executed. Review it under Signals; requeue it only if it is still relevant, or discard it.',
  signal_backlog:
    'Signal events are waiting longer than expected. Check the AutoTrader service, the bridge and Firestore.',
  signal_publish_failed:
    'The forwarder could not hand a signal event to Firestore and has spooled it locally; it retries automatically. If this persists, check Firestore access from the forwarder.',
  close_all_failed:
    'Emergency close-all did not close every owned position. Close the remaining positions manually in MT5. The kill switch stays engaged.',
  clock_skew:
    'The MT5 terminal clock (TimeGMT) and the worker clock disagree. New entries are refused until they agree within the limit. Check NTP on the VPS (timedatectl) and the terminal time; see mql5/PROTOCOL.md "Time bases".',
  correlation_mismatch:
    'The broker did not keep the order comment the AutoTrader uses to recognise its trades. Duplicate protection and SUBMIT_UNKNOWN resolution depend on it. Set execution mode to disabled and read docs/project_memory/VANTAGE_BROKER_ASSUMPTIONS.md (correlation fallback) before trading again.',
};

const SECRET_KEY_RE = /token|secret|passw|private|api[_-]?key|session|authorization|credential|cookie|otp|phone/i;
const SECRET_VALUE_RES: RegExp[] = [
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot token
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|pk|rk)_[A-Za-z0-9]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];

/** Masks credential-shaped substrings. Alerts and notifications pass every free-text field through this. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_VALUE_RES) out = out.replace(re, '[redacted]');
  return out;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return typeof value === 'number' && !Number.isFinite(value) ? null : value;
  }
  if (typeof value === 'string') {
    const red = redactSecrets(value);
    return red.length > 500 ? `${red.slice(0, 499)}…` : red;
  }
  if (depth >= 3) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeValue(v, depth + 1));
  if (value && typeof value === 'object') return sanitizeDetails(value as Record<string, unknown>, depth + 1);
  return undefined;
}

/**
 * Copy of `details` safe to store and display: keys that look like credentials are
 * dropped, strings are redacted and truncated, depth and size are bounded, and
 * undefined values are removed (Firestore rejects them).
 */
export function sanitizeDetails(details: Record<string, unknown> | undefined, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!details) return out;
  let n = 0;
  for (const [key, value] of Object.entries(details)) {
    if (n >= 30) break;
    if (SECRET_KEY_RE.test(key)) continue;
    const clean = sanitizeValue(value, depth);
    if (clean === undefined) continue;
    out[key] = clean;
    n += 1;
  }
  return out;
}
