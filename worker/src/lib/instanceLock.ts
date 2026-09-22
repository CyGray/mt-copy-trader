import crypto from 'node:crypto';
import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';
import { writeSystemLog } from './systemLog';

const LOCK_DOC_PATH = 'system_locks/telegram_worker';
const HEARTBEAT_INTERVAL_MS = 20_000;
const LOCK_STALE_MS = 60_000;

const instanceId = `${process.pid}-${crypto.randomUUID()}`;

let heartbeatTimer: NodeJS.Timeout | null = null;
let lockHeld = false;

export function getInstanceId(): string {
  return instanceId;
}

export function holdsInstanceLock(): boolean {
  return lockHeld;
}

export async function acquireInstanceLock(): Promise<boolean> {
  const firestore = initFirestore();
  if (!firestore) {
    lockHeld = true;
    return true;
  }

  const ref = firestore.doc(LOCK_DOC_PATH);

  try {
    const acquired = await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const data = snapshot.data() as { instance_id?: string; heartbeat_at?: number } | undefined;
      const holder = data?.instance_id ?? null;
      const heartbeatAt = typeof data?.heartbeat_at === 'number' ? data.heartbeat_at : 0;

      if (holder && holder !== instanceId && Date.now() - heartbeatAt < LOCK_STALE_MS) {
        return false;
      }

      transaction.set(
        ref,
        {
          instance_id: instanceId,
          heartbeat_at: Date.now(),
          claimed_at: new Date().toISOString(),
        },
        { merge: true },
      );

      return true;
    });

    lockHeld = acquired;
    return acquired;
  } catch (error) {
    lockHeld = true;
    logger.warn('instance_lock_check_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

export function startInstanceLockHeartbeat(): void {
  if (heartbeatTimer) return;

  heartbeatTimer = setInterval(() => {
    void heartbeat();
  }, HEARTBEAT_INTERVAL_MS);
}

export function stopInstanceLockHeartbeat(): void {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function heartbeat(): Promise<void> {
  const firestore = initFirestore();
  if (!firestore || !lockHeld) return;

  try {
    const ref = firestore.doc(LOCK_DOC_PATH);
    const snapshot = await ref.get();
    const data = snapshot.data() as { instance_id?: string } | undefined;

    if (data?.instance_id && data.instance_id !== instanceId) {
      lockHeld = false;
      stopInstanceLockHeartbeat();
      logger.warn('instance_lock_lost', { instanceId, holder: data.instance_id });
      await writeSystemLog('warn', 'worker', 'instance_lock_lost', {
        instanceId,
        holder: data.instance_id,
      });
      return;
    }

    await ref.set({ instance_id: instanceId, heartbeat_at: Date.now() }, { merge: true });
  } catch (error) {
    logger.warn('instance_lock_heartbeat_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function releaseInstanceLock(): Promise<void> {
  stopInstanceLockHeartbeat();

  const firestore = initFirestore();
  const wasHeld = lockHeld;
  lockHeld = false;
  if (!firestore || !wasHeld) return;

  try {
    const ref = firestore.doc(LOCK_DOC_PATH);
    const snapshot = await ref.get();
    const data = snapshot.data() as { instance_id?: string } | undefined;

    if (data?.instance_id === instanceId) {
      await ref.delete();
    }
  } catch (error) {
    logger.warn('instance_lock_release_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
