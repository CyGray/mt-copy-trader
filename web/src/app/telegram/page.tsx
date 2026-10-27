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
import { ApiError, authedFetch, errorMessage } from '@/lib/adminApi';

type TelegramStep = 'phone' | 'otp' | 'password' | 'connected';

type TelegramStatus = 'disconnected' | 'awaiting_code' | 'awaiting_password' | 'authorized' | 'error';
type TelegramStatusResponse = {
  status: TelegramStatus;
  phone?: string | null;
  lastError?: string | null;
  reauthRequired?: boolean;
};

function isTelegramStatus(body: unknown): body is TelegramStatusResponse {
  return Boolean(body) && typeof body === 'object' && typeof (body as { status?: unknown }).status === 'string';
}

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
        const data = await authedFetch<TelegramStatusResponse>('/api/telegram/status');
        if (active) {
          if (data.phone && !phone) setPhone(data.phone);
          applyStatus(data);
        }
      } catch (err) {
        // Not signed in yet: DashboardLayout redirects to /login, so stay quiet.
        if (!active || (err instanceof ApiError && err.status === 401)) return;
        setError(err instanceof ApiError && err.status === 502 ? 'Unable to reach Telegram worker.' : errorMessage(err, 'Unable to reach Telegram worker.'));
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
      const data = snap.data() as { telegram?: { allowed_chat_ids?: string[]; chat_id_labels?: Record<string, string> } } | undefined;
      setAllowedChats(data?.telegram?.allowed_chat_ids ?? []);
      setChatLabels(data?.telegram?.chat_id_labels ?? {});
    });
    return () => unsubscribe();
  }, []);

  const postTelegram = useCallback(
    async (path: string, payload: Record<string, string>, fallbackError: string) => {
      setIsLoading(true);
      setError(null);
      try {
        const data = await authedFetch<TelegramStatusResponse>(path, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        applyStatus(data);
        return true;
      } catch (err) {
        if (err instanceof ApiError && isTelegramStatus(err.body)) applyStatus(err.body);
        setError(errorMessage(err, fallbackError));
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [applyStatus],
  );

  const handlePhoneSubmit = useCallback(async () => {
    if (!phone.trim()) return;
    await postTelegram('/api/telegram/start', { phone }, 'Unable to start Telegram login.');
  }, [phone, postTelegram]);

  const handleOtpSubmit = useCallback(async () => {
    if (!otp.trim()) return;
    await postTelegram('/api/telegram/verify-otp', { code: otp }, 'Code not accepted.');
  }, [otp, postTelegram]);

  const handlePasswordSubmit = useCallback(async () => {
    if (!password.trim()) return;
    await postTelegram('/api/telegram/verify-password', { password }, 'Password not accepted.');
  }, [password, postTelegram]);

  const handleLogout = useCallback(async () => {
    setIsLoading(true);
    try {
      await authedFetch('/api/telegram/logout', { method: 'POST' });
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

  const handleResetLogin = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      await authedFetch('/api/telegram/logout', { method: 'POST' });
    } catch {
      setError('Worker unreachable');
    } finally {
      setIsLoading(false);
      setStep('phone');
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
                We&apos;ll send a verification code to your Telegram
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
              <Button variant="secondary" onClick={handleResetLogin} isLoading={isLoading} className="flex-1">
                Change number
              </Button>
              <Button variant="secondary" onClick={handlePhoneSubmit} isLoading={isLoading} className="flex-1">
                Resend code
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
              type="password"
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
