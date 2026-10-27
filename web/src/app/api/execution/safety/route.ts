import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { validateSafetyLimits } from '@shared/executionProfile';
import { commitWithAudit, getAdminDb, jsonError, readJsonObject, settingsRef } from '@/lib/adminControl';
import { isResponse, requireAdmin } from '@/lib/serverAuth';

/** POST /api/execution/safety: replaces settings/default.safety after strict validation. */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (isResponse(auth)) return auth;

  const body = await readJsonObject(request);
  if (!body) return jsonError('Body must be a JSON object', 400);

  const result = validateSafetyLimits(body);
  if (!result.ok || !result.value) {
    return jsonError('Invalid safety limits', 400, { issues: result.errors });
  }
  const safety = result.value;

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  try {
    await commitWithAudit(db, auth, 'safety.set', { safety }, (batch) => {
      batch.set(settingsRef(db), { safety }, { mergeFields: ['safety'] });
    });
  } catch {
    return jsonError('Write failed', 503);
  }

  return NextResponse.json({ ok: true, safety, warnings: result.warnings });
}
