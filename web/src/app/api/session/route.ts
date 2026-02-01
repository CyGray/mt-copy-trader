import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { getAdminApp } from '@/lib/firebaseAdmin';

function getAllowedEmails(): string[] | null {
  const raw = process.env.ALLOWED_EMAILS ?? '';
  if (!raw.trim()) return null; // null means allow all
  return raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export async function POST(request: Request) {
  const body = (await request.json()) as { token?: string };
  const token = body.token;
  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 });
  }

  const adminApp = getAdminApp();
  if (!adminApp) {
    return NextResponse.json({ error: 'Admin not configured' }, { status: 500 });
  }

  try {
    const decoded = await adminApp.auth().verifyIdToken(token);
    const allowedEmails = getAllowedEmails();
    const email = decoded.email?.toLowerCase();
    // If allowedEmails is null, allow all emails
    if (allowedEmails !== null && (!email || !allowedEmails.includes(email))) {
      return NextResponse.json({ error: 'Email not allowed' }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  cookies().set('bytrader_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  cookies().set('bytrader_session', '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  return NextResponse.json({ ok: true });
}
