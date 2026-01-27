import { NextResponse } from 'next/server';

const DEFAULT_WORKER_URL = 'http://localhost:4000/health';

export async function GET() {
  const target = process.env.WORKER_HEALTH_URL ?? DEFAULT_WORKER_URL;

  try {
    const response = await fetch(target, { cache: 'no-store' });
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
