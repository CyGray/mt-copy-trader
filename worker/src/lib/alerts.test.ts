import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fs: null as unknown, up: true }));

vi.mock('./firestoreAdmin', () => ({ initFirestore: () => (h.up ? h.fs : null) }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { createFakeFirestore, type FakeFirestore } from './testing/fakeFirestore.js';
import { _resetAlertsForTests, describeNotificationConfig, getNotificationConfig, raiseAlert, resolveAlert } from './alerts.js';
import { alertDocId, redactSecrets, sanitizeDetails } from './alertTypes.js';
import { logger } from './logger.js';

const T0 = Date.parse('2026-10-18T10:00:00.000Z');
const ENV = ['ALERT_NOTIFICATIONS', 'ALERT_WEBHOOK_URL', 'ALERT_TELEGRAM_BOT_TOKEN', 'ALERT_TELEGRAM_CHAT_ID', 'ALERT_NOTIFY_MIN_SEVERITY'];
const saved: Record<string, string | undefined> = {};

function fs(): FakeFirestore {
  return h.fs as FakeFirestore;
}

function doc(id: string): Record<string, unknown> | undefined {
  return fs().peek(`alerts/${id}`);
}

const base = {
  type: 'bridge_disconnected' as const,
  severity: 'error' as const,
  title: 'MT5 bridge unreachable',
  message: 'No reply to PING for 30 s',
  source: 'autotrader',
};

describe('alerts', () => {
  let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;

  beforeEach(() => {
    h.fs = createFakeFirestore();
    h.up = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    fetchCalls = [];
    _resetAlertsForTests(async (url, init) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return { ok: true, status: 200 };
    });
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    vi.mocked(logger.warn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('opens one document per condition with the default operator action', async () => {
    expect(await raiseAlert(base)).toBe(true);
    expect(doc('bridge_disconnected')).toMatchObject({
      type: 'bridge_disconnected',
      severity: 'error',
      status: 'open',
      count: 1,
      source: 'autotrader',
      first_seen_at: new Date(T0).toISOString(),
    });
    expect(String(doc('bridge_disconnected')?.action)).toContain('VantageBridgeEA');
  });

  it('deduplicates: repeats bump count, and repeats within 60 s are coalesced', async () => {
    await raiseAlert(base);
    await raiseAlert(base);
    await raiseAlert(base);
    expect(doc('bridge_disconnected')?.count).toBe(1);
    vi.setSystemTime(T0 + 61_000);
    await raiseAlert(base);
    expect(doc('bridge_disconnected')).toMatchObject({ count: 4, last_seen_at: new Date(T0 + 61_000).toISOString() });
    expect(fs().docs('alerts')).toHaveLength(1);
  });

  it('keys instances by subject', async () => {
    await raiseAlert({ ...base, type: 'submit_unknown', subject: 'chat_1/2' });
    await raiseAlert({ ...base, type: 'submit_unknown', subject: 'chat_3' });
    expect(fs().docs('alerts').map((d) => d.id).sort()).toEqual(['submit_unknown__chat_1_2', 'submit_unknown__chat_3']);
    expect(alertDocId('submit_unknown', 'a b')).toBe('submit_unknown__a_b');
  });

  it('a higher severity re-opens an acknowledged alert; the same severity keeps it acknowledged', async () => {
    await raiseAlert(base);
    fs().seed('alerts/bridge_disconnected', { ...doc('bridge_disconnected'), status: 'acknowledged', acknowledged_by: 'ops@example.com' });
    vi.setSystemTime(T0 + 61_000);
    await raiseAlert(base);
    expect(doc('bridge_disconnected')).toMatchObject({ status: 'acknowledged', count: 2 });
    vi.setSystemTime(T0 + 122_000);
    await raiseAlert({ ...base, severity: 'critical' });
    expect(doc('bridge_disconnected')).toMatchObject({ status: 'open', severity: 'critical', acknowledged_by: null });
  });

  it('resolves when the condition clears and re-opens on recurrence', async () => {
    await raiseAlert(base);
    expect(await resolveAlert('bridge_disconnected')).toBe(true);
    expect(doc('bridge_disconnected')).toMatchObject({ status: 'resolved', resolved_by: 'system', resolution: 'condition_cleared' });
    vi.setSystemTime(T0 + 61_000);
    await raiseAlert(base);
    expect(doc('bridge_disconnected')).toMatchObject({ status: 'open', reopened_count: 1, resolved_at: null });
  });

  it('a resolve for an alert that never existed does not create one, and repeats do not re-read', async () => {
    await resolveAlert('bridge_disconnected');
    expect(doc('bridge_disconnected')).toBeUndefined();
    const spy = vi.spyOn(fs(), 'runTransaction');
    await resolveAlert('bridge_disconnected');
    expect(spy).not.toHaveBeenCalled();
  });

  it('never throws when Firestore is unavailable or failing', async () => {
    h.up = false;
    expect(await raiseAlert(base)).toBe(false);
    expect(await resolveAlert('bridge_disconnected')).toBe(false);
    h.up = true;
    fs().failNext('transaction');
    expect(await raiseAlert({ ...base, type: 'config_invalid' })).toBe(false);
  });

  it('strips credential-shaped keys and values before storing', async () => {
    await raiseAlert({
      ...base,
      message: 'failed with Bearer abc.def.ghi and token 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ',
      details: {
        tradeSetId: 't1',
        private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
        apiKey: 'x',
        sessionString: 'y',
        nested: { password: 'p', ok: 1 },
        note: 'x'.repeat(900),
      },
    });
    const stored = doc('bridge_disconnected') as { message: string; details: Record<string, unknown> };
    expect(stored.message).not.toContain('abc.def.ghi');
    expect(stored.message).not.toContain('AAHdqTcv');
    expect(Object.keys(stored.details).sort()).toEqual(['nested', 'note', 'tradeSetId']);
    expect(stored.details.nested).toEqual({ ok: 1 });
    expect(String(stored.details.note).length).toBe(500);
  });

  describe('external notifications', () => {
    it('are off by default even when a channel is configured', async () => {
      process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.invalid/x';
      await raiseAlert({ ...base, severity: 'critical' });
      expect(fetchCalls).toEqual([]);
      expect(getNotificationConfig().enabled).toBe(false);
    });

    it('send to the webhook when enabled, at or above the minimum severity, without details', async () => {
      process.env.ALERT_NOTIFICATIONS = 'enabled';
      process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.invalid/x';
      await raiseAlert({ ...base, severity: 'warning', type: 'signal_backlog' });
      expect(fetchCalls).toEqual([]);
      await raiseAlert({ ...base, details: { secretish: 'no' } });
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe('https://hooks.example.invalid/x');
      expect(fetchCalls[0].body).toMatchObject({ source: 'bytrader', type: 'bridge_disconnected', severity: 'error', state: 'opened' });
      expect(fetchCalls[0].body).not.toHaveProperty('details');
    });

    it('rate-limit repeats and notify again on escalation', async () => {
      process.env.ALERT_NOTIFICATIONS = 'enabled';
      process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.invalid/x';
      await raiseAlert(base);
      await resolveAlert('bridge_disconnected');
      vi.setSystemTime(T0 + 61_000);
      await raiseAlert(base); // re-opened, but within 15 minutes of the last notification
      expect(fetchCalls).toHaveLength(1);
      vi.setSystemTime(T0 + 122_000);
      await raiseAlert({ ...base, severity: 'critical' });
      expect(fetchCalls).toHaveLength(2);
    });

    it('still notify when Firestore is down, marked as unrecorded', async () => {
      process.env.ALERT_NOTIFICATIONS = 'enabled';
      process.env.ALERT_TELEGRAM_BOT_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
      process.env.ALERT_TELEGRAM_CHAT_ID = '42';
      h.up = false;
      await raiseAlert({ ...base, type: 'firestore_unavailable', severity: 'critical' });
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toMatch(/^https:\/\/api\.telegram\.org\/bot/);
      expect(String(fetchCalls[0].body.text)).toContain('Firestore unavailable');
      // The token never appears in logs.
      const logged = JSON.stringify(vi.mocked(logger.error).mock.calls) + JSON.stringify(vi.mocked(logger.warn).mock.calls);
      expect(logged).not.toContain('AAHdqTcv');
    });

    it('reject plain-http webhooks and describe channels without values', () => {
      process.env.ALERT_NOTIFICATIONS = 'enabled';
      process.env.ALERT_WEBHOOK_URL = 'http://insecure.example.invalid/x';
      expect(getNotificationConfig()).toMatchObject({ enabled: false, webhookUrl: null });
      process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.invalid/secret-path';
      expect(describeNotificationConfig()).toEqual({ enabled: true, minSeverity: 'error', channels: ['webhook'] });
    });
  });

  describe('redaction helpers', () => {
    it('masks keys, bot tokens, bearer tokens and JWTs', () => {
      expect(redactSecrets('Bearer abc123')).toBe('[redacted]');
      expect(redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')).toBe('[redacted]');
      expect(sanitizeDetails({ authorization: 'x', ok: true, n: Number.NaN })).toEqual({ ok: true, n: null });
    });
  });
});
