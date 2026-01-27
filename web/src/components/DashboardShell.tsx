'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

type NavItem = {
  label: string;
  href?: string;
  disabled?: boolean;
};

type DashboardShellProps = {
  active: 'dashboard' | 'logs' | 'settings' | 'trades' | 'analytics' | 'admin';
  title: string;
  description?: string;
  children: ReactNode;
};

const NAV_ITEMS: NavItem[] = [
  { label: 'Overview', href: '/' },
  { label: 'Trade History', href: '/trades' },
  { label: 'Settings', href: '/settings' },
  { label: 'Analytics', href: '/analytics' },
  { label: 'Admin Actions', href: '/admin' },
  { label: 'Logs', href: '/logs' },
];

export default function DashboardShell({ active, title, description, children }: DashboardShellProps) {
  return (
    <div className="min-h-screen bg-marine-mist text-marine-navy">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8 lg:flex-row">
        <aside className="w-full overflow-hidden rounded-2xl border border-marine-navy/10 bg-white shadow-sm lg:w-72">
          <div className="border-b border-marine-navy/10 p-4">
            <div className="flex items-center gap-3">
              <img
                src="/logo.png"
                alt="Marine Trader logo"
                className="h-10 w-10 rounded-full bg-white object-contain"
              />
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-marine-navy/60">
                  Marine Trader
                </p>
                <h2 className="text-lg font-semibold text-marine-navy">Command Center</h2>
              </div>
            </div>
          </div>
          <nav className="p-3 text-sm">
            {NAV_ITEMS.map((item) => {
              const isActive =
                (item.label === 'Overview' && active === 'dashboard') ||
                (item.label === 'Trade History' && active === 'trades') ||
                (item.label === 'Settings' && active === 'settings') ||
                (item.label === 'Analytics' && active === 'analytics') ||
                (item.label === 'Admin Actions' && active === 'admin') ||
                (item.label === 'Logs' && active === 'logs');
              if (item.disabled) {
                return (
                  <button
                    key={item.label}
                    className="w-full cursor-not-allowed rounded-lg px-3 py-2 text-left text-marine-navy/40"
                    disabled
                  >
                    {item.label}
                  </button>
                );
              }

              if (!item.href) {
                return null;
              }

              return isActive ? (
                <div
                  key={item.label}
                  className="rounded-lg bg-marine-navy px-3 py-2 font-medium text-white shadow"
                >
                  {item.label}
                </div>
              ) : (
                <Link
                  key={item.label}
                  className="block rounded-lg px-3 py-2 text-marine-navy/80 hover:bg-marine-mist"
                  href={item.href}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>

        <section className="flex-1 space-y-6">
          <header className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
            <h1 className="text-2xl font-semibold text-marine-navy">{title}</h1>
            {description ? (
              <p className="mt-2 text-sm text-marine-navy/70">{description}</p>
            ) : null}
          </header>
          {children}
        </section>
      </div>
    </div>
  );
}
