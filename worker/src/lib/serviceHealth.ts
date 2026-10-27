/**
 * serviceHealth.ts
 *
 * Heartbeats in `service_status/{service}` and a watchdog on the other
 * service's heartbeat, shared by the forwarder and the AutoTrader. The two
 * services still communicate only through Firestore.
 *
 *  - Each service writes its heartbeat every HEARTBEAT_INTERVAL_MS (15 s) with a
 *    small, secret-free status payload (sanitizeDetails).
 *  - Each checks its peer: a heartbeat older than SERVICE_STALE_MS (default
 *    3 min) raises `service_unhealthy` (critical for the AutoTrader, error for
 *    the forwarder); a peer reporting `healthy: false` raises a warning. A
 *    missing peer document is not an alert (the peer may predate heartbeats).
 *  - Three consecutive failed heartbeat writes count as a Firestore outage. The
 *    alert is attempted at once (external notification still works without
 *    Firestore) and recorded on the dashboard when writes succeed again.
 */

import { hostname } from 'node:os';
import { raiseAlert, resolveAlert } from './alerts';
import { sanitizeDetails } from './alertTypes';
import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';

export const SERVICE_STATUS_COLLECTION = 'service_status';
export type ServiceName = 'autotrader' | 'forwarder';

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_STALE_MS = 3 * 60_000;
const FIRESTORE_FAILURES_BEFORE_ALERT = 3;

export interface HeartbeatPayload {
  healthy: boolean;
  issues: string[];
  details: Record<string, unknown>;
}

export interface HeartbeatDoc extends HeartbeatPayload {
  service: ServiceName;
  updated_at: string;
  started_at: string;
  pid: number;
  host: string;
  interval_ms: number;
}

export interface HeartbeatOptions {
  service: ServiceName;
  collect: () => Promise<HeartbeatPayload>;
  peer?: ServiceName;
  intervalMs?: number;
  staleMs?: number;
}

export interface Heartbeat {
  tick(): Promise<void>;
  start(): void;
  stop(): void;
  /** Consecutive failed heartbeat writes; > 0 means Firestore is failing for this service. */
  firestoreFailureStreak(): number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createHeartbeat(options: HeartbeatOptions): Heartbeat {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const staleMs = options.staleMs ?? (Number(process.env.SERVICE_STALE_MS) > 0 ? Number(process.env.SERVICE_STALE_MS) : DEFAULT_STALE_MS);
  const startedAt = new Date().toISOString();
  let timer: ReturnType<typeof setInterval> | null = null;
  let streak = 0;
  let outageStartedAt: string | null = null;
  let outageAlerted = false;
  let inFlight: Promise<void> | null = null;

  async function noteFirestoreFailure(err: unknown): Promise<void> {
    streak += 1;
    if (outageStartedAt === null) outageStartedAt = new Date().toISOString();
    logger.warn('heartbeat_write_failed', { service: options.service, streak, error: errorMessage(err) });
    if (streak >= FIRESTORE_FAILURES_BEFORE_ALERT && !outageAlerted) {
      outageAlerted = true;
      // Usually not recorded (Firestore is the problem) but still reaches external channels.
      await raiseAlert({
        type: 'firestore_unavailable',
        subject: options.service,
        severity: 'critical',
        source: options.service,
        title: `Firestore unreachable from the ${options.service}`,
        message: `${streak} consecutive heartbeat writes failed since ${outageStartedAt}: ${errorMessage(err)}. New entries are blocked (fail closed).`,
        details: { since: outageStartedAt, consecutive_failures: streak },
      });
    }
  }

  async function noteFirestoreRecovered(): Promise<void> {
    if (streak === 0) return;
    const since = outageStartedAt;
    const failures = streak;
    const wasAlerted = outageAlerted;
    streak = 0;
    outageStartedAt = null;
    outageAlerted = false;
    if (!wasAlerted) return;
    const minutes = since ? Math.max(1, Math.round((Date.now() - Date.parse(since)) / 60_000)) : null;
    // Recorded now that Firestore works again; stays open until an operator acknowledges it.
    await raiseAlert({
      type: 'firestore_unavailable',
      subject: options.service,
      severity: 'error',
      source: options.service,
      title: `Firestore was unreachable from the ${options.service}`,
      message: `Firestore writes failed from ${since ?? 'unknown'} for about ${minutes ?? '?'} min (${failures} heartbeats). It has recovered. Review alerts and trades from that window.`,
      details: { since, recovered_at: new Date().toISOString(), consecutive_failures: failures },
    });
  }

  async function checkPeer(firestore: FirebaseFirestore.Firestore, peer: ServiceName): Promise<void> {
    let snap: FirebaseFirestore.DocumentSnapshot;
    try {
      snap = await firestore.collection(SERVICE_STATUS_COLLECTION).doc(peer).get();
    } catch (err) {
      logger.warn('heartbeat_peer_read_failed', { service: options.service, peer, error: errorMessage(err) });
      return;
    }
    if (!snap.exists) return;
    const doc = snap.data() as Partial<HeartbeatDoc>;
    const updated = typeof doc.updated_at === 'string' ? Date.parse(doc.updated_at) : NaN;
    const ageMs = Number.isFinite(updated) ? Date.now() - updated : Number.POSITIVE_INFINITY;
    if (ageMs > staleMs) {
      await raiseAlert({
        type: 'service_unhealthy',
        subject: peer,
        severity: peer === 'autotrader' ? 'critical' : 'error',
        source: options.service,
        title: `${peer} heartbeat is stale`,
        message: `The ${peer} last reported ${Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)} s` : 'an unknown time'} ago (limit ${Math.round(staleMs / 1000)} s). ${
          peer === 'autotrader'
            ? 'Signals are not executed and open trades are not managed (broker-side SL/TP still apply).'
            : 'Telegram signals are not being received or forwarded.'
        }`,
        details: { peer, last_heartbeat: doc.updated_at ?? null },
      });
      return;
    }
    await resolveAlert('service_unhealthy', peer, 'heartbeat_fresh');
    if (doc.healthy === false) {
      await raiseAlert({
        type: 'service_unhealthy',
        subject: `${peer}_degraded`,
        severity: 'warning',
        source: options.service,
        title: `${peer} reports problems`,
        message: `The ${peer} is running but reports: ${(doc.issues ?? []).slice(0, 5).join('; ') || 'unspecified issues'}.`,
        details: { peer, issues: (doc.issues ?? []).slice(0, 10) },
      });
    } else {
      await resolveAlert('service_unhealthy', `${peer}_degraded`, 'peer_healthy');
    }
  }

  async function runOnce(): Promise<void> {
    let payload: HeartbeatPayload;
    try {
      payload = await options.collect();
    } catch (err) {
      payload = { healthy: false, issues: [`status_collection_failed: ${errorMessage(err)}`], details: {} };
    }
    const firestore = initFirestore();
    if (!firestore) {
      await noteFirestoreFailure(new Error('firestore client unavailable'));
      return;
    }
    const doc: HeartbeatDoc = {
      service: options.service,
      updated_at: new Date().toISOString(),
      started_at: startedAt,
      pid: process.pid,
      host: hostname(),
      interval_ms: intervalMs,
      healthy: payload.healthy,
      issues: payload.issues.slice(0, 20).map((i) => String(i).slice(0, 200)),
      details: sanitizeDetails(payload.details),
    };
    try {
      await firestore.collection(SERVICE_STATUS_COLLECTION).doc(options.service).set(doc);
    } catch (err) {
      await noteFirestoreFailure(err);
      return;
    }
    await noteFirestoreRecovered();
    if (options.peer) await checkPeer(firestore, options.peer);
  }

  function tick(): Promise<void> {
    if (!inFlight) {
      inFlight = runOnce()
        .catch((err: unknown) => logger.warn('heartbeat_tick_failed', { service: options.service, error: errorMessage(err) }))
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  return {
    tick,
    start() {
      if (timer !== null) return;
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    firestoreFailureStreak: () => streak,
  };
}
