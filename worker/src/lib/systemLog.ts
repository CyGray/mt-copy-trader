import { initFirestore } from './firestoreAdmin';

export type SystemLogLevel = 'info' | 'warn' | 'error';

export async function writeSystemLog(
  level: SystemLogLevel,
  component: string,
  message: string,
  details: Record<string, unknown> = {},
): Promise<boolean> {
  const firestore = initFirestore();
  if (!firestore) return false;

  try {
    await firestore.collection('system_logs').add({
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      details,
    });
    return true;
  } catch {
    return false;
  }
}
