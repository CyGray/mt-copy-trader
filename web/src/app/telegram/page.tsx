'use client';

import { useEffect, useState, useCallback } from 'react';
import { DashboardLayout } from '@/components/layouts/DashboardLayout';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { FormField } from '@/components/ui/FormField';
import { CollapsibleSection } from '@/components/ui/CollapsibleSection';
import {
  MessageCircle,
  Phone,
  Key,
  Shield,
  CheckCircle,
  AlertCircle,
  Lock,
} from 'lucide-react';
import { doc, onSnapshot } from 'firebase/firestore';
import { firestoreDb } from '@/lib/firebaseClient';

type TelegramStep = 'phone' | 'otp' | 'password' | 'connected';

type TelegramStatus = 'disconnected' | 'awaiting_code' | 'awaiting_password' | 'authorized' | 'error';
type TelegramStatusResponse = {
  status: TelegramStatus;
  phone?: string | null;
  lastError?: string | null;
  reauthRequired?: boolean;
};

export default function TelegramPage() {
  const [step, setStep] = useState<TelegramStep>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reauthRequired, setReauthRequired] = useState(false);
  const [allowedChats, setAllowedChats] = useState<string[]>([]);
  const [chatLabels, setChatLabels] = useState<Record<string, string>>({});

  const isConnected = step === 'connected';

  const applyStatus = useCallback((status: TelegramStatusResponse) => {
    setReauthRequired(Boolean(status.reauthRequired));
    if (status.lastError) {
      setError(status.lastError);
    }

    switch (status.status) {
      case 'authorized':
        setStep('connected');
        break;
      case 'awaiting_password':
        setStep('password');
        break;
      case 'awaiting_code':
        setStep('otp');
        break;
      case 'disconnected':
      case 'error':
      default:
        setStep('phone');
        break;
    }
  }, []);

  useEffect(() => {
    let active = true;

    const fetchStatus = async () => {
      try {
        const response = await fetch('/api/telegram/status', { cache: 'no-store' });
        if (!response.ok) return;
        const data = (await response.json()) as TelegramStatusResponse;
        if (active) {
          if (data.phone && !phone) setPhone(data.phone);
          applyStatus(data);
        }
      } catch {
        if (active) setError('Unable to reach Telegram worker.');
      }
    };

    void fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [applyStatus, phone]);

  useEffect(() => {
    if (!firestoreDb) return;
    const ref = doc(firestoreDb, 'settings', 'default');
    const unsubscribe = onSnapshot(ref, (snap) => {
      const data = snap.data() as { telegram?: { allowed_chat_ids?: string[]; chat_labels?: Record<string, string> } } | undefined;
      setAllowedChats(data?.telegram?.allowed_chat_ids ?? []);
      setChatLabels(data?.telegram?.chat_labels ?? {});
    });
    return () => unsubscribe();
  }, []);

  const handlePhoneSubmit = useCallback(async () => {
    if (!phone.trim()) return;
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/telegram/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = (await response.json()) as TelegramStatusResponse;
      applyStatus(data);
      if (!response.ok) {
        setError(data.lastError ?? 'Unable to start Telegram login.');
      }
    } catch {
      setError('Worker unreachable');
    } finally {
      setIsLoading(false);
    }
  }, [phone]);

  const handleOtpSubmit = useCallback(async () => {
    if (!otp.trim()) return;
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/telegram/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: otp }),
      });
      const data = (await response.json()) as TelegramStatusResponse;
      applyStatus(data);
      if (!response.ok) {
        setError(data.lastError ?? 'Code not accepted.');
      }
    } catch {
      setError('Worker unreachable');
    } finally {
      setIsLoading(false);
    }
  }, [otp]);

  const handlePasswordSubmit = useCallback(async () => {
    if (!password.trim()) return;
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/telegram/verify-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = (await response.json()) as TelegramStatusResponse;
      applyStatus(data);
      if (!response.ok) {
        setError(data.lastError ?? 'Password not accepted.');
      }
    } catch {
      setError('Worker unreachable');
    } finally {
      setIsLoading(false);
    }
  }, [password]);

  const handleLogout = useCallback(async () => {
    setIsLoading(true);
    try {
      await fetch('/api/telegram/logout', { method: 'POST' });
    } catch {
      setError('Worker unreachable');
    } finally {
      setIsLoading(false);
      setStep('phone');
      setPhone('');
      setOtp('');
      setPassword('');
    }
  }, []);

  const renderStep = () => {
    switch (step) {
      case 'phone':
        return (
          <div className="space-y-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-marine-accent/10 mx-auto">
              <Phone className="h-8 w-8 text-marine-accent" />
            </div>
            <div className="text-center">
              <h3 className="text-lg font-semibold text-marine-navy">Enter Phone Number</h3>
              <p className="text-sm text-marine-navy/60">
                We'll send a verification code to your Telegram
              </p>
            </div>
            <FormField
              label="Phone Number"
              type="text"
              value={phone}
              onChange={setPhone}
              placeholder="+1234567890"
              hint="Include country code"
            />
            <Button onClick={handlePhoneSubmit} isLoading={isLoading} className="w-full">
              Send Code
            </Button>
          </div>
        );

      case 'otp':
        return (
          <div className="space-y-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-marine-accent/10 mx-auto">
              <Key className="h-8 w-8 text-marine-accent" />
            </div>
            <div className="text-center">
              <h3 className="text-lg font-semibold text-marine-navy">Enter Verification Code</h3>
              <p className="text-sm text-marine-navy/60">
                Check your Telegram for the code
              </p>
            </div>
            <FormField
              label="Verification Code"
              type="text"
              value={otp}
              onChange={setOtp}
              placeholder="12345"
            />
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setStep('phone')} className="flex-1">
                Back
              </Button>
              <Button onClick={handleOtpSubmit} isLoading={isLoading} className="flex-1">
                Verify
              </Button>
            </div>
          </div>
        );

      case 'password':
        return (
          <div className="space-y-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500/10 mx-auto">
              <Lock className="h-8 w-8 text-amber-500" />
            </div>
            <div className="text-center">
              <h3 className="text-lg font-semibold text-marine-navy">Two-Factor Authentication</h3>
              <p className="text-sm text-marine-navy/60">
                Enter your Telegram 2FA password
              </p>
            </div>
            <FormField
              label="2FA Password"
              type="text"
              value={password}
              onChange={setPassword}
              placeholder="Your 2FA password"
            />
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setStep('otp')} className="flex-1">
                Back
              </Button>
              <Button onClick={handlePasswordSubmit} isLoading={isLoading} className="flex-1">
                Submit
              </Button>
            </div>
          </div>
        );

      case 'connected':
        return (
          <div className="space-y-6">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-trade-up/10 mx-auto">
              <CheckCircle className="h-8 w-8 text-trade-up" />
            </div>
            <div className="text-center">
              <h3 className="text-lg font-semibold text-marine-navy">Connected Successfully</h3>
              <p className="text-sm text-marine-navy/60">
                Your Telegram account is linked and listening for signals
              </p>
            </div>
            
            {/* Connection Info */}
            <div className="rounded-lg border border-marine-navy/10 bg-marine-mist/50 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-marine-navy">Session Status</p>
                  <p className="text-xs text-marine-navy/50">Active listener running</p>
                </div>
                <StatusBadge status="success" label="Online" pulse />
              </div>
            </div>

            <Button variant="danger" onClick={handleLogout} isLoading={isLoading} className="w-full">
              Disconnect & Logout
            </Button>
          </div>
        );
    }
  };

  return (
    <DashboardLayout
      title="Telegram"
      subtitle="Connect your Telegram account"
      breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Telegram' }]}
    >
      <div className="mx-auto max-w-lg space-y-6">
        {/* Status Card */}
        <div className="rounded-xl border border-marine-navy/10 bg-white p-6">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#0088cc]/10">
                <MessageCircle className="h-5 w-5 text-[#0088cc]" />
              </div>
              <div>
                <p className="font-semibold text-marine-navy">Telegram Connection</p>
                <p className="text-xs text-marine-navy/50">User session authentication</p>
              </div>
            </div>
            <StatusBadge
              status={isConnected ? 'success' : 'warning'}
              label={isConnected ? 'Connected' : 'Not Connected'}
            />
          </div>
          {reauthRequired && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
              <AlertCircle className="h-4 w-4" />
              Re-authentication required. Please complete the login flow.
            </div>
          )}

          {/* Error Display */}
          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          {/* Step Content */}
          {renderStep()}
        </div>

        {/* Info Section */}
        <CollapsibleSection
          title="Why Connect Telegram?"
          icon={<Shield className="h-4 w-4" />}
        >
          <div className="space-y-3 text-sm text-marine-navy/70">
            <p>
              ByTrader uses your Telegram account to listen for trading signals in real-time.
              This requires a user session to access private channels and groups.
            </p>
            <ul className="list-inside list-disc space-y-1">
              <li>Receive signals from private channels</li>
              <li>Process messages in real-time</li>
              <li>Automated signal parsing and execution</li>
            </ul>
            <p className="text-xs text-marine-navy/50">
              Your credentials are encrypted and stored securely. The session is only used to listen for messages.
            </p>
          </div>
        </CollapsibleSection>

        {/* Allowed Chats */}
        <CollapsibleSection
          title="Allowed Chats"
          icon={<MessageCircle className="h-4 w-4" />}
        >
          <div className="space-y-2 text-sm text-marine-navy/70">
            {allowedChats.length === 0 ? (
              <p className="text-xs text-marine-navy/50">No allowed chat IDs configured in Firestore.</p>
            ) : (
              allowedChats.map((chatId) => (
                <div key={chatId} className="flex items-center justify-between rounded-lg border border-marine-navy/10 bg-marine-mist/50 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-marine-navy">
                      {chatLabels[chatId] ?? 'Unnamed Chat'}
                    </p>
                    <p className="text-[10px] text-marine-navy/50">{chatId}</p>
                  </div>
                  <StatusBadge status="success" label="Allowed" size="sm" />
                </div>
              ))
            )}
          </div>
        </CollapsibleSection>
      </div>
    </DashboardLayout>
  );
}
