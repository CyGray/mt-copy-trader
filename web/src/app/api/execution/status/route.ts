import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { DEFAULT_SAFETY_LIMITS, validateSafetyLimits } from '@shared/executionProfile';
import { getAdminDb, jsonError, SETTINGS_COLLECTION, SETTINGS_DOC_ID } from '@/lib/adminControl';
import { isResponse, requireUser } from '@/lib/serverAuth';

export const dynamic = 'force-dynamic';

/** GET /api/execution/status: read-only view of the execution control state. */
export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (isResponse(auth)) return auth;

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  let data: Record<string, unknown>;
  try {
    const snap = await db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC_ID).get();
    data = (snap.data() ?? {}) as Record<string, unknown>;
  } catch {
    return jsonError('Read failed', 503);
  }

  const execution = (data.execution ?? {}) as Record<string, unknown>;
  const trading = (data.trading ?? {}) as Record<string, unknown>;
  const activeProfileDocId =
    typeof execution.active_profile_doc_id === 'string' ? execution.active_profile_doc_id : null;

  const storedSafety = data.safety ?? null;
  const safetyCheck = storedSafety === null ? null : validateSafetyLimits(storedSafety);

  return NextResponse.json({
    execution: {
      mode: typeof execution.mode === 'string' ? execution.mode : 'disabled',
      active_profile_doc_id: activeProfileDocId,
      updated_at: typeof execution.updated_at === 'string' ? execution.updated_at : null,
      updated_by: typeof execution.updated_by === 'string' ? execution.updated_by : null,
    },
    trading: { kill_switch: trading.kill_switch === true },
    safety: storedSafety ?? DEFAULT_SAFETY_LIMITS,
    safety_source: storedSafety === null ? 'default' : 'stored',
    safety_errors: safetyCheck && !safetyCheck.ok ? safetyCheck.errors : [],
    active_profile_doc_id: activeProfileDocId,
  });
}
