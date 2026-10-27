'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import Link from 'next/link';
import { DashboardLayout } from '@/components/layouts/DashboardLayout';
import { CollapsibleSection } from '@/components/ui/CollapsibleSection';
import { FormField } from '@/components/ui/FormField';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Save, RefreshCw, Plus, Trash2, Shield, DollarSign, MessageCircle, Link as LinkIcon } from 'lucide-react';
import { doc, onSnapshot } from 'firebase/firestore';
import { firestoreDb } from '@/lib/firebaseClient';
import { apiIssues, authedFetch, errorMessage, type ApiIssue } from '@/lib/adminApi';

interface TelegramSettings {
  chatIds: string[];
  blockedChatIds: string[];
  chatIdLabels: Record<string, string>;
}

// Sizing, limits and execution come from the active execution profile and the safety
// limits (Profiles and Admin pages). The legacy trading.* knobs this page used to edit
// (risk mode, slippage, "Bybit/MT5 optional") are not read by the v2 AutoTrader.
interface Settings {
  telegram: TelegramSettings;
}

const DEFAULT_SETTINGS: Settings = {
  telegram: {
    chatIds: [],
    blockedChatIds: [],
    chatIdLabels: {},
  },
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [killSwitch, setKillSwitch] = useState(false);
  const [killBusy, setKillBusy] = useState(false);
  const [executionMode, setExecutionMode] = useState<string>('disabled');
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveIssues, setSaveIssues] = useState<ApiIssue[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [newChatId, setNewChatId] = useState('');
  const [newBlockedChatId, setNewBlockedChatId] = useState('');
  const [newChatLabel, setNewChatLabel] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  // Live snapshots must not overwrite unsaved edits.
  const dirtyRef = useRef(false);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setHasChanges(true);
  }, []);

  useEffect(() => {
    if (!firestoreDb) {
      setIsLoading(false);
      return;
    }

    const ref = doc(firestoreDb, 'settings', 'default');
    const unsubscribe = onSnapshot(ref, (snap) => {
      const data = (snap.data() ?? {}) as {
        trading?: Record<string, unknown>;
        telegram?: Record<string, unknown>;
        execution?: Record<string, unknown>;
      };

      const trading = data.trading ?? {};
      const telegram = data.telegram ?? {};

      setKillSwitch(trading.kill_switch === true);
      setExecutionMode(typeof data.execution?.mode === 'string' ? data.execution.mode : 'disabled');
      setIsLoading(false);

      if (dirtyRef.current) return;

      const nextSettings: Settings = {
        telegram: {
          chatIds: (telegram.allowed_chat_ids as string[]) ?? (telegram.chatIds as string[]) ?? DEFAULT_SETTINGS.telegram.chatIds,
          blockedChatIds:
            (telegram.blocked_chat_ids as string[]) ??
            (telegram.blockedChatIds as string[]) ??
            DEFAULT_SETTINGS.telegram.blockedChatIds,
          chatIdLabels: (telegram.chat_id_labels as Record<string, string>) ?? (telegram.chatIdLabels as Record<string, string>) ?? DEFAULT_SETTINGS.telegram.chatIdLabels,
        },
      };

      setSettings(nextSettings);
      setHasChanges(false);
    });

    return () => unsubscribe();
  }, []);

  // Kill switch goes through the API (it takes effect immediately, outside the save bar).
  const toggleKillSwitch = useCallback(async (engaged: boolean) => {
    if (!engaged && !window.confirm('Release the kill switch? New entries can resume if the execution mode and active profile allow them.')) {
      return;
    }
    setKillBusy(true);
    setActionError(null);
    try {
      await authedFetch('/api/execution/kill-switch', {
        method: 'POST',
        body: JSON.stringify({ engaged }),
      });
      setKillSwitch(engaged);
    } catch (err) {
      setActionError(errorMessage(err, 'Kill switch change failed.'));
    } finally {
      setKillBusy(false);
    }
  }, []);

  // Add chat
  const addChat = useCallback(() => {
    if (!newChatId.trim()) return;
    const trimmedId = newChatId.trim();
    setSettings((prev) => ({
      ...prev,
      telegram: {
        ...prev.telegram,
        chatIds: prev.telegram.chatIds.includes(trimmedId)
          ? prev.telegram.chatIds
          : [...prev.telegram.chatIds, trimmedId],
        chatIdLabels: {
          ...prev.telegram.chatIdLabels,
          [trimmedId]: newChatLabel || prev.telegram.chatIdLabels[trimmedId] || `Chat ${prev.telegram.chatIds.length + 1}`,
        },
      },
    }));
    setNewChatId('');
    setNewChatLabel('');
    markDirty();
  }, [newChatId, newChatLabel, markDirty]);

  // Remove chat
  const removeChat = useCallback((chatId: string) => {
    setSettings((prev) => {
      const newLabels = { ...prev.telegram.chatIdLabels };
      delete newLabels[chatId];
      return {
        ...prev,
        telegram: {
          ...prev.telegram,
          chatIds: prev.telegram.chatIds.filter((id) => id !== chatId),
          chatIdLabels: newLabels,
        },
      };
    });
    markDirty();
  }, [markDirty]);

  const addBlockedChat = useCallback(() => {
    if (!newBlockedChatId.trim()) return;
    const trimmedId = newBlockedChatId.trim();
    setSettings((prev) => ({
      ...prev,
      telegram: {
        ...prev.telegram,
        blockedChatIds: prev.telegram.blockedChatIds.includes(trimmedId)
          ? prev.telegram.blockedChatIds
          : [...prev.telegram.blockedChatIds, trimmedId],
      },
    }));
    setNewBlockedChatId('');
    markDirty();
  }, [newBlockedChatId, markDirty]);

  const removeBlockedChat = useCallback((chatId: string) => {
    setSettings((prev) => ({
      ...prev,
      telegram: {
        ...prev.telegram,
        blockedChatIds: prev.telegram.blockedChatIds.filter((id) => id !== chatId),
      },
    }));
    markDirty();
  }, [markDirty]);

  // Save handler: whitelisted fields only, validated by POST /api/settings
  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    setSaveIssues([]);
    try {
      await authedFetch('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          telegram: {
            allowed_chat_ids: settings.telegram.chatIds,
            blocked_chat_ids: settings.telegram.blockedChatIds,
            chat_id_labels: settings.telegram.chatIdLabels,
          },
        }),
      });
      dirtyRef.current = false;
      setHasChanges(false);
    } catch (err) {
      setSaveError(errorMessage(err, 'Save failed.'));
      setSaveIssues(apiIssues(err));
    } finally {
      setIsSaving(false);
    }
  }, [settings]);

  return (
    <DashboardLayout
      title="Settings"
      subtitle="Safety controls and Telegram channels"
      breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Settings' }]}
    >
      <div className="space-y-4 pb-20">
        {isLoading && (
          <div className="rounded-lg border border-marine-navy/10 bg-marine-mist/50 px-4 py-2 text-xs text-marine-navy/60">
            Loading settings from Firestore...
          </div>
        )}
        {actionError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">{actionError}</div>
        )}
        {/* Safety Controls */}
        <CollapsibleSection
          title="Safety Controls"
          icon={<Shield className="h-4 w-4" />}
          defaultOpen
          badge={killSwitch ? <StatusBadge status="danger" label="KILL ACTIVE" pulse size="sm" /> : undefined}
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 p-4">
              <div className="pr-4">
                <p className="font-medium text-red-800">Kill Switch</p>
                <p className="text-xs text-red-600">
                  Blocks new entries and pending orders. Open trades keep being protected and managed
                  (partial closes, stop-loss, break-even, trailing). Close-all is on the Admin page.
                </p>
              </div>
              <FormField
                type="toggle"
                value={killSwitch}
                disabled={killBusy}
                onChange={(val) => void toggleKillSwitch(val)}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-marine-navy/10 bg-marine-mist/50 p-4">
              <div className="pr-4">
                <p className="font-medium text-marine-navy">Execution mode</p>
                <p className="text-xs text-marine-navy/60">
                  Current mode: <span className="font-mono font-semibold uppercase">{executionMode}</span>
                </p>
              </div>
              <Link href="/admin" className="text-xs font-medium text-marine-accent underline">
                Change on Admin page
              </Link>
            </div>
          </div>
        </CollapsibleSection>

        {/* Where execution settings live */}
        <CollapsibleSection
          title="Position sizing and limits"
          icon={<DollarSign className="h-4 w-4" />}
          defaultOpen
        >
          <div className="space-y-2 text-sm text-marine-navy/80">
            <p>
              Lot size, risk per trade, take-profit split, stop-loss rules and signal age come from the{' '}
              <Link href="/profiles" className="font-medium text-marine-accent underline">active execution profile</Link>.
              Account-wide caps (risk, lots, positions, daily loss, spread) are the{' '}
              <Link href="/admin" className="font-medium text-marine-accent underline">safety limits</Link>, which every profile must fit.
            </p>
            <p className="text-xs text-marine-navy/60">
              The older risk-mode and slippage settings from the Bybit version are no longer used and were removed from this page.
            </p>
          </div>
        </CollapsibleSection>

        {/* Telegram Channels */}
        <CollapsibleSection
          title="Telegram Channels"
          icon={<MessageCircle className="h-4 w-4" />}
          defaultOpen
          badge={
            <StatusBadge
              status="success"
              label={`${settings.telegram.chatIds.length} allow / ${settings.telegram.blockedChatIds.length} block`}
              size="sm"
            />
          }
        >
          <div className="space-y-4">
            {/* Current Chats */}
            {settings.telegram.chatIds.map((chatId) => (
              <div
                key={chatId}
                className="flex items-center justify-between rounded-lg border border-marine-navy/10 bg-marine-mist/50 p-3"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-marine-accent/10">
                    <MessageCircle className="h-4 w-4 text-marine-accent" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-marine-navy">
                      {settings.telegram.chatIdLabels[chatId] || chatId}
                    </p>
                    <p className="font-mono text-[10px] text-marine-navy/50">{chatId}</p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeChat(chatId)}
                  className="text-red-500 hover:bg-red-50"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}

            {/* Add New Chat */}
            <div className="flex flex-col gap-2 rounded-lg border border-dashed border-marine-navy/20 p-3 sm:flex-row">
              <input
                type="text"
                placeholder="Chat ID"
                value={newChatId}
                onChange={(e) => setNewChatId(e.target.value)}
                className="flex-1 rounded border border-marine-navy/20 px-3 py-2 text-sm focus:border-marine-accent focus:outline-none"
              />
              <input
                type="text"
                placeholder="Label (optional)"
                value={newChatLabel}
                onChange={(e) => setNewChatLabel(e.target.value)}
                className="flex-1 rounded border border-marine-navy/20 px-3 py-2 text-sm focus:border-marine-accent focus:outline-none"
              />
              <Button variant="secondary" size="sm" onClick={addChat}>
                <Plus className="mr-1 h-4 w-4" />
                Add
              </Button>
            </div>

            <div className="rounded-lg border border-marine-navy/10 bg-marine-mist/30 p-3">
              <p className="mb-2 text-xs font-medium text-marine-navy/70">Blocked Chat IDs</p>
              <div className="space-y-2">
                {settings.telegram.blockedChatIds.map((chatId) => (
                  <div
                    key={`blocked-${chatId}`}
                    className="flex items-center justify-between rounded border border-red-200 bg-red-50/50 px-3 py-2"
                  >
                    <p className="font-mono text-[11px] text-marine-navy/70">{chatId}</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeBlockedChat(chatId)}
                      className="text-red-500 hover:bg-red-50"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    placeholder="Blocked Chat ID"
                    value={newBlockedChatId}
                    onChange={(e) => setNewBlockedChatId(e.target.value)}
                    className="flex-1 rounded border border-marine-navy/20 px-3 py-2 text-sm focus:border-marine-accent focus:outline-none"
                  />
                  <Button variant="secondary" size="sm" onClick={addBlockedChat}>
                    <Plus className="mr-1 h-4 w-4" />
                    Block
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </CollapsibleSection>

        {/* Integrations */}
        <CollapsibleSection
          title="Integrations"
          icon={<LinkIcon className="h-4 w-4" />}
        >
          <div className="flex items-center justify-between rounded-lg border border-marine-navy/10 p-4">
            <div>
              <p className="font-medium text-marine-navy">Vantage MT5</p>
              <p className="text-xs text-marine-navy/60">
                Orders go through VantageBridgeEA v2 on the VPS. Whether anything is sent is decided by the execution mode
                and kill switch above, never by a setting here.
              </p>
            </div>
            <StatusBadge status="info" label={executionMode} />
          </div>
        </CollapsibleSection>
      </div>

      {/* Sticky Save Bar */}
      <div
        className={`
          fixed bottom-0 left-0 right-0 z-50 border-t border-marine-navy/10 bg-white p-4
          transition-transform duration-300 sm:left-16
          ${hasChanges ? 'translate-y-0' : 'translate-y-full'}
        `}
      >
        <div className="mx-auto max-w-4xl">
          {saveError && (
            <div className="mb-2 text-xs text-red-600">
              <p>{saveError}</p>
              {saveIssues.map((issue) => (
                <p key={issue.path} className="font-mono">
                  {issue.path}: {issue.message}
                </p>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between">
            <p className="text-sm text-marine-navy/60">You have unsaved changes</p>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setSettings(DEFAULT_SETTINGS);
                  markDirty();
                }}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Reset
              </Button>
              <Button onClick={handleSave} isLoading={isSaving}>
                <Save className="mr-2 h-4 w-4" />
                Save Changes
              </Button>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
