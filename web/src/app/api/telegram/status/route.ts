import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isResponse, requireAdmin } from '@/lib/serverAuth';
import { getWorkerUrl, workerHeaders } from '@/lib/workerApi';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (isResponse(auth)) return auth;

  const target = `${getWorkerUrl()}/telegram/status`;

  try {
    const response = await fetch(target, { cache: 'no-store', headers: workerHeaders() });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch {
    return NextResponse.json(
      { status: 'error', lastError: 'worker_unreachable' },
      { status: 502 },
    );
  }
}
