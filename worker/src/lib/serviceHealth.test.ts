import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fs: null as unknown, up: true }));

vi.mock('./firestoreAdmin', () => ({ initFirestore: () => (h.up ? h.fs : null) }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { _resetAlertsForTests } from './alerts.js';
import { createHeartbeat } from './serviceHealth.js';
import { createFakeFirestore, type FakeFirestore } from './testing/fakeFirestore.js';

const T0 = Date.parse('2026-10-18T10:00:00.000Z');

function fs(): FakeFirestore {
  return h.fs as FakeFirestore;
}

describe('service heartbeat and watchdog', () => {
  beforeEach(() => {
    h.fs = createFakeFirestore();
    h.up = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    _resetAlertsForTests(async () => ({ ok: true, status: 200 }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a sanitized heartbeat', async () => {
    const hb = createHeartbeat({
      service: 'autotrader',
      collect: async () => ({ healthy: true, issues: [], details: { mode: 'demo', api_token: 'x', nested: { password: 'y', ok: 1 } } }),
    });
    await hb.tick();
    const doc = fs().peek('service_status/autotrader');
    expect(doc).toMatchObject({ service: 'autotrader', healthy: true, issues: [], updated_at: new Date(T0).toISOString(), pid: process.pid });
    expect(doc?.details).toEqual({ mode: 'demo', nested: { ok: 1 } });
  });

  it('raises service_unhealthy when the peer heartbeat is stale and resolves it when fresh', async () => {
    fs().seed('service_status/autotrader', { service: 'autotrader', updated_at: new Date(T0 - 5 * 60_000).toISOString(), healthy: true, issues: [] });
    const hb = createHeartbeat({ service: 'forwarder', peer: 'autotrader', collect: async () => ({ healthy: true, issues: [], details: {} }) });
    await hb.tick();
    expect(fs().peek('alerts/service_unhealthy__autotrader')).toMatchObject({ severity: 'critical', status: 'open', source: 'forwarder' });

    fs().seed('service_status/autotrader', { service: 'autotrader', updated_at: new Date(T0).toISOString(), healthy: true, issues: [] });
    await hb.tick();
    expect(fs().peek('alerts/service_unhealthy__autotrader')).toMatchObject({ status: 'resolved' });
  });

  it('a missing peer document (older peer without heartbeats) is not an alert', async () => {
    const hb = createHeartbeat({ service: 'autotrader', peer: 'forwarder', collect: async () => ({ healthy: true, issues: [], details: {} }) });
    await hb.tick();
    expect(fs().docs('alerts')).toEqual([]);
  });

  it('a peer that reports itself unhealthy raises a warning with its issues', async () => {
    fs().seed('service_status/autotrader', {
      service: 'autotrader',
      updated_at: new Date(T0).toISOString(),
      healthy: false,
      issues: ['bridge_unreachable', 'loop_stopped:reconciler'],
    });
    const hb = createHeartbeat({ service: 'forwarder', peer: 'autotrader', collect: async () => ({ healthy: true, issues: [], details: {} }) });
    await hb.tick();
    expect(fs().peek('alerts/service_unhealthy__autotrader_degraded')).toMatchObject({ severity: 'warning', status: 'open' });
    expect(String(fs().peek('alerts/service_unhealthy__autotrader_degraded')?.message)).toContain('bridge_unreachable');
  });

  it('treats three failed heartbeat writes as a Firestore outage and records it after recovery', async () => {
    const hb = createHeartbeat({ service: 'autotrader', collect: async () => ({ healthy: true, issues: [], details: {} }) });
    fs().setOffline(true);
    for (let i = 0; i < 3; i += 1) {
      vi.setSystemTime(T0 + i * 15_000);
      await hb.tick();
    }
    expect(hb.firestoreFailureStreak()).toBe(3);
    fs().setOffline(false);
    vi.setSystemTime(T0 + 10 * 60_000);
    await hb.tick();
    expect(hb.firestoreFailureStreak()).toBe(0);
    expect(fs().peek('alerts/firestore_unavailable__autotrader')).toMatchObject({ severity: 'error', status: 'open' });
    expect(String(fs().peek('alerts/firestore_unavailable__autotrader')?.message)).toContain('about 10 min');
  });

  it('a single failed write is not reported as an outage', async () => {
    const hb = createHeartbeat({ service: 'autotrader', collect: async () => ({ healthy: true, issues: [], details: {} }) });
    fs().failNext('set');
    await hb.tick();
    await hb.tick();
    expect(fs().peek('alerts/firestore_unavailable__autotrader')).toBeUndefined();
  });

  it('a collector that throws reports unhealthy instead of skipping the heartbeat', async () => {
    const hb = createHeartbeat({
      service: 'autotrader',
      collect: async () => {
        throw new Error('boom');
      },
    });
    await hb.tick();
    expect(fs().peek('service_status/autotrader')).toMatchObject({ healthy: false, issues: ['status_collection_failed: boom'] });
  });
});
