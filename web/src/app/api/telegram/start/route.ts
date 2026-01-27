import { NextResponse } from 'next/server';
import { getWorkerUrl } from '@/lib/workerApi';

export async function POST(request: Request) {
  const body = (await request.json()) as { phone?: string };
  if (!body.phone) {
    return NextResponse.json({ error: 'Missing phone' }, { status: 400 });
  }

  try {
    const response = await fetch(`${getWorkerUrl()}/telegram/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: body.phone }),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch {
    return NextResponse.json({ error: 'Worker unreachable' }, { status: 502 });
  }
}
