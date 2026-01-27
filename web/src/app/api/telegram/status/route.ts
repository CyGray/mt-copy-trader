import { NextResponse } from 'next/server';
import { getWorkerUrl } from '@/lib/workerApi';

export async function GET() {
  const target = `${getWorkerUrl()}/telegram/status`;

  try {
    const response = await fetch(target, { cache: 'no-store' });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch {
    return NextResponse.json(
      { status: 'error', lastError: 'worker_unreachable' },
      { status: 502 },
    );
  }
}
