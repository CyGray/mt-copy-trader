'use client';

import { useEffect, useState } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { firestoreDb } from '@/lib/firebaseClient';
import DashboardShell from '@/components/DashboardShell';
import { useAuth } from '@/lib/useAuth';

const SETTINGS_DOC = 'settings/default';

type TelegramSettings = {
  allowed_chat_ids?: string[];
};

type TradingSettings = {
  risk_mode?: 'PERCENT_AVAILABLE_MARGIN' | 'FIXED_USDT';
  risk_value?: number;
  max_signal_delay_sec?: number;
  slippage_tol?: number;
  tp1_skip_buffer?: number;
  max_open_positions?: number;
  max_positions_per_symbol?: number;
  paper_mode?: boolean;
  kill_switch?: boolean;
  bybit_optional?: boolean;
};

type SettingsDoc = {
  telegram?: TelegramSettings;
  trading?: TradingSettings;
};

export default function SettingsPage() {
  const { role, loading: authLoading } = useAuth();
  const [chatIds, setChatIds] = useState<string[]>([]);
  const [newChatId, setNewChatId] = useState('');
  const [riskMode, setRiskMode] = useState<'PERCENT_AVAILABLE_MARGIN' | 'FIXED_USDT'>(
    'FIXED_USDT',
  );
  const [riskValue, setRiskValue] = useState<string>('20');
  const [maxSignalDelay, setMaxSignalDelay] = useState<string>('120');
  const [slippageTol, setSlippageTol] = useState<string>('0.001');
  const [tp1Buffer, setTp1Buffer] = useState<string>('0.0015');
  const [maxOpenPositions, setMaxOpenPositions] = useState<string>('3');
  const [maxPositionsPerSymbol, setMaxPositionsPerSymbol] = useState<string>('1');
  const [paperMode, setPaperMode] = useState(false);
  const [killSwitch, setKillSwitch] = useState(false);
  const [bybitOptional, setBybitOptional] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isAdmin = role === 'admin';

  const loadSettings = async () => {
    if (!firestoreDb) {
      setError('Firestore not initialized.');
      return;
    }
    setLoading(true);
    setError(null);
    setSaved(false);

    try {
      const ref = doc(firestoreDb, SETTINGS_DOC);
      const snap = await getDoc(ref);
      const data = snap.data() as SettingsDoc | undefined;
      const ids = data?.telegram?.allowed_chat_ids ?? [];
      const trading = data?.trading ?? {};

      setChatIds(ids);
      setRiskMode(trading.risk_mode ?? 'FIXED_USDT');
      setRiskValue(String(trading.risk_value ?? 20));
      setMaxSignalDelay(String(trading.max_signal_delay_sec ?? 120));
      setSlippageTol(String(trading.slippage_tol ?? 0.001));
      setTp1Buffer(String(trading.tp1_skip_buffer ?? 0.0015));
      setMaxOpenPositions(String(trading.max_open_positions ?? 3));
      setMaxPositionsPerSymbol(String(trading.max_positions_per_symbol ?? 1));
      setPaperMode(Boolean(trading.paper_mode));
      setKillSwitch(Boolean(trading.kill_switch));
      setBybitOptional(Boolean(trading.bybit_optional));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings.');
    } finally {
      setLoading(false);
    }
  };

  const saveSettings = async () => {
    if (!firestoreDb) {
      setError('Firestore not initialized.');
      return;
    }
    setLoading(true);
    setError(null);
    setSaved(false);

    try {
      await setDoc(
        doc(firestoreDb, SETTINGS_DOC),
        {
          telegram: { allowed_chat_ids: chatIds },
          trading: {
            risk_mode: riskMode,
            risk_value: Number(riskValue),
            max_signal_delay_sec: Number(maxSignalDelay),
            slippage_tol: Number(slippageTol),
            tp1_skip_buffer: Number(tp1Buffer),
            max_open_positions: Number(maxOpenPositions),
            max_positions_per_symbol: Number(maxPositionsPerSymbol),
            paper_mode: paperMode,
            kill_switch: killSwitch,
            bybit_optional: bybitOptional,
          },
        },
        { merge: true },
      );
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSettings();
  }, []);

  const disableControls = loading || authLoading || !isAdmin;

  const handleAddChatId = () => {
    const trimmed = newChatId.trim();
    if (!trimmed) return;
    if (chatIds.includes(trimmed)) {
      setNewChatId('');
      return;
    }
    setChatIds((prev) => [...prev, trimmed]);
    setNewChatId('');
  };

  const handleUpdateChatId = (index: number, value: string) => {
    setChatIds((prev) => prev.map((item, idx) => (idx === index ? value : item)));
  };

  const handleRemoveChatId = (index: number) => {
    setChatIds((prev) => prev.filter((_, idx) => idx !== index));
  };

  return (
    <DashboardShell
      active="settings"
      title="Settings"
      description="Configure trading controls, Telegram channels, and system safety toggles."
    >
      {!authLoading && !isAdmin ? (
        <div className="rounded-2xl border border-marine-navy/10 bg-white p-4 text-sm text-marine-navy/70 shadow-sm">
          You are signed in as a viewer. Settings are read-only.
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section className="space-y-6">
          <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-marine-navy">Trading controls</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div>
                <label className="text-sm text-marine-navy/70">Risk mode</label>
                <select
                  className="mt-2 w-full rounded-lg border border-marine-navy/20 bg-white px-3 py-2 text-sm"
                  value={riskMode}
                  onChange={(event) =>
                    setRiskMode(event.target.value as 'PERCENT_AVAILABLE_MARGIN' | 'FIXED_USDT')
                  }
                  disabled={disableControls}
                >
                  <option value="FIXED_USDT">Fixed USDT</option>
                  <option value="PERCENT_AVAILABLE_MARGIN">Percent of available margin</option>
                </select>
              </div>
              <div>
                <label className="text-sm text-marine-navy/70">Risk value</label>
                <input
                  className="mt-2 w-full rounded-lg border border-marine-navy/20 bg-white px-3 py-2 text-sm"
                  value={riskValue}
                  onChange={(event) => setRiskValue(event.target.value)}
                  type="number"
                  disabled={disableControls}
                />
              </div>
              <div>
                <label className="text-sm text-marine-navy/70">Max open positions</label>
                <input
                  className="mt-2 w-full rounded-lg border border-marine-navy/20 bg-white px-3 py-2 text-sm"
                  value={maxOpenPositions}
                  onChange={(event) => setMaxOpenPositions(event.target.value)}
                  type="number"
                  disabled={disableControls}
                />
              </div>
              <div>
                <label className="text-sm text-marine-navy/70">Max positions per symbol</label>
                <input
                  className="mt-2 w-full rounded-lg border border-marine-navy/20 bg-white px-3 py-2 text-sm"
                  value={maxPositionsPerSymbol}
                  onChange={(event) => setMaxPositionsPerSymbol(event.target.value)}
                  type="number"
                  disabled={disableControls}
                />
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-marine-navy">Signal safety</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <div>
                <label className="text-sm text-marine-navy/70">Max signal delay (sec)</label>
                <input
                  className="mt-2 w-full rounded-lg border border-marine-navy/20 bg-white px-3 py-2 text-sm"
                  value={maxSignalDelay}
                  onChange={(event) => setMaxSignalDelay(event.target.value)}
                  type="number"
                  disabled={disableControls}
                />
              </div>
              <div>
                <label className="text-sm text-marine-navy/70">Slippage tolerance</label>
                <input
                  className="mt-2 w-full rounded-lg border border-marine-navy/20 bg-white px-3 py-2 text-sm"
                  value={slippageTol}
                  onChange={(event) => setSlippageTol(event.target.value)}
                  type="number"
                  disabled={disableControls}
                />
              </div>
              <div>
                <label className="text-sm text-marine-navy/70">TP1 skip buffer</label>
                <input
                  className="mt-2 w-full rounded-lg border border-marine-navy/20 bg-white px-3 py-2 text-sm"
                  value={tp1Buffer}
                  onChange={(event) => setTp1Buffer(event.target.value)}
                  type="number"
                  disabled={disableControls}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-6">
          <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-marine-navy">Runtime switches</h2>
            <div className="mt-4 space-y-3 text-sm">
              <label className="flex items-center justify-between rounded-lg border border-marine-navy/10 bg-marine-mist px-3 py-2">
                <span>Paper mode (no live orders)</span>
                <input
                  type="checkbox"
                  checked={paperMode}
                  onChange={(event) => setPaperMode(event.target.checked)}
                  disabled={disableControls}
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border border-marine-navy/10 bg-marine-mist px-3 py-2">
                <span>Kill switch (block new trades)</span>
                <input
                  type="checkbox"
                  checked={killSwitch}
                  onChange={(event) => setKillSwitch(event.target.checked)}
                  disabled={disableControls}
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border border-marine-navy/10 bg-marine-mist px-3 py-2">
                <span>Allow worker without Bybit</span>
                <input
                  type="checkbox"
                  checked={bybitOptional}
                  onChange={(event) => setBybitOptional(event.target.checked)}
                  disabled={disableControls}
                />
              </label>
              <p className="text-xs text-marine-navy/60">
                When enabled, the worker will skip trade execution if Bybit credentials are not configured.
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-marine-navy">Telegram access</h2>
            <label className="mt-4 text-sm text-marine-navy/70">Allowed chat IDs</label>
            <p className="mt-1 text-xs text-marine-navy/60">
              Add multiple chat IDs to limit which Telegram channels are processed.
            </p>
            <div className="mt-3 rounded-xl border border-dashed border-marine-navy/20 bg-marine-mist p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">
                Add chat ID
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input
                  className="flex-1 rounded-lg border border-marine-navy/20 bg-white px-3 py-2 text-sm"
                  placeholder="-1001234567890"
                  value={newChatId}
                  onChange={(event) => setNewChatId(event.target.value)}
                  disabled={disableControls}
                />
                <button
                  className="rounded-full bg-marine-navy px-4 py-2 text-sm text-white disabled:opacity-60"
                  onClick={handleAddChatId}
                  disabled={disableControls || !newChatId.trim()}
                >
                  Add
                </button>
              </div>
            </div>
            <div className="mt-4 rounded-xl border border-marine-navy/10 bg-white">
              {chatIds.length === 0 ? (
                <div className="px-4 py-6 text-sm text-marine-navy/60">
                  No chat IDs configured. The worker will listen to all messages.
                </div>
              ) : (
                <ul className="divide-y divide-marine-navy/10">
                  {chatIds.map((chatId, index) => (
                    <li key={`${chatId}-${index}`} className="flex items-center gap-3 px-4 py-3">
                      <input
                        className="flex-1 rounded-lg border border-marine-navy/20 bg-marine-mist px-3 py-2 text-sm"
                        value={chatId}
                        onChange={(event) => handleUpdateChatId(index, event.target.value)}
                        disabled={disableControls}
                      />
                      <button
                        className="rounded-full border border-marine-navy/20 px-3 py-2 text-xs text-marine-navy"
                        onClick={() => handleRemoveChatId(index)}
                        disabled={disableControls}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          className="rounded-full border border-marine-navy/20 px-4 py-2 text-sm text-marine-navy"
          onClick={loadSettings}
          disabled={loading}
        >
          Refresh
        </button>
        <button
          className="rounded-full bg-marine-navy px-4 py-2 text-sm text-white shadow disabled:opacity-60"
          onClick={saveSettings}
          disabled={disableControls}
        >
          Save settings
        </button>
        {saved ? <span className="text-sm text-emerald-600">Saved</span> : null}
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </DashboardShell>
  );
}
