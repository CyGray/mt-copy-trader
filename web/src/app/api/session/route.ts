import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { getAdminApp } from '@/lib/firebaseAdmin';
import { emailRefusal, SESSION_COOKIE } from '@/lib/serverAuth';

/** POST /api/session: stores a verified ID token in an httpOnly cookie. Same email rules as every route. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === 'string' ? body.token : '';
  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 });
  }

  const adminApp = getAdminApp();
  if (!adminApp) {
    return NextResponse.json({ error: 'Admin not configured' }, { status: 503 });
  }

  let decoded;
  try {
    decoded = await adminApp.auth().verifyIdToken(token, true);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const refusal = emailRefusal(decoded);
  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: 403 });
  }

  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  cookies().set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });

  return NextResponse.json({ ok: true });
}
