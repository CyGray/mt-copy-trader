import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isResponse, requireAdmin } from '@/lib/serverAuth';
import { getWorkerUrl, workerHeaders } from '@/lib/workerApi';

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (isResponse(auth)) return auth;

  try {
    const response = await fetch(`${getWorkerUrl()}/telegram/logout`, {
      method: 'POST',
      headers: workerHeaders(),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch {
    return NextResponse.json({ error: 'Worker unreachable' }, { status: 502 });
  }
}
