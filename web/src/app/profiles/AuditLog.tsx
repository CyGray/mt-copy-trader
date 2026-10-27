'use client';

import { formatTimestamp } from '@/lib/format';
import type { AuditEntry } from './model';

interface AuditLogProps {
  entries: AuditEntry[];
  loaded: boolean;
}

function summarize(entry: AuditEntry): string {
  const details = entry.details ?? {};
  const parts: string[] = [];
  if (typeof details.version === 'number') parts.push(`v${details.version}`);
  if (entry.previous_active_doc_id) parts.push(`previous ${entry.previous_active_doc_id}`);
  if (Array.isArray(details.changed_keys) && details.changed_keys.length > 0) {
    parts.push(`changed ${details.changed_keys.join(', ')}`);
  }
  if (typeof details.error_count === 'number' && details.error_count > 0) parts.push(`${details.error_count} error(s)`);
  if (typeof details.reason === 'string' && details.reason) parts.push(`reason: ${details.reason}`);
  return parts.join(' · ');
}

/** Recent execution_profile_audit entries, newest first. */
export function AuditLog({ entries, loaded }: AuditLogProps) {
  return (
    <section className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-marine-navy">Audit log</h2>
      <p className="mt-1 text-sm text-marine-navy/70">Most recent profile changes. Every change is recorded here and in admin_audit.</p>

      {!loaded ? (
        <p className="mt-4 text-sm text-marine-navy/60">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="mt-4 text-sm text-marine-navy/60">No profile changes recorded yet.</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-marine-navy/10">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-marine-mist/60 uppercase tracking-wider text-marine-navy/60">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Profile version</th>
                <th className="px-3 py-2 font-medium">Actor</th>
                <th className="px-3 py-2 font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-t border-marine-navy/10 align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-marine-navy/70">{formatTimestamp(entry.at)}</td>
                  <td className="px-3 py-2 font-mono text-marine-navy">{entry.action ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-marine-navy/80">{entry.profile_doc_id ?? '—'}</td>
                  <td className="px-3 py-2 text-marine-navy/70">{entry.actor_email ?? '—'}</td>
                  <td className="px-3 py-2 text-marine-navy/70">{summarize(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
