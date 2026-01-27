'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import DashboardShell from '@/components/DashboardShell';
import { useAuth } from '@/lib/useAuth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { firestoreDb } from '@/lib/firebaseClient';

const SETTINGS_DOC = 'settings/default';

type SettingsDoc = {
  trading?: {
    paper_mode?: boolean;
    kill_switch?: boolean;
  };
  worker?: {
    enabled?: boolean;
  };
};

export default function AdminPage() {
  const { user, role, loading } = useAuth();
  const [paperMode, setPaperMode] = useState(false);
  const [killSwitch, setKillSwitch] = useState(false);
  const [workerEnabled, setWorkerEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const loadAdminSettings = async () => {
    if (!firestoreDb) return;
    try {
      const snap = await getDoc(doc(firestoreDb, SETTINGS_DOC));
      const data = snap.data() as SettingsDoc | undefined;
      setPaperMode(Boolean(data?.trading?.paper_mode));
      setKillSwitch(Boolean(data?.trading?.kill_switch));
      setWorkerEnabled(data?.worker?.enabled ?? true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load admin settings.');
    }
  };

  const saveAdminSettings = async () => {
    if (!firestoreDb || !user) return;
    setSaving(true);
    setSaved(false);
    setError(null);

    try {
      await setDoc(
        doc(firestoreDb, SETTINGS_DOC),
        {
          trading: { paper_mode: paperMode, kill_switch: killSwitch },
          worker: { enabled: workerEnabled },
        },
        { merge: true },
      );
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save admin settings.');
    } finally {
      setSaving(false);
    }
  };

  const requestCloseAll = async () => {
    if (!firestoreDb || !user) return;
    setSaving(true);
    setSaved(false);
    setError(null);

    try {
      await setDoc(
        doc(firestoreDb, SETTINGS_DOC),
        {
          admin_actions: {
            close_all_requested_at: new Date().toISOString(),
            requested_by: user.uid,
          },
        },
        { merge: true },
      );
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request close-all.');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    void loadAdminSettings();
  }, []);

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

  return (
    <DashboardShell
      active="admin"
      title="Admin Actions"
      description="Run protected controls for the trading engine."
    >
      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-marine-navy">Live controls</h2>
          <div className="mt-4 space-y-3 text-sm">
            <label className="flex items-center justify-between rounded-lg border border-marine-navy/10 bg-marine-mist px-3 py-2">
              <span>Paper mode</span>
              <input
                type="checkbox"
                checked={paperMode}
                onChange={(event) => setPaperMode(event.target.checked)}
              />
            </label>
            <label className="flex items-center justify-between rounded-lg border border-marine-navy/10 bg-marine-mist px-3 py-2">
              <span>Kill switch</span>
              <input
                type="checkbox"
                checked={killSwitch}
                onChange={(event) => setKillSwitch(event.target.checked)}
              />
            </label>
            <label className="flex items-center justify-between rounded-lg border border-marine-navy/10 bg-marine-mist px-3 py-2">
              <span>Worker enabled</span>
              <input
                type="checkbox"
                checked={workerEnabled}
                onChange={(event) => setWorkerEnabled(event.target.checked)}
              />
            </label>
          </div>
        </div>

        <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-marine-navy">Emergency actions</h2>
          <p className="mt-2 text-sm text-marine-navy/70">
            Emergency close-all requests are recorded in Firestore and picked up by the worker.
          </p>
          <button
            className="mt-4 w-full rounded-lg border border-marine-navy/20 px-4 py-2 text-sm text-marine-navy hover:bg-marine-mist"
            onClick={requestCloseAll}
            disabled={saving}
          >
            Request close-all
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          className="rounded-full bg-marine-navy px-4 py-2 text-sm text-white shadow disabled:opacity-60"
          onClick={saveAdminSettings}
          disabled={saving}
        >
          Save changes
        </button>
        {saved ? <span className="text-sm text-emerald-600">Saved</span> : null}
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </DashboardShell>
  );
}
