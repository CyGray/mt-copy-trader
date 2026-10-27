import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAdminDb, jsonError } from '@/lib/adminControl';
import { isResponse, requireUser } from '@/lib/serverAuth';
import { asString, PROFILE_AUDIT_COLLECTION } from '../_shared';

export const dynamic = 'force-dynamic';

/** GET /api/profiles/audit?limit=50: most recent execution_profile_audit entries (newest first). */
export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (isResponse(auth)) return auth;

  const requested = Number(request.nextUrl.searchParams.get('limit') ?? '50');
  const limit = Number.isFinite(requested) ? Math.min(200, Math.max(1, Math.floor(requested))) : 50;

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  try {
    const snap = await db.collection(PROFILE_AUDIT_COLLECTION).orderBy('at', 'desc').limit(limit).get();
    const entries = snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        action: asString(data.action),
        profile_doc_id: asString(data.profile_doc_id),
        previous_active_doc_id: asString(data.previous_active_doc_id),
        actor_email: asString(data.actor_email),
        at: asString(data.at),
        details: data.details ?? null,
      };
    });
    return NextResponse.json({ entries });
  } catch {
    return jsonError('Read failed', 503);
  }
}
