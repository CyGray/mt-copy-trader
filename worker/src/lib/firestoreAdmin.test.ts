import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY_MATERIAL = 'SECRETKEYMATERIAL';
const PROCESSED_KEY = `-----BEGIN PRIVATE KEY-----\n${KEY_MATERIAL}\n-----END PRIVATE KEY-----\n`;
const FAKE_DB = { fake: 'firestore' };

function mockAdmin(options: { certError?: unknown; firestoreError?: unknown } = {}) {
  const apps: unknown[] = [];
  const cert = vi.fn(() => {
    if (options.certError !== undefined) throw options.certError;
    return { cert: true };
  });
  const initializeApp = vi.fn(() => {
    apps.push({});
  });
  const firestore = vi.fn(() => {
    if (options.firestoreError !== undefined) throw options.firestoreError;
    return FAKE_DB;
  });
  vi.doMock('firebase-admin', () => ({
    default: { apps, credential: { cert }, initializeApp, firestore },
  }));
  return { cert, initializeApp, firestore };
}

function spyError() {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

async function loadModule() {
  return import('./firestoreAdmin.js');
}

describe('initFirestore', () => {
  let errorSpy: ReturnType<typeof spyError>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('FIREBASE_PROJECT_ID', 'demo-project');
    vi.stubEnv('FIREBASE_CLIENT_EMAIL', 'svc@demo-project.iam.gserviceaccount.com');
    vi.stubEnv('FIREBASE_PRIVATE_KEY', PROCESSED_KEY.replace(/\n/g, '\\n'));
    errorSpy = spyError();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock('firebase-admin');
  });

  it('returns null without throwing when the credential is malformed', async () => {
    const admin = mockAdmin({ certError: new Error('Service account object must contain a string "project_id" property.') });
    const { initFirestore } = await loadModule();

    expect(() => initFirestore()).not.toThrow();
    expect(initFirestore()).toBeNull();
    expect(admin.initializeApp).not.toHaveBeenCalled();
  });

  it('logs one structured error for a failed init without echoing the private key', async () => {
    mockAdmin({ certError: new Error(`bad key: ${PROCESSED_KEY}`) });
    const { initFirestore } = await loadModule();

    expect(initFirestore()).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const line = String(errorSpy.mock.calls[0][0]);
    const entry = JSON.parse(line);
    expect(entry).toMatchObject({
      level: 'error',
      event: 'firestore_init_failed',
      payload: { error: expect.any(String) },
    });
    expect(entry.payload.error).toContain('bad key');
    expect(line).not.toContain(KEY_MATERIAL);
  });

  it('returns null without throwing when firestore() throws a non-Error value', async () => {
    mockAdmin({ firestoreError: 'UNAVAILABLE' });
    const { initFirestore } = await loadModule();

    expect(() => initFirestore()).not.toThrow();
    expect(initFirestore()).toBeNull();
    expect(JSON.parse(String(errorSpy.mock.calls[0][0])).payload).toEqual({ error: 'UNAVAILABLE' });
  });

  it('caches a failed init for 60 seconds before retrying', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T10:00:00.000Z'));
    const admin = mockAdmin({ certError: new Error('bad credential') });
    const { initFirestore } = await loadModule();

    initFirestore();
    vi.setSystemTime(new Date('2026-10-18T10:00:30.000Z'));
    expect(initFirestore()).toBeNull();
    expect(admin.cert).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-10-18T10:01:01.000Z'));
    expect(initFirestore()).toBeNull();
    expect(admin.cert).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('returns null and does not touch firebase-admin when config is missing', async () => {
    vi.stubEnv('FIREBASE_PROJECT_ID', '');
    const admin = mockAdmin();
    const { initFirestore } = await loadModule();

    expect(initFirestore()).toBeNull();
    expect(admin.cert).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('returns the Firestore client on success and reuses it', async () => {
    const admin = mockAdmin();
    const { initFirestore, getFirestore } = await loadModule();

    expect(getFirestore()).toBeNull();
    expect(initFirestore()).toBe(FAKE_DB);
    expect(initFirestore()).toBe(FAKE_DB);
    expect(getFirestore()).toBe(FAKE_DB);
    expect(admin.initializeApp).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
