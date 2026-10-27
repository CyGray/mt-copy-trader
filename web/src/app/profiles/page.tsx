'use client';

import { useCallback, useEffect, useState } from 'react';
import { DashboardLayout } from '@/components/layouts/DashboardLayout';
import { apiIssues, authedFetch, errorMessage } from '@/lib/adminApi';
import { useAuth } from '@/lib/useAuth';
import exampleProfile from '../../../../docs/project_memory/examples/optimal_report_profile.example.json';
import { ActiveProfileCard } from './ActiveProfileCard';
import { AuditLog } from './AuditLog';
import { DraftEditor, type EditorMode } from './DraftEditor';
import { PreviewPanel } from './PreviewPanel';
import { SelectedVersionPanel } from './SelectedVersionPanel';
import { VersionsTable } from './VersionsTable';
import {
  DEFAULT_PREVIEW_FORM,
  parseProfileText,
  toPreviewPayload,
  type AuditEntry,
  type PreviewForm,
  type ProfileDetail,
  type ProfileListResponse,
  type ValidateResponse,
  type ValidationIssue,
} from './model';

// The example ships with a version; the server assigns it, so the new-draft text omits it.
const EXAMPLE_TEXT = (() => {
  const draft: Record<string, unknown> = { ...exampleProfile };
  delete draft.version;
  return JSON.stringify(draft, null, 2);
})();

interface CreateResponse {
  doc_id: string;
  version: number;
  notes: string[];
}

interface UpdateResponse {
  doc_id: string;
  notes: string[];
}

interface ActionResponse {
  doc_id: string;
  status: string;
  previous_active_doc_id?: string | null;
  notes?: string[];
}

function withNotes(message: string, notes: string[] | undefined): string {
  return notes && notes.length > 0 ? `${message} ${notes.join(' ')}` : message;
}

/**
 * Execution profiles: the active version, all versions with their lifecycle
 * actions, a JSON draft editor with validation, a sample-signal preview, and the
 * audit log. Every mutation goes through an admin API route; the role check here
 * only shapes the UI.
 */
export default function ProfilesPage() {
  const { user, role } = useAuth();
  const isAdmin = role === 'admin';

  const [list, setList] = useState<ProfileListResponse | null>(null);
  const [activeDetail, setActiveDetail] = useState<ProfileDetail | null>(null);
  const [selected, setSelected] = useState<ProfileDetail | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditLoaded, setAuditLoaded] = useState(false);

  const [editorText, setEditorText] = useState(EXAMPLE_TEXT);
  const [parseError, setParseError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidateResponse | null>(null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);

  const [previewForm, setPreviewForm] = useState<PreviewForm>(DEFAULT_PREVIEW_FORM);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);

  const loadDetail = useCallback(
    (docId: string) => authedFetch<ProfileDetail>(`/api/profiles/${encodeURIComponent(docId)}`),
    [],
  );

  const refreshList = useCallback(async (): Promise<ProfileListResponse> => {
    const data = await authedFetch<ProfileListResponse>('/api/profiles');
    setList(data);
    if (data.active_profile_doc_id) {
      try {
        setActiveDetail(await loadDetail(data.active_profile_doc_id));
      } catch {
        setActiveDetail(null);
      }
    } else {
      setActiveDetail(null);
    }
    return data;
  }, [loadDetail]);

  const refreshAudit = useCallback(async () => {
    const data = await authedFetch<{ entries: AuditEntry[] }>('/api/profiles/audit?limit=50');
    setAudit(data.entries);
    setAuditLoaded(true);
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      try {
        await refreshList();
        await refreshAudit();
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, 'Failed to load execution profiles.'));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [user, refreshList, refreshAudit]);

  /** Runs one mutation with shared busy and error handling. */
  const runAction = async (task: () => Promise<void>, failure: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setServerIssues([]);
    try {
      await task();
    } catch (err) {
      setError(errorMessage(err, failure));
      setServerIssues(apiIssues(err));
    } finally {
      setBusy(false);
    }
  };

  const openVersion = async (docId: string) => {
    setError(null);
    setNotice(null);
    setServerIssues([]);
    setParseError(null);
    setValidation(null);
    setConfirmRollback(false);
    try {
      const detail = await loadDetail(docId);
      setSelected(detail);
      setEditorText(JSON.stringify(detail.profile, null, 2));
    } catch (err) {
      setError(errorMessage(err, 'Failed to load the version.'));
    }
  };

  const newDraft = () => {
    setError(null);
    setNotice(null);
    setServerIssues([]);
    setParseError(null);
    setValidation(null);
    setConfirmRollback(false);
    setSelected(null);
    setEditorText(EXAMPLE_TEXT);
  };

  const changePreview = (field: keyof PreviewForm, value: string) => {
    setPreviewForm((prev) => ({ ...prev, [field]: value }) as PreviewForm);
  };

  /** Validates the editor text, plus the preview when its inputs are complete. */
  const validateText = async (): Promise<ValidateResponse | null> => {
    const parsed = parseProfileText(editorText);
    if (!parsed.ok) {
      setParseError(parsed.error);
      setValidation(null);
      return null;
    }
    setParseError(null);
    const payload = toPreviewPayload(previewForm);
    setPreviewError(payload.ok ? null : payload.error);
    return authedFetch<ValidateResponse>('/api/profiles/validate', {
      method: 'POST',
      body: JSON.stringify({ profile: parsed.value, ...(payload.ok ? { preview: payload.value } : {}) }),
    });
  };

  const runValidation = () =>
    runAction(async () => {
      const result = await validateText();
      if (result) {
        setValidation(result);
        setNotice(result.validation.ok ? 'The profile validates.' : null);
      }
    }, 'Validation failed.');

  const saveDraft = () =>
    runAction(async () => {
      const parsed = parseProfileText(editorText);
      if (!parsed.ok) {
        setParseError(parsed.error);
        return;
      }
      setParseError(null);

      let docId: string;
      if (selected) {
        const result = await authedFetch<UpdateResponse>(`/api/profiles/${encodeURIComponent(selected.doc_id)}`, {
          method: 'PUT',
          body: JSON.stringify(parsed.value),
        });
        docId = result.doc_id;
        setNotice(withNotes('Draft saved.', result.notes));
      } else {
        const result = await authedFetch<CreateResponse>('/api/profiles', {
          method: 'POST',
          body: JSON.stringify(parsed.value),
        });
        docId = result.doc_id;
        setNotice(withNotes(`Draft ${result.doc_id} created.`, result.notes));
      }

      await refreshList();
      await refreshAudit();
      const detail = await loadDetail(docId);
      setSelected(detail);
      setEditorText(JSON.stringify(detail.profile, null, 2));
      const checked = await validateText();
      if (checked) setValidation(checked);
    }, 'Save failed.');

  const finishAction = async (docId: string | null) => {
    await refreshList();
    await refreshAudit();
    if (docId) setSelected(await loadDetail(docId));
  };

  const approve = (docId: string) =>
    runAction(async () => {
      await authedFetch<ActionResponse>(`/api/profiles/${encodeURIComponent(docId)}/approve`, { method: 'POST' });
      setNotice(`Approved ${docId}. Its content is now locked; change it by saving a new draft version.`);
      await finishAction(docId);
    }, 'Approve failed.');

  const reject = (docId: string, reason: string) =>
    runAction(async () => {
      const trimmed = reason.trim();
      await authedFetch<ActionResponse>(`/api/profiles/${encodeURIComponent(docId)}/reject`, {
        method: 'POST',
        body: JSON.stringify(trimmed ? { reason: trimmed } : {}),
      });
      setNotice(`Rejected ${docId}. A rejected version cannot be activated.`);
      await finishAction(docId);
    }, 'Reject failed.');

  const activate = (docId: string, confirm: string) =>
    runAction(async () => {
      const result = await authedFetch<ActionResponse>(`/api/profiles/${encodeURIComponent(docId)}/activate`, {
        method: 'POST',
        body: JSON.stringify({ confirm }),
      });
      const previous = result.previous_active_doc_id ? ` Previous active: ${result.previous_active_doc_id}.` : '';
      setNotice(withNotes(`Activated ${docId}.${previous}`, result.notes));
      await finishAction(docId);
    }, 'Activation failed.');

  const rollback = () =>
    runAction(async () => {
      const result = await authedFetch<ActionResponse>('/api/profiles/rollback', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setConfirmRollback(false);
      setNotice(withNotes(`Rolled back to ${result.doc_id}. Previous active: ${result.previous_active_doc_id ?? 'none'}.`, result.notes));
      await finishAction(result.doc_id);
    }, 'Rollback failed.');

  const canRollback = (list?.profiles ?? []).some((profile) => profile.status === 'superseded');
  const editorMode: EditorMode = !selected ? 'new' : selected.status === 'draft' ? 'draft' : 'locked';
  const readOnly = editorMode === 'locked' || !isAdmin;
  const isActiveSelected = selected !== null && selected.doc_id === list?.active_profile_doc_id;

  return (
    <DashboardLayout
      title="Execution profiles"
      subtitle="Optimal Report profiles: draft, validate, approve and activate"
      breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Execution profiles' }]}
    >
      <div className="space-y-6">
        {role === 'viewer' ? (
          <p className="rounded-lg border border-marine-navy/10 bg-white px-4 py-2 text-sm text-marine-navy/70">
            Read-only view. An admin role is required to change profiles.
          </p>
        ) : null}
        {notice ? (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{notice}</p>
        ) : null}
        {error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
        ) : null}

        <ActiveProfileCard
          activeDocId={list?.active_profile_doc_id ?? null}
          detail={activeDetail}
          canRollback={canRollback}
          isAdmin={isAdmin}
          busy={busy}
          confirmingRollback={confirmRollback}
          onRequestRollback={() => setConfirmRollback(true)}
          onCancelRollback={() => setConfirmRollback(false)}
          onConfirmRollback={() => void rollback()}
        />

        <VersionsTable
          profiles={list?.profiles ?? []}
          activeDocId={list?.active_profile_doc_id ?? null}
          selectedDocId={selected?.doc_id ?? null}
          isAdmin={isAdmin}
          busy={busy}
          onView={(docId) => void openVersion(docId)}
          onEdit={(docId) => void openVersion(docId)}
          onApprove={(docId) => void approve(docId)}
          onReject={(docId) => void reject(docId, '')}
          onActivate={(docId) => void openVersion(docId)}
        />

        <div className="grid gap-6 xl:grid-cols-2">
          <div className="space-y-6">
            {selected ? (
              <SelectedVersionPanel
                key={selected.doc_id}
                detail={selected}
                isActive={isActiveSelected}
                isAdmin={isAdmin}
                busy={busy}
                onApprove={() => void approve(selected.doc_id)}
                onReject={(reason) => void reject(selected.doc_id, reason)}
                onActivate={(confirm) => void activate(selected.doc_id, confirm)}
              />
            ) : null}
            <DraftEditor
              mode={editorMode}
              docId={selected?.doc_id ?? null}
              text={editorText}
              readOnly={readOnly}
              busy={busy}
              validation={validation}
              parseError={parseError}
              serverIssues={serverIssues}
              onTextChange={setEditorText}
              onValidate={() => void runValidation()}
              onSave={() => void saveDraft()}
              onNewDraft={newDraft}
            />
          </div>

          <PreviewPanel
            form={previewForm}
            busy={busy}
            preview={validation?.preview ?? null}
            previewRan={validation !== null}
            previewError={previewError}
            onChange={changePreview}
            onRun={() => void runValidation()}
          />
        </div>

        <AuditLog entries={audit} loaded={auditLoaded} />
      </div>
    </DashboardLayout>
  );
}
