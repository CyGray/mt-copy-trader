import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ACTIVE_QUEUE_STATUSES, compareQueueDocs, readQueueState } from '@shared/signalQueue';
import { getAdminDb, jsonError } from '@/lib/adminControl';
import { isResponse, requireUser } from '@/lib/serverAuth';

export const dynamic = 'force-dynamic';

const MAX = 200;

/** Fields shown on the Signals page. The parsed signal is included; raw message text is not. */
function summary(id: string, data: Record<string, unknown>) {
  return {
    id,
    chat_id: data.chat_id ?? null,
    message_id: data.message_id ?? null,
    kind: data.kind ?? null,
    message_type: data.message_type ?? null,
    cancel_reason: data.cancel_reason ?? null,
    signal: data.signal ?? null,
    created_at: data.created_at ?? null,
    spooled_at: data.spooled_at ?? null,
    queue: readQueueState(data.autotrader),
  };
}

/**
 * GET /api/signal-events?view=dead_letter|active|discarded: the AutoTrader's
 * durable signal queue, oldest first.
 */
export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (isResponse(auth)) return auth;

  const view = request.nextUrl.searchParams.get('view') ?? 'dead_letter';
  const statuses =
    view === 'dead_letter' ? ['dead_letter'] : view === 'active' ? [...ACTIVE_QUEUE_STATUSES] : view === 'discarded' ? ['discarded'] : null;
  if (!statuses) return jsonError('view must be one of dead_letter, active, discarded', 400);

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  try {
    const snap = await db.collection('signal_events').where('autotrader.status', 'in', statuses).limit(MAX).get();
    const events = snap.docs
      .map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) }))
      .sort(compareQueueDocs)
      .map((doc) => summary(doc.id, doc));
    return NextResponse.json({ view, events, truncated: snap.size >= MAX });
  } catch {
    return jsonError('Read failed', 503);
  }
}
