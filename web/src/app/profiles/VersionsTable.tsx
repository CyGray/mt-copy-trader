'use client';

import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatTimestamp } from '@/lib/format';
import { STATUS_TONE, type ProfileSummary } from './model';

interface VersionsTableProps {
  profiles: ProfileSummary[];
  activeDocId: string | null;
  selectedDocId: string | null;
  isAdmin: boolean;
  busy: boolean;
  onView: (docId: string) => void;
  onEdit: (docId: string) => void;
  onApprove: (docId: string) => void;
  onReject: (docId: string) => void;
  onActivate: (docId: string) => void;
}

export function VersionsTable({
  profiles,
  activeDocId,
  selectedDocId,
  isAdmin,
  busy,
  onView,
  onEdit,
  onApprove,
  onReject,
  onActivate,
}: VersionsTableProps) {
  return (
    <section className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-marine-navy">Versions</h2>
      <p className="mt-1 text-sm text-marine-navy/70">
        Approved content is locked. Change a profile by saving a new draft version.
      </p>

      {profiles.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-marine-navy/20 p-6 text-center text-sm text-marine-navy/60">
          No profile versions yet. Paste an Optimal Report profile into the editor and save it as a draft.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-marine-navy/10">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-marine-mist/60 text-xs uppercase tracking-wider text-marine-navy/60">
              <tr>
                <th className="px-3 py-2 font-medium">Profile</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Validation</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Approved</th>
                <th className="px-3 py-2 font-medium">Activated</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((profile) => {
                const status = profile.status ?? 'unknown';
                const isSelected = profile.doc_id === selectedDocId;
                const isActive = profile.doc_id === activeDocId;
                return (
                  <tr
                    key={profile.doc_id}
                    className={`border-t border-marine-navy/10 align-top ${isSelected ? 'bg-marine-accent/5' : ''}`}
                  >
                    <td className="px-3 py-2">
                      <p className="font-medium text-marine-navy">{profile.name ?? profile.profile_id}</p>
                      <p className="font-mono text-xs text-marine-navy/60">
                        {profile.doc_id} · v{profile.version ?? '?'}
                      </p>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge
                        status={STATUS_TONE[status] ?? 'neutral'}
                        label={isActive ? 'active' : status}
                        size="sm"
                      />
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {profile.validation.ok ? (
                        <span className="text-trade-up">ok</span>
                      ) : (
                        <span className="text-trade-down">{profile.validation.error_count} error(s)</span>
                      )}
                      {profile.validation.warning_count > 0 ? (
                        <span className="ml-2 text-amber-600">{profile.validation.warning_count} warning(s)</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-marine-navy/70">{formatTimestamp(profile.created_at)}</td>
                    <td className="px-3 py-2 text-xs text-marine-navy/70">{formatTimestamp(profile.approved_at)}</td>
                    <td className="px-3 py-2 text-xs text-marine-navy/70">{formatTimestamp(profile.activated_at)}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1.5">
                        <Button variant="ghost" size="sm" onClick={() => onView(profile.doc_id)} disabled={busy}>
                          View
                        </Button>
                        {isAdmin && status === 'draft' ? (
                          <>
                            <Button variant="secondary" size="sm" onClick={() => onEdit(profile.doc_id)} disabled={busy}>
                              Edit
                            </Button>
                            <Button variant="secondary" size="sm" onClick={() => onApprove(profile.doc_id)} disabled={busy}>
                              Approve
                            </Button>
                          </>
                        ) : null}
                        {isAdmin && (status === 'approved' || status === 'superseded') ? (
                          <Button variant="secondary" size="sm" onClick={() => onActivate(profile.doc_id)} disabled={busy}>
                            {status === 'superseded' ? 'Re-activate' : 'Activate'}
                          </Button>
                        ) : null}
                        {isAdmin && (status === 'draft' || status === 'approved') ? (
                          <Button variant="ghost" size="sm" onClick={() => onReject(profile.doc_id)} disabled={busy}>
                            Reject
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
