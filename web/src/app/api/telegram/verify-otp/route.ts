import { NextResponse } from 'next/server';
import { getWorkerUrl } from '@/lib/workerApi';

export async function POST(request: Request) {
  const body = (await request.json()) as { code?: string };
  if (!body.code) {
    return NextResponse.json({ error: 'Missing code' }, { status: 400 });
  }

  try {
    const response = await fetch(`${getWorkerUrl()}/telegram/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: body.code }),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch {
    return NextResponse.json({ error: 'Worker unreachable' }, { status: 502 });
  }
}
