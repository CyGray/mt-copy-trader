import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { commitWithAudit, getAdminDb, jsonError, readJsonObject, settingsRef } from '@/lib/adminControl';
import { isResponse, requireAdmin } from '@/lib/serverAuth';

const MODES = ['disabled', 'paper', 'demo', 'live'] as const;
type Mode = (typeof MODES)[number];

const REQUIRED_CONFIRM: Partial<Record<Mode, string>> = {
  demo: 'ENABLE DEMO TRADING',
  live: 'ENABLE LIVE TRADING',
};

const LIVE_NOTE =
  'Live entries also require BYTRADER_LIVE_TRADING=enabled in the worker environment. Without it the worker refuses new entries (live_not_enabled).';

/** POST /api/execution/mode: sets settings/default.execution.mode. */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (isResponse(auth)) return auth;

  const body = await readJsonObject(request);
  if (!body) return jsonError('Body must be a JSON object', 400);

  const mode = body.mode;
  if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) {
    return jsonError('mode must be one of disabled, paper, demo, live', 400);
  }
  const target = mode as Mode;

  const required = REQUIRED_CONFIRM[target];
  if (required && body.confirm !== required) {
    return jsonError(`Typed confirmation required for ${target}`, 400, { required_confirm: required });
  }

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  const updatedAt = new Date().toISOString();
  try {
    await commitWithAudit(db, auth, 'execution.mode', { mode: target }, (batch) => {
      batch.set(
        settingsRef(db),
        { execution: { mode: target, updated_at: updatedAt, updated_by: auth.email } },
        { mergeFields: ['execution.mode', 'execution.updated_at', 'execution.updated_by'] },
      );
    });
  } catch {
    return jsonError('Write failed', 503);
  }

  return NextResponse.json({
    ok: true,
    mode: target,
    updated_at: updatedAt,
    ...(target === 'live' ? { note: LIVE_NOTE } : {}),
  });
}
