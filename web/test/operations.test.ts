import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED, createHarness, json, req, type Harness } from './harness';

const h = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/firebaseAdmin', () => ({ getAdminApp: () => h.harness?.app ?? null }));

import { GET as listAlerts } from '@/app/api/alerts/route';
import { POST as alertAction } from '@/app/api/alerts/[id]/route';
import { GET as listEvents } from '@/app/api/signal-events/route';
import { POST as eventAction } from '@/app/api/signal-events/[id]/route';
import { initialQueueState } from '@shared/signalQueue';

function fs() {
  return (h.harness as Harness).fs;
}

function seedAlert(id: string, over: Record<string, unknown> = {}) {
  fs().seed(`alerts/${id}`, {
    type: 'bridge_disconnected',
    subject: '',
    severity: 'error',
    status: 'open',
    title: 'MT5 bridge unreachable',
    message: 'm',
    action: 'a',
    source: 'autotrader',
    details: {},
    count: 1,
    first_seen_at: '2026-10-18T10:00:00.000Z',
    last_seen_at: '2026-10-18T10:00:00.000Z',
    ...over,
  });
}

function seedEvent(id: string, createdAt: string, status: string, over: Record<string, unknown> = {}) {
  fs().seed(`signal_events/${id}`, {
    chat_id: '-100',
    message_id: '7',
    kind: 'signal',
    message_type: 'new',
    signal: { symbol: 'XAUUSD', direction: 'buy' },
    created_at: createdAt,
    autotrader: { ...initialQueueState(createdAt), status, attempts: status === 'dead_letter' ? 8 : 0, last_error: 'gate_error' },
    ...over,
  });
}

describe('operator alerts API', () => {
  beforeEach(() => {
    h.harness = createHarness();
    process.env.ALLOWED_EMAILS = ALLOWED;
  });

  it('lists active alerts most severe first, then most recent', async () => {
    seedAlert('a', { severity: 'warning', last_seen_at: '2026-10-18T12:00:00.000Z' });
    seedAlert('b', { severity: 'critical', last_seen_at: '2026-10-18T09:00:00.000Z' });
    seedAlert('c', { severity: 'critical', last_seen_at: '2026-10-18T11:00:00.000Z', status: 'acknowledged' });
    seedAlert('d', { status: 'resolved' });
    const r = await json(await listAlerts(req('GET', '/api/alerts?view=active', { token: 'viewer' })));
    expect(r.status).toBe(200);
    expect((r.body.alerts as Array<{ id: string }>).map((a) => a.id)).toEqual(['c', 'b', 'a']);
    const resolved = await json(await listAlerts(req('GET', '/api/alerts?view=resolved', { token: 'viewer' })));
    expect((resolved.body.alerts as Array<{ id: string }>).map((a) => a.id)).toEqual(['d']);
    expect((await listAlerts(req('GET', '/api/alerts?view=everything', { token: 'viewer' }))).status).toBe(400);
  });

  it('refuses unauthenticated and non-allow-listed reads', async () => {
    expect((await listAlerts(req('GET', '/api/alerts'))).status).toBe(401);
    expect((await listAlerts(req('GET', '/api/alerts', { token: 'outsider' }))).status).toBe(403);
  });

  it('an admin acknowledges and resolves with audit entries; a viewer cannot', async () => {
    seedAlert('bridge_disconnected');
    const ctx = { params: { id: 'bridge_disconnected' } };
    expect((await alertAction(req('POST', '/x', { token: 'viewer', body: { action: 'acknowledge' } }), ctx)).status).toBe(403);
    expect(fs().peek('alerts/bridge_disconnected')?.status).toBe('open');

    const ack = await json(await alertAction(req('POST', '/x', { token: 'admin', body: { action: 'acknowledge' } }), ctx));
    expect(ack.body).toMatchObject({ ok: true, status: 'acknowledged' });
    expect(fs().peek('alerts/bridge_disconnected')).toMatchObject({ status: 'acknowledged', acknowledged_by: 'admin@example.com' });

    const res = await json(await alertAction(req('POST', '/x', { token: 'admin', body: { action: 'resolve', note: 'EA restarted' } }), ctx));
    expect(res.body.status).toBe('resolved');
    expect(fs().peek('alerts/bridge_disconnected')).toMatchObject({ status: 'resolved', resolved_by: 'admin@example.com', resolution: 'operator: EA restarted' });
    expect(fs().docs('admin_audit').map((d) => d.data.action)).toEqual(['alert.acknowledge', 'alert.resolve']);

    // Acknowledging a resolved alert is refused; resolving again is a no-op.
    expect((await alertAction(req('POST', '/x', { token: 'admin', body: { action: 'acknowledge' } }), ctx)).status).toBe(409);
    expect((await alertAction(req('POST', '/x', { token: 'admin', body: { action: 'resolve' } }), ctx)).status).toBe(200);
  });

  it('validates the action and the id', async () => {
    seedAlert('x');
    expect((await alertAction(req('POST', '/x', { token: 'admin', body: { action: 'delete' } }), { params: { id: 'x' } })).status).toBe(400);
    expect((await alertAction(req('POST', '/x', { token: 'admin', body: { action: 'resolve' } }), { params: { id: 'a/b' } })).status).toBe(400);
    expect((await alertAction(req('POST', '/x', { token: 'admin', body: { action: 'resolve' } }), { params: { id: 'missing' } })).status).toBe(404);
  });
});

describe('signal queue API (dead-letter recovery)', () => {
  beforeEach(() => {
    h.harness = createHarness();
    process.env.ALLOWED_EMAILS = ALLOWED;
  });

  it('lists dead letters and active events oldest first, without raw message text', async () => {
    seedEvent('e2', '2026-10-18T10:02:00.000Z', 'dead_letter', { text: 'raw telegram text' });
    seedEvent('e1', '2026-10-18T10:01:00.000Z', 'dead_letter');
    seedEvent('e3', '2026-10-18T10:03:00.000Z', 'retry_wait');
    const dead = await json(await listEvents(req('GET', '/api/signal-events?view=dead_letter', { token: 'viewer' })));
    expect((dead.body.events as Array<{ id: string }>).map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(JSON.stringify(dead.body)).not.toContain('raw telegram text');
    const active = await json(await listEvents(req('GET', '/api/signal-events?view=active', { token: 'viewer' })));
    expect((active.body.events as Array<{ id: string; queue: { status: string } }>).map((e) => [e.id, e.queue.status])).toEqual([['e3', 'retry_wait']]);
  });

  it('requeue needs the admin role and the typed confirmation, resets attempts and is audited', async () => {
    seedEvent('e1', '2026-10-18T10:01:00.000Z', 'dead_letter');
    const ctx = { params: { id: 'e1' } };
    expect((await eventAction(req('POST', '/x', { token: 'viewer', body: { action: 'requeue', confirm: 'REQUEUE' } }), ctx)).status).toBe(403);
    expect((await eventAction(req('POST', '/x', { token: 'admin', body: { action: 'requeue', confirm: 'yes' } }), ctx)).status).toBe(400);
    expect(fs().peek('signal_events/e1')?.autotrader).toMatchObject({ status: 'dead_letter' });

    const r = await json(await eventAction(req('POST', '/x', { token: 'admin', body: { action: 'requeue', confirm: 'REQUEUE' } }), ctx));
    expect(r.body).toMatchObject({ ok: true, status: 'pending' });
    expect(fs().peek('signal_events/e1')?.autotrader).toMatchObject({ status: 'pending', attempts: 0, requeue_count: 1, requeued_by: 'admin@example.com', last_error: 'gate_error' });
    expect(fs().docs('admin_audit').map((d) => d.data.action)).toEqual(['signal_event.requeue']);
  });

  it('refuses a requeue that would replay an older event after a newer one of the same trade set', async () => {
    seedEvent('e1', '2026-10-18T10:01:00.000Z', 'dead_letter');
    seedEvent('e2', '2026-10-18T10:05:00.000Z', 'done', { message_type: 'edit' });
    const r = await json(await eventAction(req('POST', '/x', { token: 'admin', body: { action: 'requeue', confirm: 'REQUEUE' } }), { params: { id: 'e1' } }));
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('superseded');
    expect(fs().peek('signal_events/e1')?.autotrader).toMatchObject({ status: 'dead_letter' });
    expect(fs().docs('admin_audit')).toEqual([]);
  });

  it('a newer event of another trade set does not block the requeue', async () => {
    seedEvent('e1', '2026-10-18T10:01:00.000Z', 'dead_letter');
    seedEvent('e9', '2026-10-18T10:05:00.000Z', 'done', { message_id: '99' });
    const r = await eventAction(req('POST', '/x', { token: 'admin', body: { action: 'requeue', confirm: 'REQUEUE' } }), { params: { id: 'e1' } });
    expect(r.status).toBe(200);
  });

  it('discard is terminal; only dead letters can be requeued or discarded', async () => {
    seedEvent('e1', '2026-10-18T10:01:00.000Z', 'dead_letter');
    seedEvent('e2', '2026-10-18T10:02:00.000Z', 'pending', { message_id: '8' });
    const d = await json(await eventAction(req('POST', '/x', { token: 'admin', body: { action: 'discard', confirm: 'DISCARD', note: 'stale' } }), { params: { id: 'e1' } }));
    expect(d.body.status).toBe('discarded');
    expect(fs().peek('signal_events/e1')?.autotrader).toMatchObject({ status: 'discarded', discarded_by: 'admin@example.com', discard_note: 'stale' });
    expect((await eventAction(req('POST', '/x', { token: 'admin', body: { action: 'requeue', confirm: 'REQUEUE' } }), { params: { id: 'e1' } })).status).toBe(409);
    expect((await eventAction(req('POST', '/x', { token: 'admin', body: { action: 'discard', confirm: 'DISCARD' } }), { params: { id: 'e2' } })).status).toBe(409);
  });
});

import { POST as resolveTrade } from '@/app/api/trades/[id]/resolve/route';

describe('operator resolution of SUBMIT_UNKNOWN', () => {
  const ID = '-1003271337051_9002';
  const ctx = { params: { id: ID } };

  beforeEach(() => {
    h.harness = createHarness();
    process.env.ALLOWED_EMAILS = ALLOWED;
  });

  function seedTrade(state: string, expiresAt: number) {
    fs().seed(`trade_sets/${ID}`, { schema: 2, trade_set_id: ID, state, mode: 'demo', submission: { submitted_at: 'x', expires_at: expiresAt, request_id: 'r' } });
    fs().seed(`alerts/submit_unknown__${ID}`, { type: 'submit_unknown', status: 'open', severity: 'critical' });
  }

  it('needs the admin role, the typed confirmation and an expired request', async () => {
    seedTrade('SUBMIT_UNKNOWN', Math.floor(Date.now() / 1000) - 30);
    const body = { resolution: 'not_executed', confirm: `RESOLVE ${ID}` };
    expect((await resolveTrade(req('POST', '/x', { token: 'viewer', body }), ctx)).status).toBe(403);
    expect((await resolveTrade(req('POST', '/x', { token: 'admin', body: { ...body, confirm: 'RESOLVE' } }), ctx)).status).toBe(400);
    // Expired only 30 s ago: the reconciler still has the call.
    expect((await resolveTrade(req('POST', '/x', { token: 'admin', body }), ctx)).status).toBe(409);
    expect(fs().peek(`trade_sets/${ID}`)?.state).toBe('SUBMIT_UNKNOWN');
  });

  it('records the resolution, an event, an audit entry and resolves the open alert; it never touches other states', async () => {
    seedTrade('SUBMIT_UNKNOWN', Math.floor(Date.now() / 1000) - 600);
    const r = await json(await resolveTrade(req('POST', '/x', { token: 'admin', body: { resolution: 'handled_manually', confirm: `RESOLVE ${ID}`, note: 'closed in MT5' } }), ctx));
    expect(r).toMatchObject({ status: 200, body: { state: 'ERROR' } });
    expect(fs().peek(`trade_sets/${ID}`)).toMatchObject({ state: 'ERROR', error: 'operator_resolved_handled_manually', operator_resolution: { by: 'admin@example.com', note: 'closed in MT5' } });
    expect(fs().peek(`trade_events/${ID}__operator_resolved`)).toMatchObject({ type: 'reconciliation' });
    expect(fs().peek(`alerts/submit_unknown__${ID}`)).toMatchObject({ status: 'resolved' });
    expect(fs().peek(`alerts/correlation_mismatch__${ID}`)).toBeUndefined();
    expect(fs().docs('admin_audit').map((d) => d.data.action)).toEqual(['trade_set.resolve']);

    fs().seed(`trade_sets/${ID}`, { state: 'OPEN', submission: { expires_at: 1 } });
    expect((await resolveTrade(req('POST', '/x', { token: 'admin', body: { resolution: 'not_executed', confirm: `RESOLVE ${ID}` } }), ctx)).status).toBe(409);
  });
});
