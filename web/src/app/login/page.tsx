'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { TrendingUp, Shield, Zap, BarChart3 } from 'lucide-react';
import { signInWithGoogle } from '@/lib/auth';
import { useAuth } from '@/lib/useAuth';

export default function LoginPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user) {
      router.replace('/');
    }
  }, [loading, user, router]);

  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    setError(null);

    try {
      await signInWithGoogle();
      router.replace('/');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sign-in failed.';
      setError(message);
      setIsLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-marine-navy via-marine-blue to-marine-navy">
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute -left-40 -top-40 h-80 w-80 rounded-full bg-marine-accent/10 blur-3xl" />
        <div className="absolute -bottom-40 -right-40 h-96 w-96 rounded-full bg-marine-accent/5 blur-3xl" />
        <div className="absolute left-1/2 top-1/4 h-64 w-64 -translate-x-1/2 rounded-full bg-trade-up/5 blur-3xl" />
      </div>

      {/* Grid pattern overlay */}
      <div
        className="absolute inset-0 opacity-[0.02]"
        style={{
          backgroundImage: `linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)`,
          backgroundSize: '40px 40px',
        }}
      />

      {/* Content */}
      <div className="relative z-10 w-full max-w-md px-4">
        {/* Logo & Branding */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-marine-accent to-marine-blue shadow-lg shadow-marine-accent/20">
            <TrendingUp className="h-8 w-8 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-white">ByTrader</h1>
          <p className="mt-2 text-marine-mist/60">Automated Telegram Signal Trading</p>
        </div>

        {/* Login Card */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-8 shadow-2xl backdrop-blur-xl">
          {/* Status Badge */}
          <div className="mb-6 flex justify-center">
            <StatusBadge status="success" label="System Online" pulse />
          </div>

          {/* Features */}
          <div className="mb-8 space-y-3">
            {[
              { icon: Zap, text: 'Real-time signal execution' },
              { icon: Shield, text: 'Smart risk management' },
              { icon: BarChart3, text: 'Automated TP/SL management' },
            ].map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-3 text-sm text-marine-mist/70">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/5">
                  <Icon className="h-4 w-4 text-marine-accent" />
                </div>
                {text}
              </div>
            ))}
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-center text-sm text-red-300">
              {error}
            </div>
          )}

          {/* Google Sign In Button */}
          <Button
            onClick={handleGoogleSignIn}
            isLoading={isLoading}
            className="w-full bg-white text-marine-navy hover:bg-marine-mist"
          >
            {!isLoading && (
              <svg className="mr-3 h-5 w-5" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
            )}
            {isLoading ? 'Signing in...' : 'Continue with Google'}
          </Button>

          {/* Footer Note */}
          <p className="mt-6 text-center text-[10px] text-marine-mist/40">
            Only authorized administrators can access this system
          </p>
        </div>

        {/* Version */}
        <p className="mt-6 text-center text-[10px] text-marine-mist/30">
          v1.0.0 • Built with Next.js
        </p>
      </div>
    </div>
  );
}
