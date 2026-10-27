import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isResponse, requireUser } from '@/lib/serverAuth';
import { workerHeaders } from '@/lib/workerApi';

const DEFAULT_WORKER_URL = 'http://localhost:4000/health';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (isResponse(auth)) return auth;

  const target = process.env.WORKER_HEALTH_URL ?? DEFAULT_WORKER_URL;

  try {
    const response = await fetch(target, { cache: 'no-store', headers: workerHeaders() });
    if (!response.ok) {
      return NextResponse.json(
        { status: 'error', code: response.status },
        { status: 502 },
      );
    }

    const data = await response.json();
    return NextResponse.json({ status: 'ok', data });
  } catch (error) {
    return NextResponse.json(
      { status: 'error', error: 'worker_unreachable' },
      { status: 502 },
    );
  }
}
