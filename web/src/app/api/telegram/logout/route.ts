import { NextResponse } from 'next/server';
import { getWorkerUrl } from '@/lib/workerApi';

export async function POST() {
  try {
    const response = await fetch(`${getWorkerUrl()}/telegram/logout`, {
      method: 'POST',
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch {
    return NextResponse.json({ error: 'Worker unreachable' }, { status: 502 });
  }
}
