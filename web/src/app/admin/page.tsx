'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import DashboardShell from '@/components/DashboardShell';
import { useAuth } from '@/lib/useAuth';
import { doc, onSnapshot } from 'firebase/firestore';
import { firestoreDb } from '@/lib/firebaseClient';
import { apiIssues, authedFetch, errorMessage, type ApiIssue } from '@/lib/adminApi';
import { DEFAULT_SAFETY_LIMITS } from '@shared/executionProfile';

// Server routes are the real gate; these client checks only shape the UX.

type ModeOption = { value: 'disabled' | 'paper' | 'demo' | 'live'; label: string; description: string };

const MODE_OPTIONS: ModeOption[] = [
  { value: 'disabled', label: 'Disabled', description: 'No new entries. Open trades are still managed.' },
  { value: 'paper', label: 'Paper', description: 'Simulated broker. No orders reach MT5.' },
  { value: 'demo', label: 'Demo', description: 'MT5 demo account. Needs typed confirmation.' },
  { value: 'live', label: 'Live', description: 'Real money. Needs typed confirmation and BYTRADER_LIVE_TRADING=enabled on the worker.' },
];

const CONFIRM_PHRASES = {
  demo: 'ENABLE DEMO TRADING',
  live: 'ENABLE LIVE TRADING',
} as const;

const CLOSE_ALL_PHRASE = 'CLOSE ALL';
const CLOSE_TERMINAL = ['done', 'rejected', 'failed'];

type CloseCommand = {
  id: string;
  type: string | null;
  status: string | null;
  requested_at: string | null;
  requested_by_email: string | null;
  started_at: string | null;
  finished_at: string | null;
  result: unknown;
};

type SettingsSnapshot = {
  execution?: { mode?: string; active_profile_doc_id?: string | null };
  trading?: { kill_switch?: boolean };
  safety?: Record<string, unknown>;
};

function formatIssue(issue: ApiIssue): string {
  const parts = [issue.message];
  if (issue.value !== undefined) parts.push(`value ${JSON.stringify(issue.value)}`);
  if (issue.limit !== undefined) parts.push(`limit ${JSON.stringify(issue.limit)}`);
  return parts.join(' · ');
}

export default function AdminPage() {
  const { user, role, loading } = useAuth();

  const [mode, setMode] = useState<string>('disabled');
  const [killSwitch, setKillSwitch] = useState(false);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [storedSafety, setStoredSafety] = useState<Record<string, unknown> | null>(null);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [pendingMode, setPendingMode] = useState<'demo' | 'live' | null>(null);
  const [modeConfirmText, setModeConfirmText] = useState('');

  const [safetyText, setSafetyText] = useState('');
  const [safetyIssues, setSafetyIssues] = useState<ApiIssue[]>([]);

  const [closeConfirmText, setCloseConfirmText] = useState('');
  const [closeId, setCloseId] = useState<string | null>(null);
  const [closeCommand, setCloseCommand] = useState<CloseCommand | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);

  // Read-only live view of settings/default (reads stay client-side; writes go through the API).
  useEffect(() => {
    if (!firestoreDb) return;
    const unsubscribe = onSnapshot(
      doc(firestoreDb, 'settings', 'default'),
      (snap) => {
        const data = (snap.data() ?? {}) as SettingsSnapshot;
        setMode(typeof data.execution?.mode === 'string' ? data.execution.mode : 'disabled');
        setActiveProfileId(data.execution?.active_profile_doc_id ?? null);
        setKillSwitch(data.trading?.kill_switch === true);
        setStoredSafety(data.safety ?? null);
        setSnapshotLoaded(true);
        // Seed the editor once; afterwards the operator's text is never overwritten.
        setSafetyText((prev) =>
          prev === '' ? JSON.stringify(data.safety ?? DEFAULT_SAFETY_LIMITS, null, 2) : prev,
        );
      },
      (err) => setError(errorMessage(err, 'Failed to read settings.')),
    );
    return () => unsubscribe();
  }, []);

  // Poll the close-all command until it reaches a terminal status.
  useEffect(() => {
    if (!closeId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const command = await authedFetch<CloseCommand>(`/api/admin/close-all?id=${encodeURIComponent(closeId)}`);
        if (cancelled) return;
        setCloseCommand(command);
        if (command.status && CLOSE_TERMINAL.includes(command.status)) return;
      } catch (err) {
        if (cancelled) return;
        setCloseError(errorMessage(err, 'Failed to read close-all status.'));
      }
      if (!cancelled) timer = setTimeout(poll, 3000);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [closeId]);

  const applyMode = async (target: ModeOption['value'], confirm?: string) => {
    setBusy('mode');
    setError(null);
    setNotice(null);
    try {
      const result = await authedFetch<{ note?: string }>('/api/execution/mode', {
        method: 'POST',
        body: JSON.stringify({ mode: target, confirm }),
      });
      setNotice(result.note ? `Execution mode set to ${target}. ${result.note}` : `Execution mode set to ${target}.`);
      setPendingMode(null);
      setModeConfirmText('');
    } catch (err) {
      setError(errorMessage(err, 'Failed to change execution mode.'));
    } finally {
      setBusy(null);
    }
  };

  const chooseMode = (target: ModeOption['value']) => {
    if (target === 'demo' || target === 'live') {
      setPendingMode(target);
      setModeConfirmText('');
      setNotice(null);
      return;
    }
    void applyMode(target);
  };

  const setKillSwitchEngaged = async (engaged: boolean) => {
    if (!engaged && !window.confirm('Release the kill switch? New entries can resume if the mode and active profile allow them.')) {
      return;
    }
    setBusy('kill');
    setError(null);
    setNotice(null);
    try {
      await authedFetch('/api/execution/kill-switch', {
        method: 'POST',
        body: JSON.stringify({ engaged }),
      });
      setKillSwitch(engaged);
      setNotice(engaged ? 'Kill switch engaged. New entries are blocked.' : 'Kill switch released.');
    } catch (err) {
      setError(errorMessage(err, 'Failed to change the kill switch.'));
    } finally {
      setBusy(null);
    }
  };

  const saveSafety = async () => {
    setBusy('safety');
    setError(null);
    setNotice(null);
    setSafetyIssues([]);

    let payload: unknown;
    try {
      payload = JSON.parse(safetyText);
    } catch {
      setError('Safety limits are not valid JSON.');
      setBusy(null);
      return;
    }

    try {
      await authedFetch('/api/execution/safety', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setNotice('Safety limits saved.');
    } catch (err) {
      setError(errorMessage(err, 'Safety limits rejected.'));
      setSafetyIssues(apiIssues(err));
    } finally {
      setBusy(null);
    }
  };

  const resetSafetyEditor = () => {
    setSafetyText(JSON.stringify(storedSafety ?? DEFAULT_SAFETY_LIMITS, null, 2));
    setSafetyIssues([]);
  };

  const requestCloseAll = async () => {
    setBusy('close');
    setCloseError(null);
    setCloseCommand(null);
    try {
      const result = await authedFetch<{ id: string }>('/api/admin/close-all', {
        method: 'POST',
        body: JSON.stringify({ confirm: CLOSE_ALL_PHRASE }),
      });
      setCloseConfirmText('');
      setCloseId(result.id);
    } catch (err) {
      setCloseError(errorMessage(err, 'Failed to queue close-all.'));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <DashboardShell
        active="admin"
        title="Admin Actions"
        description="Run protected controls for the trading engine."
      >
        <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 text-sm text-marine-navy/70 shadow-sm">
          Checking permissions...
        </div>
      </DashboardShell>
    );
  }

  if (!user) {
    return (
      <DashboardShell
        active="admin"
        title="Admin Actions"
        description="Run protected controls for the trading engine."
      >
        <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 text-sm text-marine-navy/70 shadow-sm">
          You must sign in.
          <Link className="ml-2 text-marine-navy underline" href="/login">
            Go to login
          </Link>
        </div>
      </DashboardShell>
    );
  }

  if (role !== 'admin') {
    return (
      <DashboardShell
        active="admin"
        title="Admin Actions"
        description="Run protected controls for the trading engine."
      >
        <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 text-sm text-marine-navy/70 shadow-sm">
          Your account does not have admin permissions.
        </div>
      </DashboardShell>
    );
  }

  const confirmPhrase = pendingMode ? CONFIRM_PHRASES[pendingMode] : null;
  const closeTerminal = closeCommand?.status ? CLOSE_TERMINAL.includes(closeCommand.status) : false;

  return (
    <DashboardShell
      active="admin"
      title="Admin Actions"
      description="Run protected controls for the trading engine."
    >
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{notice}</p> : null}
      {error ? <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p> : null}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Execution mode */}
        <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-marine-navy">Execution mode</h2>
          <p className="mt-1 text-sm text-marine-navy/70">
            Current: <span className="font-mono font-semibold uppercase">{snapshotLoaded ? mode : '…'}</span>
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {MODE_OPTIONS.map((option) => {
              const active = mode === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => chooseMode(option.value)}
                  disabled={busy !== null}
                  className={`rounded-lg border px-3 py-2 text-left text-sm disabled:opacity-60 ${
                    active
                      ? 'border-marine-navy bg-marine-navy text-white'
                      : 'border-marine-navy/10 bg-marine-mist text-marine-navy hover:bg-marine-navy/5'
                  }`}
                  aria-pressed={active}
                >
                  <span className="block font-semibold">{option.label}</span>
                  <span className={`block text-xs ${active ? 'text-white/80' : 'text-marine-navy/60'}`}>
                    {option.description}
                  </span>
                </button>
              );
            })}
          </div>

          {pendingMode && confirmPhrase ? (
            <div className="mt-4 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
              <p className="text-amber-800">
                Type <span className="font-mono font-semibold">{confirmPhrase}</span> to switch to {pendingMode}.
                {pendingMode === 'live'
                  ? ' The worker also needs BYTRADER_LIVE_TRADING=enabled, or it will refuse new entries.'
                  : ''}
              </p>
              <input
                type="text"
                value={modeConfirmText}
                onChange={(event) => setModeConfirmText(event.target.value)}
                className="w-full rounded border border-amber-300 bg-white px-3 py-2 font-mono text-sm"
                aria-label="Typed confirmation"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="flex-1 rounded-lg border border-marine-navy/20 px-3 py-2 text-sm text-marine-navy"
                  onClick={() => {
                    setPendingMode(null);
                    setModeConfirmText('');
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="flex-1 rounded-lg bg-marine-navy px-3 py-2 text-sm text-white disabled:opacity-50"
                  disabled={modeConfirmText !== confirmPhrase || busy !== null}
                  onClick={() => void applyMode(pendingMode, modeConfirmText)}
                >
                  Switch to {pendingMode}
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Kill switch */}
        <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-marine-navy">Kill switch</h2>
          <p className="mt-1 text-sm text-marine-navy/70">
            State: <span className="font-semibold">{killSwitch ? 'ENGAGED' : 'released'}</span>
          </p>
          <p className="mt-3 text-sm text-marine-navy/70">
            Engaged, it blocks new entries and pending orders. Trades already open keep being protected and
            managed: partial take-profit closes, stop-loss moves, break-even and trailing continue. To flatten
            positions, use Close all below.
          </p>
          <button
            type="button"
            className={`mt-4 w-full rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-60 ${
              killSwitch
                ? 'border border-marine-navy/20 text-marine-navy hover:bg-marine-mist'
                : 'bg-red-600 text-white hover:bg-red-700'
            }`}
            onClick={() => void setKillSwitchEngaged(!killSwitch)}
            disabled={busy !== null || !snapshotLoaded}
          >
            {killSwitch ? 'Release kill switch' : 'Engage kill switch'}
          </button>
        </div>
      </div>

      {/* Safety limits */}
      <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-marine-navy">Safety limits</h2>
            <p className="mt-1 text-sm text-marine-navy/70">
              Operator ceilings applied to every profile. The server validates the JSON and rejects values above the
              hard ceilings.
              {storedSafety === null ? ' Nothing is stored yet, so the defaults shown are in effect.' : ''}
            </p>
          </div>
          <div className="text-xs text-marine-navy/60">
            Active profile: <span className="font-mono">{activeProfileId ?? 'none'}</span>
          </div>
        </div>
        <textarea
          value={safetyText}
          onChange={(event) => setSafetyText(event.target.value)}
          spellCheck={false}
          rows={18}
          className="mt-4 w-full rounded-lg border border-marine-navy/20 bg-marine-mist/40 p-3 font-mono text-xs text-marine-navy focus:border-marine-accent focus:outline-none"
          aria-label="Safety limits JSON"
        />
        {safetyIssues.length > 0 ? (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-sm font-medium text-red-700">The server rejected these values:</p>
            <ul className="mt-2 space-y-1 text-xs text-red-700">
              {safetyIssues.map((issue, index) => (
                <li key={`${issue.path}-${index}`}>
                  <span className="font-mono font-semibold">{issue.path || '(root)'}</span>: {formatIssue(issue)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-full bg-marine-navy px-4 py-2 text-sm text-white shadow disabled:opacity-60"
            onClick={() => void saveSafety()}
            disabled={busy !== null || !snapshotLoaded}
          >
            Save safety limits
          </button>
          <button
            type="button"
            className="rounded-full border border-marine-navy/20 px-4 py-2 text-sm text-marine-navy hover:bg-marine-mist disabled:opacity-60"
            onClick={resetSafetyEditor}
            disabled={busy !== null}
          >
            Reload stored values
          </button>
        </div>
      </div>

      {/* Close all */}
      <div className="rounded-2xl border border-red-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-red-700">Emergency close-all</h2>
        <p className="mt-2 text-sm text-marine-navy/70">
          Queues a command for the AutoTrader. It cancels pending orders and closes every position it owns on the
          configured broker. It does not touch positions opened outside ByTrader.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="text"
            value={closeConfirmText}
            onChange={(event) => setCloseConfirmText(event.target.value)}
            placeholder={CLOSE_ALL_PHRASE}
            className="flex-1 rounded border border-red-200 px-3 py-2 font-mono text-sm"
            aria-label="Type CLOSE ALL to confirm"
          />
          <button
            type="button"
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            disabled={closeConfirmText !== CLOSE_ALL_PHRASE || busy !== null}
            onClick={() => void requestCloseAll()}
          >
            Close all positions
          </button>
        </div>
        {closeError ? <p className="mt-3 text-sm text-red-600">{closeError}</p> : null}
        {closeCommand ? (
          <div className="mt-4 rounded-lg border border-marine-navy/10 bg-marine-mist/40 p-3 text-sm">
            <p>
              Command <span className="font-mono text-xs">{closeCommand.id}</span> ·{' '}
              <span className="font-semibold uppercase">{closeCommand.status ?? 'unknown'}</span>
              {closeTerminal ? '' : ' (waiting for the AutoTrader)'}
            </p>
            {closeCommand.finished_at ? (
              <p className="text-xs text-marine-navy/60">Finished {closeCommand.finished_at}</p>
            ) : null}
            {closeCommand.result ? (
              <pre className="mt-2 max-h-60 overflow-auto rounded bg-white p-2 text-xs">
                {JSON.stringify(closeCommand.result, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>
    </DashboardShell>
  );
}
