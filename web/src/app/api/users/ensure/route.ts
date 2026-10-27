import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAdminDb, jsonError } from '@/lib/adminControl';
import { isResponse, requireUser } from '@/lib/serverAuth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/users/ensure: first sign-in. Creates users/{uid} with role viewer only
 * when the document is missing. An existing role is never changed, and admin is
 * never granted here; admins are set manually in the Firebase console.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (isResponse(auth)) return auth;

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  const ref = db.collection('users').doc(auth.uid);
  try {
    const snap = await ref.get();
    if (snap.exists) {
      return NextResponse.json({ uid: auth.uid, role: snap.data()?.role ?? 'viewer', created: false });
    }

    try {
      await ref.create({
        uid: auth.uid,
        email: auth.email || null,
        role: 'viewer',
        created_at: new Date().toISOString(),
      });
      return NextResponse.json({ uid: auth.uid, role: 'viewer', created: true });
    } catch (err) {
      // Created by a concurrent request: report the stored role instead.
      if ((err as { code?: unknown })?.code !== 6) throw err;
      const again = await ref.get();
      return NextResponse.json({ uid: auth.uid, role: again.data()?.role ?? 'viewer', created: false });
    }
  } catch {
    return jsonError('Write failed', 503);
  }
}
