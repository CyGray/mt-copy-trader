'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatTimestamp } from '@/lib/format';
import { STATUS_TONE, type ProfileDetail } from './model';

interface SelectedVersionPanelProps {
  detail: ProfileDetail;
  isActive: boolean;
  isAdmin: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: (reason: string) => void;
  onActivate: (confirm: string) => void;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-marine-navy/5 py-1.5 text-sm last:border-b-0">
      <span className="text-marine-navy/60">{label}</span>
      <span className="text-right text-marine-navy">{value}</span>
    </div>
  );
}

/**
 * Lifecycle panel for the selected version. Key={doc_id} in the parent resets the
 * typed confirmation and reject reason when another version is selected.
 */
export function SelectedVersionPanel({
  detail,
  isActive,
  isAdmin,
  busy,
  onApprove,
  onReject,
  onActivate,
}: SelectedVersionPanelProps) {
  const [confirmText, setConfirmText] = useState('');
  const [reason, setReason] = useState('');

  const status = detail.status ?? 'unknown';
  const activatePhrase = `ACTIVATE ${detail.doc_id}`;
  const canActivate = isAdmin && !isActive && (status === 'approved' || status === 'superseded');
  const canApprove = isAdmin && status === 'draft';
  const canReject = isAdmin && (status === 'draft' || status === 'approved');
  const meta = detail.meta;

  return (
    <section className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">Selected version</p>
          <p className="mt-1 font-mono text-sm text-marine-navy">{detail.doc_id}</p>
        </div>
        <StatusBadge
          status={isActive ? 'success' : (STATUS_TONE[status] ?? 'neutral')}
          label={isActive ? 'active' : status}
          size="md"
        />
      </div>

      <div className="mt-4 grid gap-x-6 md:grid-cols-2">
        <div>
          <Row label="Created" value={`${meta.created_by ?? '—'} · ${formatTimestamp(meta.created_at)}`} />
          <Row label="Last updated" value={`${meta.updated_by ?? '—'} · ${formatTimestamp(meta.updated_at)}`} />
        </div>
        <div>
          <Row label="Approved" value={meta.approved_at ? `${meta.approved_by ?? '—'} · ${formatTimestamp(meta.approved_at)}` : '—'} />
          <Row label="Activated" value={meta.activated_at ? `${meta.activated_by ?? '—'} · ${formatTimestamp(meta.activated_at)}` : '—'} />
          {meta.superseded_at ? <Row label="Superseded" value={formatTimestamp(meta.superseded_at)} /> : null}
          {meta.rejected_at ? (
            <Row
              label="Rejected"
              value={`${meta.rejected_by ?? '—'} · ${formatTimestamp(meta.rejected_at)}${meta.rejected_reason ? ` · ${meta.rejected_reason}` : ''}`}
            />
          ) : null}
        </div>
      </div>

      {status !== 'draft' ? (
        <p className="mt-4 text-xs text-marine-navy/60">
          This version is read-only. Its content is locked once it is approved.
        </p>
      ) : null}

      {canApprove || canReject ? (
        <div className="mt-5 space-y-3 border-t border-marine-navy/10 pt-4">
          {canApprove ? (
            <p className="text-sm text-marine-navy/70">
              Approve runs the same checks as activation: the profile must validate and fit the current safety limits.
            </p>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            {canApprove ? (
              <Button variant="primary" size="sm" onClick={onApprove} loading={busy} disabled={busy}>
                Approve draft
              </Button>
            ) : null}
            {canReject ? (
              <>
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Reason (optional)"
                  maxLength={500}
                  className="h-8 min-w-[12rem] flex-1 rounded-lg border border-marine-navy/20 px-3 text-xs text-marine-navy focus:border-marine-accent focus:outline-none"
                />
                <Button variant="danger" size="sm" onClick={() => onReject(reason)} disabled={busy}>
                  Reject
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {canActivate ? (
        <div className="mt-5 space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-900">
            Activation makes this version the one used for new entries and supersedes the current active version.
            Trades already open keep their frozen profile snapshot.
          </p>
          <label className="block text-xs font-medium text-amber-900" htmlFor="activate-confirm">
            Type <span className="font-mono">{activatePhrase}</span> to confirm
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="activate-confirm"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              autoComplete="off"
              className="h-9 flex-1 rounded border border-amber-300 bg-white px-3 font-mono text-sm"
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => onActivate(confirmText)}
              disabled={busy || confirmText !== activatePhrase}
              loading={busy}
            >
              Activate
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
