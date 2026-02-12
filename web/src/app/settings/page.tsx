'use client';

import { useState, useCallback, useEffect } from 'react';
import { DashboardLayout } from '@/components/layouts/DashboardLayout';
import { CollapsibleSection } from '@/components/ui/CollapsibleSection';
import { FormField } from '@/components/ui/FormField';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Save, RefreshCw, Plus, Trash2, Shield, DollarSign, MessageCircle, Link } from 'lucide-react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { firestoreDb } from '@/lib/firebaseClient';

// Type for settings
interface TradingSettings {
  riskMode: string;
  riskValue: number;
  maxOpenPositions: number;
  maxPositionsPerSymbol: number;
  maxSignalDelay: number;
  slippageTol: number;
  tp1SkipBuffer: number;
  paperMode: boolean;
  killSwitch: boolean;
  bybitOptional: boolean;
}


interface TelegramSettings {
  chatIds: string[];
  blockedChatIds: string[];
  chatIdLabels: Record<string, string>;
}

interface Settings {
  trading: TradingSettings;
  telegram: TelegramSettings;
}

const DEFAULT_SETTINGS: Settings = {
  trading: {
    riskMode: 'FIXED_USDT',
    riskValue: 20,
    maxOpenPositions: 3,
    maxPositionsPerSymbol: 1,
    maxSignalDelay: 120,
    slippageTol: 0.001,
    tp1SkipBuffer: 0.0015,
    paperMode: false,
    killSwitch: false,
    bybitOptional: false,
  },
  telegram: {
    chatIds: [],
    blockedChatIds: [],
    chatIdLabels: {},
  },
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [newChatId, setNewChatId] = useState('');
  const [newBlockedChatId, setNewBlockedChatId] = useState('');
  const [newChatLabel, setNewChatLabel] = useState('');
  const [isLoading, setIsLoading] = useState(true);

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
      };

      const trading = data.trading ?? {};
      const telegram = data.telegram ?? {};

      const nextSettings: Settings = {
        trading: {
          riskMode: (trading.risk_mode as string) ?? (trading.riskMode as string) ?? DEFAULT_SETTINGS.trading.riskMode,
          riskValue: Number(trading.risk_value ?? trading.riskValue ?? DEFAULT_SETTINGS.trading.riskValue),
          maxOpenPositions: Number(trading.max_open_positions ?? trading.maxOpenPositions ?? DEFAULT_SETTINGS.trading.maxOpenPositions),
          maxPositionsPerSymbol: Number(trading.max_positions_per_symbol ?? trading.maxPositionsPerSymbol ?? DEFAULT_SETTINGS.trading.maxPositionsPerSymbol),
          maxSignalDelay: Number(trading.max_signal_delay_sec ?? trading.maxSignalDelay ?? DEFAULT_SETTINGS.trading.maxSignalDelay),
          slippageTol: Number(trading.slippage_tol ?? trading.slippageTol ?? DEFAULT_SETTINGS.trading.slippageTol),
          tp1SkipBuffer: Number(trading.tp1_skip_buffer ?? trading.tp1SkipBuffer ?? DEFAULT_SETTINGS.trading.tp1SkipBuffer),
          paperMode: Boolean(trading.paper_mode ?? trading.paperMode ?? DEFAULT_SETTINGS.trading.paperMode),
          killSwitch: Boolean(trading.kill_switch ?? trading.killSwitch ?? DEFAULT_SETTINGS.trading.killSwitch),
          bybitOptional: Boolean(trading.bybit_optional ?? trading.bybitOptional ?? DEFAULT_SETTINGS.trading.bybitOptional),
        },
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
      setIsLoading(false);
    });

    return () => unsubscribe();
  }, []);

  // Update trading settings
  const updateTrading = useCallback(<K extends keyof TradingSettings>(
    field: K,
    value: TradingSettings[K]
  ) => {
    setSettings((prev) => ({
      ...prev,
      trading: { ...prev.trading, [field]: value },
    }));
    setHasChanges(true);
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
    setHasChanges(true);
  }, [newChatId, newChatLabel]);

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
    setHasChanges(true);
  }, []);

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
    setHasChanges(true);
  }, [newBlockedChatId]);

  const removeBlockedChat = useCallback((chatId: string) => {
    setSettings((prev) => ({
      ...prev,
      telegram: {
        ...prev.telegram,
        blockedChatIds: prev.telegram.blockedChatIds.filter((id) => id !== chatId),
      },
    }));
    setHasChanges(true);
  }, []);

  // Save handler
  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      if (!firestoreDb) {
        setIsSaving(false);
        return;
      }

      const ref = doc(firestoreDb, 'settings', 'default');
      await setDoc(
        ref,
        {
          trading: {
            risk_mode: settings.trading.riskMode,
            risk_value: settings.trading.riskValue,
            max_open_positions: settings.trading.maxOpenPositions,
            max_positions_per_symbol: settings.trading.maxPositionsPerSymbol,
            max_signal_delay_sec: settings.trading.maxSignalDelay,
            slippage_tol: settings.trading.slippageTol,
            tp1_skip_buffer: settings.trading.tp1SkipBuffer,
            paper_mode: settings.trading.paperMode,
            kill_switch: settings.trading.killSwitch,
            bybit_optional: settings.trading.bybitOptional,
          },
          telegram: {
            allowed_chat_ids: settings.telegram.chatIds,
            blocked_chat_ids: settings.telegram.blockedChatIds,
            chat_id_labels: settings.telegram.chatIdLabels,
          },
        },
        { merge: true },
      );
      setHasChanges(false);
    } finally {
      setIsSaving(false);
    }
  }, [settings]);

  return (
    <DashboardLayout
      title="Settings"
      subtitle="Configure trading parameters and integrations"
      breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Settings' }]}
    >
      <div className="space-y-4 pb-20">
        {isLoading && (
          <div className="rounded-lg border border-marine-navy/10 bg-marine-mist/50 px-4 py-2 text-xs text-marine-navy/60">
            Loading settings from Firestore...
          </div>
        )}
        {/* Safety Controls */}
        <CollapsibleSection
          title="Safety Controls"
          icon={<Shield className="h-4 w-4" />}
          defaultOpen
          badge={settings.trading.killSwitch ? <StatusBadge status="danger" label="KILL ACTIVE" pulse size="sm" /> : undefined}
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 p-4">
              <div>
                <p className="font-medium text-red-800">Kill Switch</p>
                <p className="text-xs text-red-600">Stop all trading immediately</p>
              </div>
              <FormField
                type="toggle"
                value={settings.trading.killSwitch}
                onChange={(val) => updateTrading('killSwitch', val)}
              />
            </div>
            
            <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div>
                <p className="font-medium text-amber-800">Paper Mode</p>
                <p className="text-xs text-amber-600">Simulate trades without real money</p>
              </div>
              <FormField
                type="toggle"
                value={settings.trading.paperMode}
                onChange={(val) => updateTrading('paperMode', val)}
              />
            </div>
          </div>
        </CollapsibleSection>

        {/* Risk & Position Sizing */}
        <CollapsibleSection
          title="Risk & Position Sizing"
          icon={<DollarSign className="h-4 w-4" />}
          defaultOpen
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Risk Mode"
              type="select"
              value={settings.trading.riskMode}
              onChange={(val) => updateTrading('riskMode', val)}
              options={[
                { value: 'FIXED_USDT', label: 'Fixed USDT' },
                { value: 'PERCENT_BALANCE', label: '% of Balance' },
                { value: 'FIXED_CONTRACTS', label: 'Fixed Contracts' },
              ]}
              hint="How to calculate position size"
            />
            
            <FormField
              label="Risk Value"
              type="number"
              value={settings.trading.riskValue}
              onChange={(val) => updateTrading('riskValue', val)}
              hint={settings.trading.riskMode === 'FIXED_USDT' ? 'USDT per trade' : 'Amount/percentage'}
            />

            <FormField
              label="Max Open Positions"
              type="number"
              value={settings.trading.maxOpenPositions}
              onChange={(val) => updateTrading('maxOpenPositions', val)}
              hint="Maximum concurrent positions"
            />
            
            <FormField
              label="Max Per Symbol"
              type="number"
              value={settings.trading.maxPositionsPerSymbol}
              onChange={(val) => updateTrading('maxPositionsPerSymbol', val)}
              hint="Max positions per trading pair"
            />

            <FormField
              label="Max Signal Delay (s)"
              type="number"
              value={settings.trading.maxSignalDelay}
              onChange={(val) => updateTrading('maxSignalDelay', val)}
              hint="Ignore signals older than this"
            />
            
            <FormField
              label="Slippage Tolerance"
              type="number"
              value={settings.trading.slippageTol}
              onChange={(val) => updateTrading('slippageTol', val)}
              hint="0.001 = 0.1%"
              step={0.0001}
            />

            <FormField
              label="TP1 Skip Buffer"
              type="number"
              value={settings.trading.tp1SkipBuffer}
              onChange={(val) => updateTrading('tp1SkipBuffer', val)}
              hint="Skip entry if past TP1 by this %"
              step={0.0001}
            />
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
          icon={<Link className="h-4 w-4" />}
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-marine-navy/10 p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500">
                  <span className="text-lg font-bold text-white">B</span>
                </div>
                <div>
                  <p className="font-medium text-marine-navy">Bybit API</p>
                  <p className="text-xs text-marine-navy/60">Connected as main exchange</p>
                </div>
              </div>
              <StatusBadge status="success" label="Connected" />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-marine-navy">Bybit Optional</p>
                <p className="text-xs text-marine-navy/60">Allow trading without Bybit connection</p>
              </div>
              <FormField
                type="toggle"
                value={settings.trading.bybitOptional}
                onChange={(val) => updateTrading('bybitOptional', val)}
              />
            </div>
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
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <p className="text-sm text-marine-navy/60">You have unsaved changes</p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setSettings(DEFAULT_SETTINGS);
                setHasChanges(true);
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
    </DashboardLayout>
  );
}
