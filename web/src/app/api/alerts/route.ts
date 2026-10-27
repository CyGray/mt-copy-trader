import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { severityRank, type AlertSeverity } from '@shared/alertTypes';
import { getAdminDb, jsonError } from '@/lib/adminControl';
import { isResponse, requireUser } from '@/lib/serverAuth';

export const dynamic = 'force-dynamic';

const VIEWS: Record<string, string[]> = {
  active: ['open', 'acknowledged'],
  open: ['open'],
  acknowledged: ['acknowledged'],
  resolved: ['resolved'],
};
const MAX = 200;

/**
 * GET /api/alerts?view=active|open|acknowledged|resolved: operator alerts written
 * by the worker services, most severe first, then most recent.
 */
export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (isResponse(auth)) return auth;

  const view = request.nextUrl.searchParams.get('view') ?? 'active';
  const statuses = VIEWS[view];
  if (!statuses) return jsonError('view must be one of active, open, acknowledged, resolved', 400);

  const db = getAdminDb();
  if (!db) return jsonError('Admin not configured', 503);

  try {
    const snap = await db.collection('alerts').where('status', 'in', statuses).limit(MAX).get();
    const alerts = snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }) as Record<string, unknown> & { id: string })
      .sort((a, b) => {
        const bySeverity = severityRank(b.severity as AlertSeverity) - severityRank(a.severity as AlertSeverity);
        if (bySeverity !== 0) return bySeverity;
        return String(b.last_seen_at ?? '').localeCompare(String(a.last_seen_at ?? ''));
      });
    return NextResponse.json({ view, alerts, truncated: snap.size >= MAX });
  } catch {
    return jsonError('Read failed', 503);
  }
}
