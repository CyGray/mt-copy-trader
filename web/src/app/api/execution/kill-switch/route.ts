import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { commitWithAudit, getAdminDb, jsonError, readJsonObject, settingsRef } from '@/lib/adminControl';
import { isResponse, requireAdmin } from '@/lib/serverAuth';

/**
 * POST /api/execution/kill-switch: sets trading.kill_switch. Engaged blocks new
 * entries and pending orders; protective management of open trades continues.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (isResponse(auth)) return auth;

  const body = await readJsonObject(request);
  if (!body || typeof body.engaged !== 'boolean') {
    return jsonError('engaged must be a boolean', 400);
  }
  const engaged = body.engaged;

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  try {
    await commitWithAudit(db, auth, 'kill_switch.set', { engaged }, (batch) => {
      batch.set(settingsRef(db), { trading: { kill_switch: engaged } }, { mergeFields: ['trading.kill_switch'] });
    });
  } catch {
    return jsonError('Write failed', 503);
  }

  return NextResponse.json({ ok: true, kill_switch: engaged });
}
