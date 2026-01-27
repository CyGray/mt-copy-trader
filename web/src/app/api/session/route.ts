import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const body = (await request.json()) as { token?: string };
  const token = body.token;
  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 });
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
