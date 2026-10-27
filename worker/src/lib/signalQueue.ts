/**
 * signalQueue.ts
 *
 * Pure rules for the durable signal-event queue (no imports, no I/O). The
 * AutoTrader's signal feed applies them to `signal_events/{id}.autotrader`, and
 * the web dashboard imports them (via `@shared/signalQueue`) for operator
 * recovery, so both sides agree on what a status means.
 *
 * Status lifecycle (stored in `autotrader.status`):
 *
 *   pending ──claim──▶ processing ──▶ done | ignored
 *      ▲                   │
 *      │                   ├──transient──▶ retry_wait ──(next_attempt_at)──▶ claim again
 *      │                   ├──lease expired (worker died)──▶ claim again
 *      │                   └──attempts exhausted──▶ dead_letter
 *      └──────────────── operator requeue ◀───────────────── dead_letter ──▶ discarded
 *
 * Ordering: events are keyed by trade set (`chat_id` + `message_id`; a reply
 * cancel carries the target signal's message id). A key's events are handled in
 * `created_at` order: while an earlier event of the key is unfinished, later
 * ones wait. Terminal events (done, ignored, dead_letter, discarded) do not
 * block, so one poisoned event cannot hold back a later cancel forever.
 *
 * Safety: a retry re-runs the engine for the same event id. The engine's trade
 * set claim makes that idempotent, and an uncertain broker mutation is a
 * terminal engine outcome (SUBMIT_UNKNOWN, revision/cancel ambiguous), so it is
 * never retried here; the reconciler resolves it from broker state.
 */

export type SignalQueueStatus =
  | 'pending'
  | 'processing'
  | 'retry_wait'
  | 'done'
  | 'ignored'
  | 'dead_letter'
  | 'discarded';

export const ACTIVE_QUEUE_STATUSES: readonly SignalQueueStatus[] = ['pending', 'processing', 'retry_wait'];
export const TERMINAL_QUEUE_STATUSES: readonly SignalQueueStatus[] = ['done', 'ignored', 'dead_letter', 'discarded'];

export interface QueueAttemptRecord {
  attempt: number;
  at: string;
  result: 'done' | 'ignored' | 'retry' | 'error' | 'lease_expired' | 'dead_letter';
  detail?: string;
}

/** Shape of `signal_events/{id}.autotrader`. Older documents may lack fields. */
export interface SignalQueueState {
  status: SignalQueueStatus;
  attempts: number;
  next_attempt_at: string | null;
  lease_id: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  outcome?: string;
  state?: string;
  reason?: string;
  last_error?: string;
  processed_at?: string;
  dead_lettered_at?: string;
  updated_at: string;
  history?: QueueAttemptRecord[];
  requeue_count?: number;
  requeued_by?: string;
  requeued_at?: string;
  discarded_by?: string;
  discarded_at?: string;
  discard_note?: string;
}

export interface QueueOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  leaseMs: number;
}

export const DEFAULT_QUEUE_OPTIONS: QueueOptions = {
  maxAttempts: 8,
  baseDelayMs: 5_000,
  maxDelayMs: 5 * 60_000,
  leaseMs: 120_000,
};

export const MAX_HISTORY = 10;
const MAX_TEXT = 500;

/** Minimal view of a signal_events document needed by the rules. */
export interface QueueDocView {
  id: string;
  chat_id?: unknown;
  message_id?: unknown;
  created_at?: unknown;
  autotrader?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStatus(value: unknown): value is SignalQueueStatus {
  return (
    typeof value === 'string' &&
    (ACTIVE_QUEUE_STATUSES as readonly string[]).concat(TERMINAL_QUEUE_STATUSES as readonly string[]).includes(value)
  );
}

export function truncateText(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Reads `autotrader`. A missing or legacy status (for example the old `failed`) returns null. */
export function readQueueState(raw: unknown): SignalQueueState | null {
  if (!isRecord(raw) || !isStatus(raw.status)) return null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  return {
    ...(raw as Partial<SignalQueueState>),
    status: raw.status,
    attempts: typeof raw.attempts === 'number' && Number.isFinite(raw.attempts) ? raw.attempts : 0,
    next_attempt_at: str(raw.next_attempt_at),
    lease_id: str(raw.lease_id),
    lease_owner: str(raw.lease_owner),
    lease_expires_at: str(raw.lease_expires_at),
    updated_at: str(raw.updated_at) ?? '',
  };
}

/** The initial state the forwarder writes with each new event (and the feed writes when adopting one). */
export function initialQueueState(nowIso: string, nextAttemptAt: string = nowIso): SignalQueueState {
  return {
    status: 'pending',
    attempts: 0,
    next_attempt_at: nextAttemptAt,
    lease_id: null,
    lease_owner: null,
    lease_expires_at: null,
    updated_at: nowIso,
  };
}

/** Ordering key: events of one trade set are handled in created_at order. */
export function orderingKey(doc: Pick<QueueDocView, 'chat_id' | 'message_id' | 'id'>): string {
  const chat = doc.chat_id === undefined || doc.chat_id === null ? '' : String(doc.chat_id);
  const msg = doc.message_id === undefined || doc.message_id === null ? '' : String(doc.message_id);
  return chat && msg ? `${chat}_${msg}` : `doc:${doc.id}`;
}

function parseMs(iso: string | null | undefined): number {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : NaN;
}

export type ClaimDecision =
  | { claim: true; reason: 'due' | 'lease_expired' }
  | { claim: false; reason: 'terminal' | 'backing_off' | 'leased' | 'no_status' };

/** Whether a worker may take this event now. A live lease or a future next_attempt_at refuses. */
export function claimDecision(state: SignalQueueState | null, nowMs: number): ClaimDecision {
  if (!state) return { claim: false, reason: 'no_status' };
  if ((TERMINAL_QUEUE_STATUSES as readonly string[]).includes(state.status)) return { claim: false, reason: 'terminal' };
  if (state.status === 'processing') {
    const expires = parseMs(state.lease_expires_at);
    // A processing doc without a readable lease expiry is treated as expired: no worker can renew it.
    if (Number.isFinite(expires) && expires > nowMs) return { claim: false, reason: 'leased' };
    return { claim: true, reason: 'lease_expired' };
  }
  const next = parseMs(state.next_attempt_at);
  if (Number.isFinite(next) && next > nowMs) return { claim: false, reason: 'backing_off' };
  return { claim: true, reason: 'due' };
}

/**
 * Delay before attempt `attempts + 1`, after `attempts` failures: base * 2^(attempts-1), capped,
 * with ±20 % jitter so several workers do not retry in lockstep. `rand` is in [0, 1).
 */
export function backoffDelayMs(attempts: number, options: QueueOptions = DEFAULT_QUEUE_OPTIONS, rand = 0.5): number {
  const n = Math.max(1, Math.floor(attempts));
  const raw = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (n - 1));
  const jitter = 1 + (Math.min(Math.max(rand, 0), 1) - 0.5) * 0.4;
  return Math.max(options.baseDelayMs / 2, Math.round(raw * jitter));
}

function createdAtOf(doc: QueueDocView): string {
  return typeof doc.created_at === 'string' ? doc.created_at : '';
}

/** Stable created_at then id order (the same order the feed uses). */
export function compareQueueDocs(a: QueueDocView, b: QueueDocView): number {
  const ca = createdAtOf(a);
  const cb = createdAtOf(b);
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * From the unfinished events (any order), the ones a worker may claim now, in
 * handling order. An event is eligible when it is claimable and no earlier
 * unfinished event shares its key. At most one event per key is returned.
 */
export function selectEligible<T extends QueueDocView>(docs: readonly T[], nowMs: number): T[] {
  const sorted = [...docs].sort(compareQueueDocs);
  const blocked = new Set<string>();
  const out: T[] = [];
  for (const doc of sorted) {
    const state = readQueueState(doc.autotrader);
    if (!state || !(ACTIVE_QUEUE_STATUSES as readonly string[]).includes(state.status)) continue;
    const key = orderingKey(doc);
    if (blocked.has(key)) continue;
    blocked.add(key);
    if (claimDecision(state, nowMs).claim) out.push(doc);
  }
  return out;
}

export function appendHistory(
  history: QueueAttemptRecord[] | undefined,
  record: QueueAttemptRecord,
): QueueAttemptRecord[] {
  const next = [...(history ?? []), { ...record, ...(record.detail ? { detail: truncateText(record.detail) } : {}) }];
  return next.slice(-MAX_HISTORY);
}

export type RequeueRefusal =
  | 'not_dead_letter'
  | 'superseded'
  | 'later_event_in_progress';

/**
 * Whether an operator may put a dead-lettered event back in the queue. Refused
 * when a later event of the same trade set has already been handled or is being
 * handled, because replaying the older event would then act out of order (for
 * example re-applying an older stop loss). `laterSameKey` are the key's events
 * created after this one.
 */
export function requeueDecision(
  state: SignalQueueState | null,
  laterSameKey: ReadonlyArray<{ autotrader?: unknown }>,
): { ok: true } | { ok: false; reason: RequeueRefusal } {
  if (!state || state.status !== 'dead_letter') return { ok: false, reason: 'not_dead_letter' };
  for (const later of laterSameKey) {
    const s = readQueueState(later.autotrader);
    if (!s) continue;
    if (s.status === 'done' || s.status === 'ignored') return { ok: false, reason: 'superseded' };
    if (s.status === 'processing') return { ok: false, reason: 'later_event_in_progress' };
  }
  return { ok: true };
}

/** Patch an operator requeue applies to `autotrader` (merged over the existing state). */
export function requeuePatch(state: SignalQueueState, actor: string, nowIso: string): SignalQueueState {
  return {
    ...state,
    status: 'pending',
    attempts: 0,
    next_attempt_at: nowIso,
    lease_id: null,
    lease_owner: null,
    lease_expires_at: null,
    updated_at: nowIso,
    requeue_count: (state.requeue_count ?? 0) + 1,
    requeued_by: actor,
    requeued_at: nowIso,
  };
}

/** Patch an operator discard applies. Only a dead letter can be discarded. */
export function discardPatch(state: SignalQueueState, actor: string, nowIso: string, note?: string): SignalQueueState {
  return {
    ...state,
    status: 'discarded',
    lease_id: null,
    lease_owner: null,
    lease_expires_at: null,
    updated_at: nowIso,
    discarded_by: actor,
    discarded_at: nowIso,
    ...(note ? { discard_note: truncateText(note, 200) } : {}),
  };
}
