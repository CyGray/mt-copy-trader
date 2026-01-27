import { NextResponse } from 'next/server';
import { getWorkerUrl } from '@/lib/workerApi';

export async function POST(request: Request) {
  const body = (await request.json()) as { password?: string };
  if (!body.password) {
    return NextResponse.json({ error: 'Missing password' }, { status: 400 });
  }

  try {
    const response = await fetch(`${getWorkerUrl()}/telegram/verify-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: body.password }),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch {
    return NextResponse.json({ error: 'Worker unreachable' }, { status: 502 });
  }
}
