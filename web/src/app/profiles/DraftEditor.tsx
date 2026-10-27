'use client';

import { Button } from '@/components/ui/Button';
import { formatIssue, type ValidateResponse, type ValidationIssue } from './model';

export type EditorMode = 'new' | 'draft' | 'locked';

interface DraftEditorProps {
  mode: EditorMode;
  docId: string | null;
  text: string;
  readOnly: boolean;
  busy: boolean;
  validation: ValidateResponse | null;
  parseError: string | null;
  serverIssues: ValidationIssue[];
  onTextChange: (text: string) => void;
  onValidate: () => void;
  onSave: () => void;
  onNewDraft: () => void;
}

function IssueList({ title, issues, tone }: { title: string; issues: ValidationIssue[]; tone: 'error' | 'warning' }) {
  if (issues.length === 0) return null;
  const classes = tone === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-900';
  return (
    <div className={`rounded-lg border p-3 text-sm ${classes}`}>
      <p className="text-xs font-semibold uppercase tracking-wider">
        {title} ({issues.length})
      </p>
      <ul className="mt-2 space-y-1.5">
        {issues.map((issue, index) => (
          <li key={`${issue.path}-${index}`}>
            <span className="font-mono text-xs">{issue.path || '(root)'}</span>
            <span className="ml-2">{formatIssue(issue)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const MODE_LABEL: Record<EditorMode, string> = {
  new: 'New draft',
  draft: 'Draft',
  locked: 'Read-only',
};

/** JSON editor for the profile, with validation results below it. Server routes re-check everything. */
export function DraftEditor({
  mode,
  docId,
  text,
  readOnly,
  busy,
  validation,
  parseError,
  serverIssues,
  onTextChange,
  onValidate,
  onSave,
  onNewDraft,
}: DraftEditorProps) {
  return (
    <section className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-marine-navy">{mode === 'new' ? 'Draft editor' : 'Profile JSON'}</h2>
          <p className="mt-1 text-xs text-marine-navy/60">
            {MODE_LABEL[mode]}
            {docId ? <span className="ml-2 font-mono">{docId}</span> : null}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onNewDraft} disabled={busy}>
          New draft from example
        </Button>
      </div>

      <p className="mt-2 text-xs text-marine-navy/60">
        Paste the JSON produced from the Optimal Report review. Omit <span className="font-mono">version</span>, the
        server assigns it. Drafts can be saved invalid; approval and activation require a valid profile.
      </p>

      <textarea
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        readOnly={readOnly}
        spellCheck={false}
        aria-label="Execution profile JSON"
        className="mt-3 h-[28rem] w-full resize-y rounded-lg border border-marine-navy/20 bg-marine-mist/40 p-3 font-mono text-xs leading-relaxed text-marine-navy focus:border-marine-accent focus:outline-none read-only:bg-marine-mist/70"
      />

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={onValidate} disabled={busy} loading={busy}>
          Validate
        </Button>
        {!readOnly ? (
          <Button variant="primary" size="sm" onClick={onSave} disabled={busy}>
            {mode === 'new' ? 'Create draft' : 'Save draft'}
          </Button>
        ) : null}
      </div>

      <div className="mt-4 space-y-3">
        {parseError ? (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{parseError}</p>
        ) : null}
        {serverIssues.length > 0 ? (
          <IssueList title="Refused by the server" issues={serverIssues} tone="error" />
        ) : null}

        {validation ? (
          <>
            <p
              className={`rounded-lg border px-3 py-2 text-sm ${
                validation.validation.ok
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-red-200 bg-red-50 text-red-700'
              }`}
            >
              {validation.validation.ok
                ? 'The profile validates.'
                : `The profile does not validate: ${validation.validation.errors.length} error(s).`}
              {validation.safety.valid ? null : ' Stored safety limits are invalid.'}
            </p>
            <IssueList title="Errors" issues={validation.validation.errors} tone="error" />
            <IssueList title="Warnings" issues={validation.validation.warnings} tone="warning" />
            <IssueList title="Safety limits" issues={validation.safetyIssues} tone="error" />
            {validation.notes.length > 0 ? (
              <ul className="space-y-1 text-xs text-marine-navy/60">
                {validation.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
