import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignalEventInput } from './signalEvents.js';

const SIGNAL = {
  symbol: 'XAUUSD',
  direction: 'sell' as const,
  orderType: 'market' as const,
  entryLow: 4028,
  entryHigh: 4032,
  stopLoss: 4040,
  takeProfits: [4020, 4013, 4005],
};

function input(messageId: string, textHash: string, over: Partial<SignalEventInput> = {}): SignalEventInput {
  return {
    chatId: '-1003271337051',
    messageId,
    messageType: 'new',
    textHash,
    kind: 'signal',
    signal: SIGNAL,
    messageDate: new Date('2026-10-18T00:00:00.000Z'),
    ...over,
  };
}

interface Harness {
  /** Doc ids in the order create() succeeded. */
  stored: string[];
  calls: string[];
  up: { value: boolean };
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  writeSystemLog: ReturnType<typeof vi.fn>;
}

function buildHarness(): Harness {
  const stored: string[] = [];
  const calls: string[] = [];
  const up = { value: false };
  const existing = new Set<string>();
  const firestore = {
    collection: () => ({
      doc: (id: string) => ({
        create: async () => {
          calls.push(id);
          if (!up.value) throw Object.assign(new Error('14 UNAVAILABLE: down'), { code: 14 });
          if (existing.has(id)) throw Object.assign(new Error('6 ALREADY_EXISTS'), { code: 6 });
          existing.add(id);
          stored.push(id);
        },
      }),
    }),
    runTransaction: async () => {
      if (!up.value) throw new Error('14 UNAVAILABLE: down');
      return true;
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const writeSystemLog = vi.fn(async () => true);
  vi.doMock('./firestoreAdmin', () => ({ initFirestore: vi.fn(() => firestore) }));
  vi.doMock('./logger', () => ({ logger }));
  vi.doMock('./systemLog', () => ({ writeSystemLog }));
  return { stored, calls, up, logger, writeSystemLog };
}

let dir: string;
let outbox: string;
const ENV_KEYS = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'SIGNAL_OUTBOX_PATH', 'SIGNAL_OUTBOX_MAX', 'SIGNAL_OUTBOX'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval', 'clearTimeout'] });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bytrader-outbox-'));
  outbox = path.join(dir, 'nested', 'signal_outbox.jsonl');
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Presence only: the outbox is used when Firestore is configured. The client itself is mocked.
  process.env.FIREBASE_PROJECT_ID = 'demo-test';
  process.env.FIREBASE_CLIENT_EMAIL = 'test@example.invalid';
  process.env.FIREBASE_PRIVATE_KEY = 'not-a-real-key';
  process.env.SIGNAL_OUTBOX_PATH = outbox;
  delete process.env.SIGNAL_OUTBOX_MAX;
  delete process.env.SIGNAL_OUTBOX;
});

afterEach(async () => {
  const mod = await import('./signalEvents.js');
  mod._resetSignalEventsForTests();
  vi.useRealTimers();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

async function publish(mod: typeof import('./signalEvents.js'), ev: SignalEventInput): Promise<boolean> {
  const p = mod.publishSignalEvent(ev);
  await vi.advanceTimersByTimeAsync(2_000);
  return p;
}

function fileIds(): string[] {
  if (!fs.existsSync(outbox)) return [];
  return fs
    .readFileSync(outbox, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { doc_id: string }).doc_id);
}

describe('signal outbox (forwarder-side durability)', () => {
  it('spools an event Firestore keeps rejecting, with mode 0600, and reports it', async () => {
    const h = buildHarness();
    const mod = await import('./signalEvents.js');

    expect(await publish(mod, input('1', 'a'))).toBe(true);
    expect(fileIds()).toEqual(['-1003271337051_1_a']);
    expect(fs.statSync(outbox).mode & 0o777).toBe(0o600);
    expect(h.logger.error).toHaveBeenCalledWith('signal_event_spooled', expect.objectContaining({ docId: '-1003271337051_1_a' }));
    expect(mod.getSignalOutboxDepth()).toBe(1);
    // The spooled event keeps its pending queue state and original created_at.
    const line = JSON.parse(fs.readFileSync(outbox, 'utf8').split('\n')[0]) as { data: Record<string, unknown> };
    expect(line.data).toMatchObject({ kind: 'signal', autotrader: { status: 'pending', attempts: 0 } });
    expect(JSON.stringify(line)).not.toContain('not-a-real-key');
  });

  it('queues later events behind the outbox so a cancel never overtakes its signal', async () => {
    const h = buildHarness();
    const mod = await import('./signalEvents.js');
    await publish(mod, input('1', 'a'));

    h.up.value = true;
    // Firestore is back, but the outbox is not empty: the cancel goes behind the signal.
    const p = mod.publishSignalEvent(input('1', 'b', { kind: 'cancel', signal: null, cancelReason: 'explicit_cancel' }));
    expect(await p).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    await mod.flushSignalOutbox();

    expect(h.stored).toEqual(['-1003271337051_1_a', '-1003271337051_1_b']);
    expect(fileIds()).toEqual([]);
    expect(fs.existsSync(outbox)).toBe(false);
    expect(mod.getSignalOutboxDepth()).toBe(0);
  });

  it('flushes in FIFO order on the timer and stops at the first failure', async () => {
    const h = buildHarness();
    const mod = await import('./signalEvents.js');
    await publish(mod, input('1', 'a'));
    await publish(mod, input('2', 'a'));
    await publish(mod, input('3', 'a'));
    expect(fileIds()).toEqual(['-1003271337051_1_a', '-1003271337051_2_a', '-1003271337051_3_a']);

    // Still down: the timer flush tries only the head.
    h.calls.length = 0;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.calls).toEqual(['-1003271337051_1_a']);
    expect(fileIds()).toHaveLength(3);

    h.up.value = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.stored).toEqual(['-1003271337051_1_a', '-1003271337051_2_a', '-1003271337051_3_a']);
    expect(fileIds()).toEqual([]);
  });

  it('treats ALREADY_EXISTS during a flush as delivered (crash between write and rewrite)', async () => {
    const h = buildHarness();
    const mod = await import('./signalEvents.js');
    await publish(mod, input('1', 'a'));
    h.up.value = true;
    await mod.flushSignalOutbox();
    expect(h.stored).toEqual(['-1003271337051_1_a']);

    // Simulate the crash: the delivered line is still in the file.
    fs.mkdirSync(path.dirname(outbox), { recursive: true });
    fs.writeFileSync(
      outbox,
      `${JSON.stringify({ doc_id: '-1003271337051_1_a', data: { kind: 'signal' }, spooled_at: new Date().toISOString(), attempts: 0 })}\n`,
    );
    mod._resetSignalEventsForTests();
    await mod.flushSignalOutbox();
    expect(fileIds()).toEqual([]);
    expect(h.stored).toEqual(['-1003271337051_1_a']);
  });

  it('survives a forwarder restart: a new process flushes the file it finds', async () => {
    const h = buildHarness();
    let mod = await import('./signalEvents.js');
    await publish(mod, input('7', 'a'));
    mod._resetSignalEventsForTests();

    vi.resetModules();
    const h2 = buildHarness();
    h2.up.value = true;
    mod = await import('./signalEvents.js');
    mod.startSignalOutbox();
    await vi.advanceTimersByTimeAsync(0);
    await mod.flushSignalOutbox();
    expect(h2.stored).toEqual(['-1003271337051_7_a']);
    expect(h.stored).toEqual([]);
    expect(fileIds()).toEqual([]);
  });

  it('refuses new events when the outbox is full instead of dropping older ones', async () => {
    process.env.SIGNAL_OUTBOX_MAX = '2';
    const h = buildHarness();
    const mod = await import('./signalEvents.js');
    expect(await publish(mod, input('1', 'a'))).toBe(true);
    expect(await publish(mod, input('2', 'a'))).toBe(true);
    expect(await publish(mod, input('3', 'a'))).toBe(false);
    expect(fileIds()).toEqual(['-1003271337051_1_a', '-1003271337051_2_a']);
    expect(h.logger.error).toHaveBeenCalledWith('signal_outbox_full', expect.objectContaining({ max: 2 }));
    expect(h.logger.error).toHaveBeenCalledWith('signal_event_publish_failed', expect.objectContaining({ docId: '-1003271337051_3_a' }));
  });

  it('skips corrupt lines and keeps the valid ones', async () => {
    const h = buildHarness();
    fs.mkdirSync(path.dirname(outbox), { recursive: true });
    fs.writeFileSync(
      outbox,
      [
        'not json',
        JSON.stringify({ doc_id: 'x_1_a', data: { kind: 'signal' }, spooled_at: '2026-10-18T00:00:00.000Z', attempts: 0 }),
        JSON.stringify({ nope: true }),
      ].join('\n') + '\n',
    );
    h.up.value = true;
    const mod = await import('./signalEvents.js');
    await mod.flushSignalOutbox();
    expect(h.stored).toEqual(['x_1_a']);
    expect(h.logger.error).toHaveBeenCalledWith('signal_outbox_corrupt_line', { line: 1 });
    expect(h.logger.error).toHaveBeenCalledWith('signal_outbox_corrupt_line', { line: 3 });
  });

  it('does not spool when Firestore is not configured at all (development)', async () => {
    delete process.env.FIREBASE_PROJECT_ID;
    buildHarness();
    const mod = await import('./signalEvents.js');
    expect(await publish(mod, input('1', 'a'))).toBe(false);
    expect(fs.existsSync(outbox)).toBe(false);
  });

  it('can be switched off with SIGNAL_OUTBOX=disabled', async () => {
    process.env.SIGNAL_OUTBOX = 'disabled';
    buildHarness();
    const mod = await import('./signalEvents.js');
    expect(await publish(mod, input('1', 'a'))).toBe(false);
    expect(fs.existsSync(outbox)).toBe(false);
  });
});
