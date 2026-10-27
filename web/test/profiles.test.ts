import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED, createHarness, json, req, type Harness } from './harness';

const h = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/firebaseAdmin', () => ({ getAdminApp: () => h.harness?.app ?? null }));
// The AutoTrader's execution control reads the same (fake) Firestore.
vi.mock('../../worker/src/lib/firestoreAdmin', () => ({ initFirestore: () => h.harness?.fs ?? null }));
vi.mock('../../worker/src/lib/systemLog', () => ({ writeSystemLog: async () => true }));

import { GET as listProfiles, POST as createProfile } from '@/app/api/profiles/route';
import { GET as getProfile, PUT as putProfile } from '@/app/api/profiles/[docId]/route';
import { POST as approve } from '@/app/api/profiles/[docId]/approve/route';
import { POST as activate } from '@/app/api/profiles/[docId]/activate/route';
import { POST as rollback } from '@/app/api/profiles/rollback/route';
import { POST as validate } from '@/app/api/profiles/validate/route';
import { POST as setSafety } from '@/app/api/execution/safety/route';
import { DEFAULT_SAFETY_LIMITS } from '@shared/executionProfile';
import { canOpenNewEntries, getExecutionControl, invalidateExecutionControl } from '@shared/executionControl';

const EXAMPLE = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../docs/project_memory/examples/optimal_report_profile.example.json'), 'utf8'),
) as Record<string, unknown>;

function draftBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { version: _v, ...rest } = EXAMPLE;
  void _v;
  return { ...rest, profile_id: 'xau-test', ...over };
}

function fs() {
  return (h.harness as Harness).fs;
}

const ctx = (docId: string) => ({ params: { docId } });

async function createApproved(): Promise<string> {
  const created = await json(await createProfile(req('POST', '/api/profiles', { token: 'admin', body: draftBody() })));
  const docId = String(created.body.doc_id);
  expect((await approve(req('POST', `/api/profiles/${docId}/approve`, { token: 'admin' }), ctx(docId))).status).toBe(200);
  return docId;
}

async function activateDoc(docId: string) {
  return json(await activate(req('POST', `/api/profiles/${docId}/activate`, { token: 'admin', body: { confirm: `ACTIVATE ${docId}` } }), ctx(docId)));
}

describe('execution profile routes', () => {
  beforeEach(() => {
    h.harness = createHarness();
    process.env.ALLOWED_EMAILS = ALLOWED;
  });

  describe('creation', () => {
    it('an admin creates a draft; the server assigns the version and audits it twice', async () => {
      const r = await json(await createProfile(req('POST', '/api/profiles', { token: 'admin', body: draftBody({ version: 99, status: 'active' }) })));
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ doc_id: 'xau-test__v1', version: 1, status: 'draft' });
      expect(r.body.notes).toEqual(expect.arrayContaining(['Ignored server-managed field "status".']));
      const doc = fs().peek('execution_profiles/xau-test__v1');
      expect(doc).toMatchObject({ status: 'draft', version: 1, created_by: 'admin@example.com' });
      expect((doc?.validation as { ok: boolean }).ok).toBe(true);
      expect(fs().docs('execution_profile_audit').map((d) => d.data.action)).toEqual(['create_draft']);
      expect(fs().docs('admin_audit').map((d) => d.data.action)).toEqual(['profile.create_draft']);

      const second = await json(await createProfile(req('POST', '/api/profiles', { token: 'admin', body: draftBody() })));
      expect(second.body.doc_id).toBe('xau-test__v2');
    });

    it('a viewer cannot create a profile', async () => {
      const r = await createProfile(req('POST', '/api/profiles', { token: 'viewer', body: draftBody() }));
      expect(r.status).toBe(403);
      expect(fs().docs('execution_profiles')).toEqual([]);
    });

    it('refuses a missing or malformed profile_id (needed for the document id)', async () => {
      for (const profile_id of [undefined, 'X', 'has spaces', '-leading']) {
        const r = await createProfile(req('POST', '/api/profiles', { token: 'admin', body: draftBody({ profile_id }) }));
        expect(r.status).toBe(400);
      }
      expect((await createProfile(req('POST', '/api/profiles', { token: 'admin', rawBody: '[1]' }))).status).toBe(400);
    });

    it('an invalid draft is saved (so it can be fixed) but marked invalid', async () => {
      const r = await json(await createProfile(req('POST', '/api/profiles', { token: 'admin', body: draftBody({ sizing: { mode: 'fixed_lots', fixed_lots: 500, below_min_volume: 'skip' } }) })));
      expect(r.status).toBe(201);
      expect((r.body.validation as { ok: boolean }).ok).toBe(false);
    });

    it('only drafts can be edited, and profile_id cannot change', async () => {
      const docId = await createApproved();
      expect((await putProfile(req('PUT', `/api/profiles/${docId}`, { token: 'admin', body: draftBody() }), ctx(docId))).status).toBe(409);
      const d = await json(await createProfile(req('POST', '/api/profiles', { token: 'admin', body: draftBody() })));
      const draftId = String(d.body.doc_id);
      expect((await putProfile(req('PUT', `/api/profiles/${draftId}`, { token: 'admin', body: draftBody({ profile_id: 'other-id' }) }), ctx(draftId))).status).toBe(400);
      const ok = await json(await putProfile(req('PUT', `/api/profiles/${draftId}`, { token: 'admin', body: draftBody({ name: 'renamed' }) }), ctx(draftId)));
      expect(ok.status).toBe(200);
      expect(ok.body.changed_keys).toEqual(['name']);
    });
  });

  describe('validation and approval', () => {
    it('validate is read-only and reports hard-ceiling errors with field, value and limit', async () => {
      const r = await json(await validate(req('POST', '/api/profiles/validate', { token: 'viewer', body: { profile: draftBody({ sizing: { mode: 'fixed_lots', fixed_lots: 500, below_min_volume: 'skip' } }) } })));
      expect(r.status).toBe(200);
      const v = r.body.validation as { ok: boolean; errors: Array<{ path: string; value?: unknown; limit?: unknown }> };
      expect(v.ok).toBe(false);
      expect(v.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'sizing.fixed_lots', value: 500 })]));
      expect(v.errors.find((e) => e.path === 'sizing.fixed_lots')?.limit).toBeDefined();
      expect(fs().docs('execution_profiles')).toEqual([]);
    });

    it('approval refuses a profile that does not validate', async () => {
      const d = await json(await createProfile(req('POST', '/api/profiles', { token: 'admin', body: draftBody({ sizing: { mode: 'fixed_lots', fixed_lots: 500, below_min_volume: 'skip' } }) })));
      const docId = String(d.body.doc_id);
      const r = await json(await approve(req('POST', `/api/profiles/${docId}/approve`, { token: 'admin' }), ctx(docId)));
      expect(r.status).toBe(422);
      expect(fs().peek(`execution_profiles/${docId}`)?.status).toBe('draft');
    });

    it('approval refuses a profile that exceeds the current safety limits', async () => {
      fs().seed('settings/default', { safety: { ...DEFAULT_SAFETY_LIMITS, max_risk_percent_per_trade: 0.25 } });
      const d = await json(await createProfile(req('POST', '/api/profiles', { token: 'admin', body: draftBody() })));
      const docId = String(d.body.doc_id);
      const r = await json(await approve(req('POST', `/api/profiles/${docId}/approve`, { token: 'admin' }), ctx(docId)));
      expect(r.status).toBe(422);
      expect(r.body.error).toContain('safety');
    });

    it('a viewer cannot approve', async () => {
      const d = await json(await createProfile(req('POST', '/api/profiles', { token: 'admin', body: draftBody() })));
      const docId = String(d.body.doc_id);
      expect((await approve(req('POST', `/api/profiles/${docId}/approve`, { token: 'viewer' }), ctx(docId))).status).toBe(403);
    });
  });

  describe('activation and rollback', () => {
    it('activation needs the exact typed confirmation', async () => {
      const docId = await createApproved();
      for (const confirm of [undefined, 'ACTIVATE', `activate ${docId}`]) {
        const r = await activate(req('POST', `/api/profiles/${docId}/activate`, { token: 'admin', body: { confirm } }), ctx(docId));
        expect(r.status).toBe(400);
      }
      expect(fs().peek('settings/default')).toBeUndefined();
    });

    it('activates, supersedes the previous version, keeps execution.mode, and rolls back', async () => {
      fs().seed('settings/default', { execution: { mode: 'demo' } });
      const v1 = await createApproved();
      expect((await activateDoc(v1)).status).toBe(200);
      expect(fs().peek('settings/default')?.execution).toMatchObject({ mode: 'demo', active_profile_doc_id: v1 });

      const v2 = await createApproved();
      const r = await activateDoc(v2);
      expect(r.body).toMatchObject({ doc_id: v2, previous_active_doc_id: v1 });
      expect(fs().peek(`execution_profiles/${v1}`)?.status).toBe('superseded');
      expect(fs().peek(`execution_profiles/${v2}`)?.status).toBe('active');

      const rb = await json(await rollback(req('POST', '/api/profiles/rollback', { token: 'admin', body: {} })));
      expect(rb.status).toBe(200);
      expect(rb.body).toMatchObject({ doc_id: v1, previous_active_doc_id: v2 });
      expect(fs().peek('settings/default')?.execution).toMatchObject({ mode: 'demo', active_profile_doc_id: v1 });
      expect(fs().peek(`execution_profiles/${v2}`)?.status).toBe('superseded');
      expect(fs().docs('execution_profile_audit').map((d) => d.data.action)).toEqual([
        'create_draft',
        'approve',
        'activate',
        'create_draft',
        'approve',
        'activate',
        'rollback',
      ]);
    });

    it('an approved profile that no longer fits tightened safety limits cannot be activated', async () => {
      const docId = await createApproved();
      const tightened = await setSafety(req('POST', '/api/execution/safety', { token: 'admin', body: { ...DEFAULT_SAFETY_LIMITS, max_risk_percent_per_trade: 0.25 } }));
      expect(tightened.status).toBe(200);
      const r = await activateDoc(docId);
      expect(r.status).toBe(422);
      expect(fs().peek(`execution_profiles/${docId}`)?.status).toBe('approved');
      expect((fs().peek('settings/default')?.execution as Record<string, unknown> | undefined)?.active_profile_doc_id).toBeUndefined();
    });

    it('drafts cannot be activated, and rollback without a superseded version is refused', async () => {
      const d = await json(await createProfile(req('POST', '/api/profiles', { token: 'admin', body: draftBody() })));
      const docId = String(d.body.doc_id);
      expect((await activateDoc(docId)).status).toBe(409);
      expect((await rollback(req('POST', '/api/profiles/rollback', { token: 'admin', body: {} }))).status).toBe(409);
    });

    it('viewers can list and read profiles but not activate or roll back', async () => {
      const docId = await createApproved();
      expect((await listProfiles(req('GET', '/api/profiles', { token: 'viewer' }))).status).toBe(200);
      expect((await getProfile(req('GET', `/api/profiles/${docId}`, { token: 'viewer' }), ctx(docId))).status).toBe(200);
      const r = await activate(req('POST', `/api/profiles/${docId}/activate`, { token: 'viewer', body: { confirm: `ACTIVATE ${docId}` } }), ctx(docId));
      expect(r.status).toBe(403);
      expect((await rollback(req('POST', '/api/profiles/rollback', { token: 'viewer', body: {} }))).status).toBe(403);
    });
  });
  describe('hand-off to the AutoTrader', () => {
    it('a profile activated through the API is accepted by the AutoTrader execution control (regression)', async () => {
      fs().seed('settings/default', { execution: { mode: 'demo' }, trading: { kill_switch: false } });
      const docId = await createApproved();
      expect((await activateDoc(docId)).status).toBe(200);
      invalidateExecutionControl();
      const control = await getExecutionControl();
      expect(control.profileErrors).toEqual([]);
      expect(control.activeProfileDocId).toBe(docId);
      expect(canOpenNewEntries(control)).toEqual({ allowed: true });
    });
  });
});
