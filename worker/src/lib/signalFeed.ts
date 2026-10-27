/**
 * signalFeed.ts
 *
 * AutoTrader-side consumer of the `signal_events` Firestore collection that the
 * forwarder publishes to. Decouples MT5 execution from the Telegram listener so
 * the two services can be deployed and restarted independently.
 *
 * Durable queue (rules in signalQueue.ts). Every event carries its processing
 * state in `autotrader` on its own document, so nothing that matters lives in
 * memory:
 *  - Intake: events are read by `created_at` from a cursor persisted in
 *    `autotrader_state/signal_feed`. An event without a queue status (written by
 *    an older forwarder) is adopted as `pending`. The current forwarder writes
 *    `pending` itself, so the active-status query below finds its events no
 *    matter how long the AutoTrader was down. Without a stored cursor the first
 *    start looks back SIGNAL_FEED_LOOKBACK_MS (10 min).
 *  - Work: unfinished events (`pending`, `retry_wait`, `processing`) are read in
 *    `created_at` order. Per trade set key, only the earliest unfinished event is
 *    eligible, so a revision or cancel never overtakes the signal it refers to.
 *  - Claim: a transaction moves the event to `processing` with a lease
 *    (SIGNAL_FEED_LEASE_MS, renewed while running). Two AutoTraders cannot both
 *    hold it. A lease that expires (worker died) makes the event claimable again.
 *  - Completion is fenced by the lease id: a worker that lost its lease does not
 *    overwrite the new owner's state.
 *  - Transient engine results (`retry`) back off exponentially with jitter up to
 *    SIGNAL_FEED_MAX_ATTEMPTS, then the event becomes `dead_letter`, raises an
 *    alert, and waits for the operator (requeue or discard on the dashboard).
 *
 * Re-running an event is safe: the engine claims `trade_sets/{chatId}_{messageId}`
 * atomically, and uncertain broker mutations are terminal engine outcomes
 * (SUBMIT_UNKNOWN, revision/cancel ambiguous) that the reconciler resolves. This
 * module never retries those.
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { raiseAlert, resolveAlert } from './alerts';
import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';
import { getMt5Config } from './mt5Secrets';
import { handleSignalEvent } from './mt5TradeEngine';
import type { HandleResult, SignalEventInput } from './mt5TradeEngine';
import {
  ACTIVE_QUEUE_STATUSES,
  DEFAULT_QUEUE_OPTIONS,
  appendHistory,
  backoffDelayMs,
  claimDecision,
  compareQueueDocs,
  initialQueueState,
  readQueueState,
  selectEligible,
  truncateText,
} from './signalQueue';
import type { QueueAttemptRecord, QueueDocView, QueueOptions, SignalQueueState } from './signalQueue';
import { writeSystemLog } from './systemLog';
import { stripUndefined } from './tradeSetStore';
import type { GoldSignal } from './vipSignalParser';

const COLLECTION = 'signal_events';
const STATE_COLLECTION = 'autotrader_state';
const CURSOR_DOC = 'signal_feed';
const INTAKE_PAGE = 100;
const ACTIVE_PAGE = 200;
const UNORDERED_PAGE = 1000;
const MAX_HANDLED_PER_TICK = 25;
const DEFAULT_INTERVAL_MS = 3_000;
const DEFAULT_LOOKBACK_MS = 10 * 60_000;
const DEAD_LETTER_SCAN_MS = 60_000;
const BACKLOG_ALERT_MS = 5 * 60_000;
const FAILED_PRECONDITION_CODE = 9;

export type SignalEventDoc = {
  chat_id?: string;
  message_id?: string;
  message_type?: string;
  text_hash?: string;
  kind?: string;
  signal?: GoldSignal | null;
  message_date?: string | null;
  cancel_reason?: string;
  trigger_message_id?: string;
  created_at?: string;
  autotrader?: unknown;
};

export type FeedDispatchResult = HandleResult | { outcome: 'ignored'; reason: string };

export interface SignalFeedOptions {
  workerId?: string;
  queue?: Partial<QueueOptions>;
  lookbackMs?: number;
  /** Jitter source in [0, 1). */
  rand?: () => number;
  /** Test seam: start from this cursor instead of the stored one or the lookback. */
  initialCursor?: string;
}

export interface SignalFeedStats {
  running: boolean;
  workerId: string;
  cursor: string | null;
  activeCount: number;
  oldestActiveCreatedAt: string | null;
  deadLetterCount: number | null;
  lastTickAt: string | null;
  lastError: string | null;
  orderedQuery: boolean;
}

export interface SignalFeed {
  tick(): Promise<boolean>;
  start(intervalMs?: number): void;
  stop(): void;
  isRunning(): boolean;
  stats(): SignalFeedStats;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): unknown {
  return err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
}

function isMissingIndex(err: unknown): boolean {
  const code = errorCode(err);
  if (code === FAILED_PRECONDITION_CODE || code === 'failed-precondition') return true;
  const msg = errorMessage(err);
  return msg.includes('FAILED_PRECONDITION') || msg.includes('requires an index');
}

/**
 * Maps a stored signal_events document to the engine input and dispatches it.
 * Events from chats that are not configured sources are ignored (no trade set).
 */
export async function dispatchSignalEvent(
  data: SignalEventDoc,
  sourceChatIds: string[],
  docId?: string,
): Promise<FeedDispatchResult> {
  const chatId = String(data.chat_id ?? '');
  const messageId = String(data.message_id ?? '');
  if (!chatId || !messageId) return { outcome: 'ignored', reason: 'missing_ids' };
  if (!sourceChatIds.includes(chatId)) return { outcome: 'ignored', reason: 'chat_not_configured' };

  const kind = data.kind === 'cancel' ? 'cancel' : data.kind === 'signal' ? 'signal' : null;
  if (!kind) return { outcome: 'ignored', reason: 'unknown_kind' };

  const textHash = typeof data.text_hash === 'string' ? data.text_hash : undefined;
  const input: SignalEventInput = {
    eventId: docId ?? `${chatId}_${messageId}_${textHash ?? ''}`,
    chatId,
    messageId,
    messageDate: typeof data.message_date === 'string' ? data.message_date : null,
    messageType: data.message_type === 'edit' ? 'edit' : 'new',
    kind,
    signal: kind === 'signal' ? (data.signal ?? null) : null,
    cancelReason:
      data.cancel_reason === 'unparseable_edit' || data.cancel_reason === 'explicit_cancel'
        ? data.cancel_reason
        : undefined,
    textHash,
  };
  return handleSignalEvent(input);
}

interface Claimed {
  leaseId: string;
  attempts: number;
  state: SignalQueueState;
  data: SignalEventDoc;
}

type ClaimResult = { kind: 'claimed'; claimed: Claimed } | { kind: 'dead_letter'; state: SignalQueueState } | { kind: 'skipped' };

export function createSignalFeed(options: SignalFeedOptions = {}): SignalFeed {
  const workerId = options.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const queue: QueueOptions = { ...DEFAULT_QUEUE_OPTIONS, ...(options.queue ?? {}) };
  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const rand = options.rand ?? Math.random;

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cursor: string | null = options.initialCursor ?? null;
  let cursorIds = new Set<string>();
  let lastDeadLetterScanMs = 0;
  const stats: SignalFeedStats = {
    running: false,
    workerId,
    cursor: null,
    activeCount: 0,
    oldestActiveCreatedAt: null,
    deadLetterCount: null,
    lastTickAt: null,
    lastError: null,
    orderedQuery: true,
  };

  function db(): FirebaseFirestore.Firestore | null {
    return initFirestore();
  }

  async function ensureCursor(firestore: FirebaseFirestore.Firestore): Promise<void> {
    if (cursor !== null) return;
    // A read failure throws: falling back to the lookback here could skip events.
    const snap = await firestore.collection(STATE_COLLECTION).doc(CURSOR_DOC).get();
    const stored = snap.exists ? (snap.data() as { cursor?: unknown; cursor_ids?: unknown }) : null;
    if (stored && typeof stored.cursor === 'string' && Number.isFinite(Date.parse(stored.cursor))) {
      cursor = stored.cursor;
      cursorIds = new Set(Array.isArray(stored.cursor_ids) ? stored.cursor_ids.filter((x): x is string => typeof x === 'string') : []);
      logger.info('signal_feed_cursor_restored', { cursor });
    } else {
      cursor = new Date(Date.now() - lookbackMs).toISOString();
      cursorIds = new Set();
      logger.info('signal_feed_cursor_initialized', { cursor, lookbackMs });
    }
    stats.cursor = cursor;
  }

  async function adopt(firestore: FirebaseFirestore.Firestore, docId: string): Promise<void> {
    const ref = firestore.collection(COLLECTION).doc(docId);
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const raw = snap.get('autotrader') as Record<string, unknown> | undefined;
      if (raw && typeof raw === 'object' && 'status' in raw) return;
      const at = new Date().toISOString();
      tx.update(ref, { autotrader: { ...initialQueueState(at), adopted: true } });
    });
  }

  /** Adopts status-less events after the cursor and advances it. Returns true when the page was full. */
  async function intake(firestore: FirebaseFirestore.Firestore): Promise<boolean> {
    const from = cursor as string;
    const snap = await firestore
      .collection(COLLECTION)
      .where('created_at', '>=', from)
      .orderBy('created_at', 'asc')
      .limit(INTAKE_PAGE)
      .get();

    let nextCursor = from;
    let nextIds = new Set(cursorIds);
    for (const doc of snap.docs) {
      const createdAt = doc.get('created_at') as string | undefined;
      if (typeof createdAt !== 'string') continue;
      if (createdAt === from && cursorIds.has(doc.id)) continue;
      const raw = doc.get('autotrader') as Record<string, unknown> | undefined;
      if (!raw || typeof raw !== 'object' || !('status' in raw)) {
        // Stops at the first failure so the cursor never passes an event that was not adopted.
        await adopt(firestore, doc.id);
      }
      if (createdAt > nextCursor) {
        nextCursor = createdAt;
        nextIds = new Set([doc.id]);
      } else {
        nextIds.add(doc.id);
      }
    }

    if (nextCursor !== cursor || nextIds.size !== cursorIds.size) {
      cursor = nextCursor;
      cursorIds = nextIds;
      stats.cursor = cursor;
      try {
        await firestore
          .collection(STATE_COLLECTION)
          .doc(CURSOR_DOC)
          .set({ cursor, cursor_ids: [...cursorIds].slice(-200), updated_at: new Date().toISOString(), worker_id: workerId });
      } catch (err) {
        // Not fatal: on restart the older stored cursor re-reads events, and adoption is idempotent.
        logger.warn('signal_feed_cursor_persist_failed', { error: errorMessage(err) });
      }
    }
    return snap.size >= INTAKE_PAGE;
  }

  async function fetchActive(firestore: FirebaseFirestore.Firestore): Promise<{ docs: Array<QueueDocView & SignalEventDoc>; truncated: boolean } | null> {
    const toView = (doc: FirebaseFirestore.QueryDocumentSnapshot): QueueDocView & SignalEventDoc => ({
      ...(doc.data() as SignalEventDoc),
      id: doc.id,
    });
    try {
      const snap = await firestore
        .collection(COLLECTION)
        .where('autotrader.status', 'in', [...ACTIVE_QUEUE_STATUSES])
        .orderBy('created_at', 'asc')
        .limit(ACTIVE_PAGE)
        .get();
      stats.orderedQuery = true;
      return { docs: snap.docs.map(toView), truncated: snap.size >= ACTIVE_PAGE };
    } catch (err) {
      if (!isMissingIndex(err)) throw err;
      // The composite index (firestore.indexes.json) is missing. Without it order is only exact
      // when every unfinished event fits in one unordered read.
      stats.orderedQuery = false;
      const snap = await firestore
        .collection(COLLECTION)
        .where('autotrader.status', 'in', [...ACTIVE_QUEUE_STATUSES])
        .limit(UNORDERED_PAGE)
        .get();
      if (snap.size >= UNORDERED_PAGE) {
        logger.error('signal_feed_order_unknown', { reason: 'missing_index_and_large_backlog' });
        await raiseAlert({
          type: 'signal_backlog',
          subject: 'ordering',
          severity: 'critical',
          source: 'autotrader',
          title: 'Signal queue cannot be processed in order',
          message: `More than ${UNORDERED_PAGE} unfinished signal events and the signal_events (autotrader.status, created_at) index is missing. Processing is paused.`,
          action: 'Deploy firestore.indexes.json (firebase deploy --only firestore:indexes). Processing resumes automatically.',
        });
        return null;
      }
      return { docs: snap.docs.map(toView), truncated: false };
    }
  }

  async function claim(firestore: FirebaseFirestore.Firestore, docId: string): Promise<ClaimResult> {
    const ref = firestore.collection(COLLECTION).doc(docId);
    const leaseId = randomUUID();
    return firestore.runTransaction(async (tx): Promise<ClaimResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'skipped' };
      const data = snap.data() as SignalEventDoc;
      const state = readQueueState(data.autotrader);
      const now = Date.now();
      const decision = claimDecision(state, now);
      if (!state || !decision.claim) return { kind: 'skipped' };
      const at = new Date(now).toISOString();
      let history = state.history;
      if (decision.reason === 'lease_expired') {
        history = appendHistory(history, {
          attempt: state.attempts,
          at,
          result: 'lease_expired',
          detail: `lease of ${state.lease_owner ?? 'unknown'} expired`,
        });
      }
      if (state.attempts >= queue.maxAttempts) {
        const dead: SignalQueueState = {
          ...state,
          status: 'dead_letter',
          lease_id: null,
          lease_owner: null,
          lease_expires_at: null,
          reason: 'max_attempts',
          last_error: state.last_error ?? 'lease expired on the final attempt',
          dead_lettered_at: at,
          updated_at: at,
          history: appendHistory(history, { attempt: state.attempts, at, result: 'dead_letter', detail: 'max_attempts' }),
        };
        tx.update(ref, { autotrader: stripUndefined(dead) });
        return { kind: 'dead_letter', state: dead };
      }
      const next: SignalQueueState = {
        ...state,
        status: 'processing',
        attempts: state.attempts + 1,
        lease_id: leaseId,
        lease_owner: workerId,
        lease_expires_at: new Date(now + queue.leaseMs).toISOString(),
        updated_at: at,
        ...(history ? { history } : {}),
      };
      tx.update(ref, { autotrader: stripUndefined(next) });
      return { kind: 'claimed', claimed: { leaseId, attempts: next.attempts, state: next, data } };
    });
  }

  async function renewLease(firestore: FirebaseFirestore.Firestore, docId: string, leaseId: string): Promise<void> {
    const ref = firestore.collection(COLLECTION).doc(docId);
    try {
      await firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const state = readQueueState(snap.get('autotrader'));
        if (!state || state.status !== 'processing' || state.lease_id !== leaseId) return;
        tx.update(ref, {
          'autotrader.lease_expires_at': new Date(Date.now() + queue.leaseMs).toISOString(),
          'autotrader.updated_at': new Date().toISOString(),
        });
      });
    } catch (err) {
      logger.warn('signal_event_lease_renew_failed', { docId, error: errorMessage(err) });
    }
  }

  /** Writes the outcome if this worker still holds the lease. Returns false when the lease was lost. */
  async function complete(
    firestore: FirebaseFirestore.Firestore,
    docId: string,
    leaseId: string,
    build: (state: SignalQueueState) => SignalQueueState,
  ): Promise<SignalQueueState | null> {
    const ref = firestore.collection(COLLECTION).doc(docId);
    return firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const state = readQueueState(snap.get('autotrader'));
      if (!state || state.status !== 'processing' || state.lease_id !== leaseId) return null;
      const next = build(state);
      tx.update(ref, { autotrader: stripUndefined(next) });
      return next;
    });
  }

  async function reportDeadLetter(docId: string, state: SignalQueueState, data: SignalEventDoc | null): Promise<void> {
    const details = {
      docId,
      attempts: state.attempts,
      last_error: state.last_error ?? null,
      kind: data?.kind ?? null,
      chat_id: data?.chat_id ?? null,
      message_id: data?.message_id ?? null,
    };
    logger.error('signal_event_dead_lettered', details);
    await writeSystemLog('error', 'signal_feed', 'signal_event_dead_lettered', details);
    await raiseAlert({
      type: 'signal_dead_letter',
      subject: docId,
      severity: 'error',
      source: 'autotrader',
      title: `Signal event not executed after ${state.attempts} attempts`,
      message: `Event ${docId} (${data?.kind ?? 'unknown'}) failed: ${state.last_error ?? 'unknown error'}`,
      details,
    });
  }

  async function handleOne(firestore: FirebaseFirestore.Firestore, docId: string, sourceChatIds: string[]): Promise<void> {
    const claimed = await claim(firestore, docId);
    if (claimed.kind === 'skipped') return;
    if (claimed.kind === 'dead_letter') {
      await reportDeadLetter(docId, claimed.state, null);
      return;
    }
    const { leaseId, attempts, data } = claimed.claimed;

    const renewEvery = Math.max(1_000, Math.floor(queue.leaseMs / 3));
    const renewTimer = setInterval(() => void renewLease(firestore, docId, leaseId), renewEvery);
    renewTimer.unref?.();

    let result: FeedDispatchResult | null = null;
    let thrown: string | null = null;
    try {
      result = await dispatchSignalEvent(data, sourceChatIds, docId);
    } catch (err) {
      thrown = errorMessage(err);
    } finally {
      clearInterval(renewTimer);
    }

    const now = Date.now();
    const at = new Date(now).toISOString();
    const transient = thrown !== null || result?.outcome === 'retry';
    const errorText = thrown ?? (result && result.outcome === 'retry' ? (result.reason ?? 'retry') : null);
    const exhausted = transient && attempts >= queue.maxAttempts;
    const delay = transient && !exhausted ? backoffDelayMs(attempts, queue, rand()) : 0;

    const record: QueueAttemptRecord = {
      attempt: attempts,
      at,
      result: thrown !== null ? 'error' : transient ? 'retry' : result?.outcome === 'ignored' ? 'ignored' : 'done',
      ...(errorText ? { detail: errorText } : result?.reason ? { detail: result.reason } : {}),
    };

    let written: SignalQueueState | null;
    try {
      written = await complete(firestore, docId, leaseId, (state) => {
        const base: SignalQueueState = {
          ...state,
          lease_id: null,
          lease_owner: null,
          lease_expires_at: null,
          updated_at: at,
          history: appendHistory(state.history, record),
        };
        if (!transient && result) {
          return {
            ...base,
            status: result.outcome === 'ignored' ? 'ignored' : 'done',
            outcome: result.outcome,
            ...(('state' in result && result.state) ? { state: result.state } : {}),
            ...(result.reason ? { reason: truncateText(result.reason) } : {}),
            processed_at: at,
            next_attempt_at: null,
          };
        }
        if (exhausted) {
          return {
            ...base,
            status: 'dead_letter',
            reason: 'max_attempts',
            last_error: truncateText(errorText ?? 'retry'),
            dead_lettered_at: at,
            next_attempt_at: null,
          };
        }
        return {
          ...base,
          status: 'retry_wait',
          last_error: truncateText(errorText ?? 'retry'),
          next_attempt_at: new Date(now + delay).toISOString(),
        };
      });
    } catch (err) {
      // The lease expires and another attempt re-runs the event; the engine makes that safe.
      logger.error('signal_event_status_write_failed', { docId, attempts, error: errorMessage(err) });
      return;
    }

    if (written === null) {
      logger.warn('signal_event_lease_lost', { docId, attempts, workerId });
      await writeSystemLog('warn', 'signal_feed', 'signal_event_lease_lost', { docId, attempts, workerId });
      return;
    }
    if (written.status === 'dead_letter') {
      await reportDeadLetter(docId, written, data);
    } else if (written.status === 'retry_wait') {
      const details = { docId, attempts, delay_ms: delay, last_error: written.last_error ?? null };
      logger.warn('signal_event_retry_scheduled', details);
      await writeSystemLog('warn', 'signal_feed', 'signal_event_retry_scheduled', details);
    }
  }

  async function scanDeadLetters(firestore: FirebaseFirestore.Firestore): Promise<void> {
    if (Date.now() - lastDeadLetterScanMs < DEAD_LETTER_SCAN_MS) return;
    lastDeadLetterScanMs = Date.now();
    try {
      const snap = await firestore.collection(COLLECTION).where('autotrader.status', '==', 'dead_letter').limit(100).get();
      stats.deadLetterCount = snap.size;
    } catch (err) {
      logger.warn('signal_feed_dead_letter_scan_failed', { error: errorMessage(err) });
    }
  }

  async function checkBacklog(oldest: string | null): Promise<void> {
    const ageMs = oldest ? Date.now() - Date.parse(oldest) : 0;
    if (oldest && Number.isFinite(ageMs) && ageMs > BACKLOG_ALERT_MS) {
      await raiseAlert({
        type: 'signal_backlog',
        subject: 'age',
        severity: 'warning',
        source: 'autotrader',
        title: 'Signal events are waiting',
        message: `The oldest unfinished signal event was created ${Math.round(ageMs / 60_000)} min ago.`,
        details: { oldest_created_at: oldest },
      });
    } else {
      await resolveAlert('signal_backlog', 'age');
    }
  }

  async function tick(): Promise<boolean> {
    const firestore = db();
    if (!firestore) {
      stats.lastError = 'firestore_unavailable';
      return false;
    }
    try {
      const { sourceChatIds } = await getMt5Config();
      await ensureCursor(firestore);
      const intakeFull = await intake(firestore);
      const active = await fetchActive(firestore);
      if (!active) {
        stats.lastTickAt = new Date().toISOString();
        return false;
      }
      const sorted = [...active.docs].sort(compareQueueDocs);
      stats.activeCount = sorted.length;
      stats.oldestActiveCreatedAt = typeof sorted[0]?.created_at === 'string' ? sorted[0].created_at : null;

      const eligible = selectEligible(sorted, Date.now());
      let handled = 0;
      for (const doc of eligible) {
        if (handled >= MAX_HANDLED_PER_TICK) break;
        await handleOne(firestore, doc.id, sourceChatIds);
        handled += 1;
      }

      await scanDeadLetters(firestore);
      await checkBacklog(stats.oldestActiveCreatedAt);
      stats.lastTickAt = new Date().toISOString();
      stats.lastError = null;
      return intakeFull || active.truncated || eligible.length > handled;
    } catch (err) {
      stats.lastError = truncateText(errorMessage(err), 200);
      throw err;
    }
  }

  async function loop(intervalMs: number): Promise<void> {
    if (!running) return;
    let immediate = false;
    try {
      immediate = await tick();
    } catch (error) {
      logger.warn('signal_feed_tick_failed', { error: errorMessage(error) });
    } finally {
      if (running) {
        // More work waiting: poll again without the interval.
        timer = setTimeout(() => void loop(intervalMs), immediate ? 0 : intervalMs);
      }
    }
  }

  return {
    tick,
    start(intervalMs = DEFAULT_INTERVAL_MS) {
      if (running) return;
      running = true;
      stats.running = true;
      logger.info('signal_feed_started', { intervalMs, lookbackMs, workerId, maxAttempts: queue.maxAttempts, leaseMs: queue.leaseMs });
      void writeSystemLog('info', 'signal_feed', 'feed_started', { intervalMs, lookbackMs, workerId });
      timer = setTimeout(() => void loop(intervalMs), 0);
    },
    stop() {
      running = false;
      stats.running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    isRunning: () => running,
    stats: () => ({ ...stats }),
  };
}

// ---------------------------------------------------------------------------
// Process-wide feed used by autotrader.ts
// ---------------------------------------------------------------------------

let defaultFeed: SignalFeed | null = null;

function envOptions(): SignalFeedOptions {
  return {
    lookbackMs: positiveNumber(process.env.SIGNAL_FEED_LOOKBACK_MS, DEFAULT_LOOKBACK_MS),
    queue: {
      maxAttempts: positiveNumber(process.env.SIGNAL_FEED_MAX_ATTEMPTS, DEFAULT_QUEUE_OPTIONS.maxAttempts),
      leaseMs: positiveNumber(process.env.SIGNAL_FEED_LEASE_MS, DEFAULT_QUEUE_OPTIONS.leaseMs),
      baseDelayMs: positiveNumber(process.env.SIGNAL_FEED_RETRY_BASE_MS, DEFAULT_QUEUE_OPTIONS.baseDelayMs),
      maxDelayMs: positiveNumber(process.env.SIGNAL_FEED_RETRY_MAX_MS, DEFAULT_QUEUE_OPTIONS.maxDelayMs),
    },
  };
}

function feed(): SignalFeed {
  if (!defaultFeed) defaultFeed = createSignalFeed(envOptions());
  return defaultFeed;
}

/** One intake + work pass. Returns true when more work is waiting. */
export async function tickSignalFeed(): Promise<boolean> {
  return feed().tick();
}

export function startSignalFeed(): void {
  feed().start(positiveNumber(process.env.SIGNAL_FEED_INTERVAL_MS, DEFAULT_INTERVAL_MS));
}

export function stopSignalFeed(): void {
  defaultFeed?.stop();
  logger.info('signal_feed_stopped');
}

export function isSignalFeedRunning(): boolean {
  return defaultFeed?.isRunning() ?? false;
}

export function getSignalFeedStats(): SignalFeedStats | null {
  return defaultFeed ? defaultFeed.stats() : null;
}

/** Test seam: stops the process-wide feed and replaces it with a fresh one (a string sets the initial cursor). */
export function _resetSignalFeedForTests(options: SignalFeedOptions | string = {}): void {
  defaultFeed?.stop();
  const opts = typeof options === 'string' ? { initialCursor: options } : options;
  defaultFeed = createSignalFeed({ workerId: 'test-worker', rand: () => 0.5, ...opts });
}
