import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED, createHarness, json, req, type Harness } from './harness';

const h = vi.hoisted(() => ({ harness: null as Harness | null, cookies: [] as Array<{ name: string; value: string }> }));

vi.mock('@/lib/firebaseAdmin', () => ({ getAdminApp: () => h.harness?.app ?? null }));
vi.mock('next/headers', () => ({
  cookies: () => ({ set: (name: string, value: string) => h.cookies.push({ name, value }) }),
}));

import { GET as alertsGet } from '@/app/api/alerts/route';
import { POST as killSwitch } from '@/app/api/execution/kill-switch/route';
import { GET as status } from '@/app/api/execution/status/route';
import { POST as rolePost } from '@/app/api/admin/role/route';
import { POST as sessionPost } from '@/app/api/session/route';
import { POST as ensureUser } from '@/app/api/users/ensure/route';

function fs() {
  return (h.harness as Harness).fs;
}

describe('server-side authorization', () => {
  beforeEach(() => {
    h.harness = createHarness();
    h.cookies = [];
    process.env.ALLOWED_EMAILS = ALLOWED;
  });

  afterEach(() => {
    delete process.env.ALLOWED_EMAILS;
  });

  describe('unauthenticated and invalid tokens', () => {
    it('refuses a request without a token (401) on user and admin routes', async () => {
      expect((await status(req('GET', '/api/execution/status'))).status).toBe(401);
      expect((await killSwitch(req('POST', '/api/execution/kill-switch', { body: { engaged: true } }))).status).toBe(401);
      expect(fs().peek('settings/default')).toBeUndefined();
    });

    it('refuses a malformed Authorization header instead of falling back to the cookie', async () => {
      const res = await status(req('GET', '/api/execution/status', { authorization: 'Token admin', cookie: 'bytrader_session=admin' }));
      expect(res.status).toBe(401);
    });

    it('refuses an invalid or revoked token (401) and checks revocation', async () => {
      expect((await status(req('GET', '/api/execution/status', { token: 'garbage' }))).status).toBe(401);
      expect((await status(req('GET', '/api/execution/status', { token: 'revoked' }))).status).toBe(401);
      expect(h.harness?.verifyCalls.every((c) => c.checkRevoked === true)).toBe(true);
    });

    it('reports token verification outages as 503, not as a pass', async () => {
      const r = await json(await status(req('GET', '/api/execution/status', { token: 'infra' })));
      expect(r.status).toBe(503);
    });

    it('returns 503 when firebase-admin is not configured', async () => {
      h.harness = null;
      expect((await status(req('GET', '/api/execution/status', { token: 'admin' }))).status).toBe(503);
    });

    it('accepts the session cookie when there is no Authorization header', async () => {
      expect((await status(req('GET', '/api/execution/status', { cookie: 'bytrader_session=viewer' }))).status).toBe(200);
    });
  });

  describe('ALLOWED_EMAILS', () => {
    it('fails closed when ALLOWED_EMAILS is missing: even the admin is refused', async () => {
      delete process.env.ALLOWED_EMAILS;
      const r = await json(await status(req('GET', '/api/execution/status', { token: 'admin' })));
      expect(r.status).toBe(403);
      expect(r.body.error).toContain('ALLOWED_EMAILS');
      expect((await killSwitch(req('POST', '/api/execution/kill-switch', { token: 'admin', body: { engaged: true } }))).status).toBe(403);
      expect(fs().peek('settings/default')).toBeUndefined();
    });

    it('fails closed when ALLOWED_EMAILS is blank', async () => {
      process.env.ALLOWED_EMAILS = '  ,  ';
      expect((await alertsGet(req('GET', '/api/alerts', { token: 'viewer' }))).status).toBe(403);
    });

    it('a missing allow-list also blocks first sign-in: no session cookie and no users document', async () => {
      delete process.env.ALLOWED_EMAILS;
      const session = await sessionPost(new Request('http://localhost/api/session', { method: 'POST', body: JSON.stringify({ token: 'newcomer' }) }));
      expect(session.status).toBe(403);
      expect(h.cookies).toEqual([]);
      expect((await ensureUser(req('POST', '/api/users/ensure', { token: 'newcomer' }))).status).toBe(403);
      expect(fs().peek('users/u-newcomer')).toBeUndefined();
    });

    it('refuses an email that is not on the list, matching case-insensitively', async () => {
      expect((await status(req('GET', '/api/execution/status', { token: 'outsider' }))).status).toBe(403);
      // 'Viewer@example.com' in the list matches viewer@example.com.
      expect((await status(req('GET', '/api/execution/status', { token: 'viewer' }))).status).toBe(200);
    });

    it('refuses an unverified email even when it is on the list', async () => {
      const r = await json(await killSwitch(req('POST', '/api/execution/kill-switch', { token: 'unverified', body: { engaged: true } })));
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('Email not verified');
    });

    it('refuses a token without an email', async () => {
      expect((await status(req('GET', '/api/execution/status', { token: 'noemail' }))).status).toBe(403);
    });
  });

  describe('roles', () => {
    it('a viewer can read but not change execution control', async () => {
      expect((await status(req('GET', '/api/execution/status', { token: 'viewer' }))).status).toBe(200);
      const r = await json(await killSwitch(req('POST', '/api/execution/kill-switch', { token: 'viewer', body: { engaged: true } })));
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('Admin role required');
      expect(fs().peek('settings/default')).toBeUndefined();
    });

    it('an allow-listed user without a users document is not an admin', async () => {
      expect((await killSwitch(req('POST', '/api/execution/kill-switch', { token: 'newcomer', body: { engaged: true } }))).status).toBe(403);
    });

    it('a failed role lookup is 503 and changes nothing', async () => {
      fs().failNext('get');
      const r = await killSwitch(req('POST', '/api/execution/kill-switch', { token: 'admin', body: { engaged: true } }));
      expect(r.status).toBe(503);
      expect(fs().peek('settings/default')).toBeUndefined();
    });

    it('/api/admin/role reports the stored role and defaults to viewer', async () => {
      expect((await json(await rolePost(req('POST', '/api/admin/role', { token: 'admin' })))).body.role).toBe('admin');
      expect((await json(await rolePost(req('POST', '/api/admin/role', { token: 'newcomer' })))).body.role).toBe('viewer');
    });
  });

  describe('first sign-in', () => {
    it('creates a viewer users document for an allow-listed account, never an admin', async () => {
      const r = await json(await ensureUser(req('POST', '/api/users/ensure', { token: 'newcomer' })));
      expect(r).toMatchObject({ status: 200, body: { role: 'viewer', created: true } });
      expect(fs().peek('users/u-newcomer')).toMatchObject({ role: 'viewer', email: 'newcomer@example.com' });
    });

    it('never changes an existing role', async () => {
      const r = await json(await ensureUser(req('POST', '/api/users/ensure', { token: 'admin' })));
      expect(r.body).toMatchObject({ role: 'admin', created: false });
      expect(fs().peek('users/u-admin')?.role).toBe('admin');
    });

    it('sets the httpOnly session cookie only for an allowed, verified account', async () => {
      const ok = await sessionPost(new Request('http://localhost/api/session', { method: 'POST', body: JSON.stringify({ token: 'viewer' }) }));
      expect(ok.status).toBe(200);
      expect(h.cookies).toEqual([{ name: 'bytrader_session', value: 'viewer' }]);
      h.cookies = [];
      for (const token of ['outsider', 'unverified']) {
        const res = await sessionPost(new Request('http://localhost/api/session', { method: 'POST', body: JSON.stringify({ token }) }));
        expect(res.status).toBe(403);
      }
      const bad = await sessionPost(new Request('http://localhost/api/session', { method: 'POST', body: JSON.stringify({ token: 'revoked' }) }));
      expect(bad.status).toBe(401);
      const missing = await sessionPost(new Request('http://localhost/api/session', { method: 'POST', body: 'not json' }));
      expect(missing.status).toBe(400);
      expect(h.cookies).toEqual([]);
    });
  });
});
