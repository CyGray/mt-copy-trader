import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED, createHarness, json, req, type Harness } from './harness';

const h = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/firebaseAdmin', () => ({ getAdminApp: () => h.harness?.app ?? null }));

import { GET as closeAllGet, POST as closeAll } from '@/app/api/admin/close-all/route';
import { POST as killSwitch } from '@/app/api/execution/kill-switch/route';
import { POST as setMode } from '@/app/api/execution/mode/route';
import { POST as setSafety } from '@/app/api/execution/safety/route';
import { POST as saveSettings } from '@/app/api/settings/route';
import { DEFAULT_SAFETY_LIMITS, HARD_CEILINGS } from '@shared/executionProfile';

function fs() {
  return (h.harness as Harness).fs;
}

function audits(): string[] {
  return fs().docs('admin_audit').map((d) => String(d.data.action));
}

describe('execution control routes', () => {
  beforeEach(() => {
    h.harness = createHarness();
    process.env.ALLOWED_EMAILS = ALLOWED;
  });

  describe('kill switch', () => {
    it('engages and releases with an audit entry, without touching sibling settings', async () => {
      fs().seed('settings/default', { trading: { kill_switch: false, other: 'kept' }, execution: { mode: 'demo' } });
      const on = await json(await killSwitch(req('POST', '/api/execution/kill-switch', { token: 'admin', body: { engaged: true } })));
      expect(on).toMatchObject({ status: 200, body: { kill_switch: true } });
      expect(fs().peek('settings/default')).toMatchObject({ trading: { kill_switch: true, other: 'kept' }, execution: { mode: 'demo' } });
      await killSwitch(req('POST', '/api/execution/kill-switch', { token: 'admin', body: { engaged: false } }));
      expect((fs().peek('settings/default')?.trading as Record<string, unknown>).kill_switch).toBe(false);
      expect(audits()).toEqual(['kill_switch.set', 'kill_switch.set']);
      expect(fs().docs('admin_audit')[0].data).toMatchObject({ actor_email: 'admin@example.com', details: { engaged: true } });
    });

    it('requires a boolean', async () => {
      for (const engaged of ['true', 1, null, undefined]) {
        expect((await killSwitch(req('POST', '/api/execution/kill-switch', { token: 'admin', body: { engaged } }))).status).toBe(400);
      }
    });

    it('a failed write reports 503 and leaves no audit entry behind', async () => {
      fs().failNext('batch');
      expect((await killSwitch(req('POST', '/api/execution/kill-switch', { token: 'admin', body: { engaged: true } }))).status).toBe(503);
      expect(audits()).toEqual([]);
    });
  });

  describe('execution mode', () => {
    it('demo and live need their typed confirmations; disabled and paper do not', async () => {
      expect((await setMode(req('POST', '/api/execution/mode', { token: 'admin', body: { mode: 'demo' } }))).status).toBe(400);
      expect((await setMode(req('POST', '/api/execution/mode', { token: 'admin', body: { mode: 'live', confirm: 'ENABLE DEMO TRADING' } }))).status).toBe(400);
      expect((await setMode(req('POST', '/api/execution/mode', { token: 'admin', body: { mode: 'paper' } }))).status).toBe(200);
      const demo = await json(await setMode(req('POST', '/api/execution/mode', { token: 'admin', body: { mode: 'demo', confirm: 'ENABLE DEMO TRADING' } })));
      expect(demo.status).toBe(200);
      const live = await json(await setMode(req('POST', '/api/execution/mode', { token: 'admin', body: { mode: 'live', confirm: 'ENABLE LIVE TRADING' } })));
      expect(live.body.note).toContain('BYTRADER_LIVE_TRADING');
      expect((fs().peek('settings/default')?.execution as Record<string, unknown>).mode).toBe('live');
    });

    it('rejects unknown modes and keeps the active profile id', async () => {
      fs().seed('settings/default', { execution: { mode: 'disabled', active_profile_doc_id: 'p__v1' } });
      expect((await setMode(req('POST', '/api/execution/mode', { token: 'admin', body: { mode: 'yolo' } }))).status).toBe(400);
      await setMode(req('POST', '/api/execution/mode', { token: 'admin', body: { mode: 'paper' } }));
      expect(fs().peek('settings/default')?.execution).toMatchObject({ mode: 'paper', active_profile_doc_id: 'p__v1' });
    });

    it('a viewer cannot change the mode', async () => {
      expect((await setMode(req('POST', '/api/execution/mode', { token: 'viewer', body: { mode: 'disabled' } }))).status).toBe(403);
    });
  });

  describe('safety limits', () => {
    it('stores valid limits and refuses a value above a hard ceiling with field, value and limit', async () => {
      expect((await setSafety(req('POST', '/api/execution/safety', { token: 'admin', body: DEFAULT_SAFETY_LIMITS }))).status).toBe(200);
      const tooHigh = HARD_CEILINGS.max_lots_per_trade * 10;
      const r = await json(await setSafety(req('POST', '/api/execution/safety', { token: 'admin', body: { ...DEFAULT_SAFETY_LIMITS, max_lots_per_trade: tooHigh } })));
      expect(r.status).toBe(400);
      expect(r.body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'max_lots_per_trade', value: tooHigh, limit: HARD_CEILINGS.max_lots_per_trade })]));
      expect(fs().peek('settings/default')?.safety).toMatchObject({ max_lots_per_trade: DEFAULT_SAFETY_LIMITS.max_lots_per_trade });
    });
  });

  describe('close-all', () => {
    it('refuses without the exact typed confirmation and queues nothing', async () => {
      for (const confirm of [undefined, 'close all', 'CLOSEALL', 'CLOSE ALL ']) {
        const r = await closeAll(req('POST', '/api/admin/close-all', { token: 'admin', body: { confirm } }));
        expect(r.status).toBe(400);
      }
      expect(fs().docs('admin_commands')).toEqual([]);
    });

    it('queues a close_all command for the AutoTrader with an audit entry; the web never touches the broker', async () => {
      const r = await json(await closeAll(req('POST', '/api/admin/close-all', { token: 'admin', body: { confirm: 'CLOSE ALL' } })));
      expect(r.status).toBe(201);
      const [cmd] = fs().docs('admin_commands');
      expect(cmd.id).toBe(r.body.id);
      expect(cmd.data).toMatchObject({ type: 'close_all', status: 'pending', confirm: 'CLOSE ALL', requested_by_email: 'admin@example.com' });
      expect(audits()).toEqual(['close_all.request']);

      const status = await json(await closeAllGet(req('GET', `/api/admin/close-all?id=${r.body.id}`, { token: 'viewer' })));
      expect(status.body).toMatchObject({ id: r.body.id, status: 'pending' });
    });

    it('a viewer cannot request close-all', async () => {
      expect((await closeAll(req('POST', '/api/admin/close-all', { token: 'viewer', body: { confirm: 'CLOSE ALL' } }))).status).toBe(403);
      expect(fs().docs('admin_commands')).toEqual([]);
    });

    it('validates the command id on status reads', async () => {
      expect((await closeAllGet(req('GET', '/api/admin/close-all?id=../../x', { token: 'viewer' }))).status).toBe(400);
    });
  });
  describe('settings', () => {
    it('saves telegram channel lists without touching execution, kill switch or safety', async () => {
      fs().seed('settings/default', { execution: { mode: 'demo' }, trading: { kill_switch: true }, safety: { max_lots_per_trade: 1 } });
      const r = await json(await saveSettings(req('POST', '/api/settings', { token: 'admin', body: { telegram: { allowed_chat_ids: ['-1003271337051', '-1003271337051'], chat_id_labels: { '-1003271337051': 'VIP' } } } })));
      expect(r).toMatchObject({ status: 200, body: { updated: ['telegram.allowed_chat_ids', 'telegram.chat_id_labels'] } });
      expect(fs().peek('settings/default')).toMatchObject({
        execution: { mode: 'demo' },
        trading: { kill_switch: true },
        safety: { max_lots_per_trade: 1 },
        telegram: { allowed_chat_ids: ['-1003271337051'], chat_id_labels: { '-1003271337051': 'VIP' } },
      });
    });

    it('refuses the Bybit-era trading knobs and the kill switch, with a reason', async () => {
      const r = await json(await saveSettings(req('POST', '/api/settings', { token: 'admin', body: { trading: { mt5_optional: true, risk_mode: 'FIXED_USDT', kill_switch: false } } })));
      expect(r.status).toBe(400);
      const issues = r.body.issues as Array<{ path: string; message: string }>;
      expect(issues.find((i) => i.path === 'trading.mt5_optional')?.message).toContain('no longer used');
      expect(issues.find((i) => i.path === 'trading.kill_switch')?.message).toContain('/api/execution/kill-switch');
      expect(fs().peek('settings/default')).toBeUndefined();
    });

    it('refuses execution and safety keys and viewers', async () => {
      expect((await saveSettings(req('POST', '/api/settings', { token: 'admin', body: { execution: { mode: 'live' } } }))).status).toBe(400);
      expect((await saveSettings(req('POST', '/api/settings', { token: 'viewer', body: { telegram: { allowed_chat_ids: [] } } }))).status).toBe(403);
    });
  });
});
