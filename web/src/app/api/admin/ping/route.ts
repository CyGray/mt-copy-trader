import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isResponse, requireAdmin } from '@/lib/serverAuth';

export const dynamic = 'force-dynamic';

/** POST /api/admin/ping: 200 only for an allowed admin (ALLOWED_EMAILS and users/{uid}.role). */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (isResponse(auth)) return auth;
  return NextResponse.json({ ok: true });
}
