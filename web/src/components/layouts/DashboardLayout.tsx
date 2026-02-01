'use client';

import { type ReactNode, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/navigation/Sidebar';
import { Header } from '@/components/navigation/Header';
import { useAuth } from '@/lib/useAuth';

interface DashboardLayoutProps {
  children: ReactNode;
  title: string;
  subtitle?: string;
  breadcrumbs?: { label: string; href?: string }[];
  headerActions?: ReactNode;
}

export function DashboardLayout({
  children,
  title,
  subtitle,
  breadcrumbs,
  headerActions,
}: DashboardLayoutProps) {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-marine-mist">
        <div className="flex min-h-screen items-center justify-center text-sm text-marine-navy/60">
          Loading session...
        </div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="min-h-screen bg-marine-mist">
      {/* Sidebar */}
      <Sidebar />

      {/* Main content area - offset for sidebar */}
      <div className="lg:pl-16">
        {/* Header */}
        <Header
          title={title}
          subtitle={subtitle}
          breadcrumbs={breadcrumbs}
          actions={headerActions}
        />

        {/* Page content */}
        <main className="px-4 py-4 pb-20 lg:px-6 lg:pb-6">
          <div className="mx-auto max-w-7xl animate-fade-in">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
