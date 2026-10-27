import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAdminDb, jsonError } from '@/lib/adminControl';
import { isResponse, requireUser } from '@/lib/serverAuth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/role: role of the caller. The token comes from the Authorization
 * header or the session cookie (set by /api/session just before this call); a
 * token in the body is no longer accepted. ALLOWED_EMAILS applies.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (isResponse(auth)) return auth;

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  try {
    const snap = await db.collection('users').doc(auth.uid).get();
    return NextResponse.json({ uid: auth.uid, role: snap.data()?.role ?? 'viewer' });
  } catch {
    return jsonError('Role lookup unavailable', 503);
  }
}
