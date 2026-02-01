'use client';

import { memo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home,
  BarChart3,
  Settings,
  LineChart,
  Shield,
  FileText,
  Menu,
  X,
  MessageSquare,
  MoreHorizontal,
} from 'lucide-react';

interface SidebarProps {
  collapsed?: boolean;
  onToggle?: () => void;
}

const NAV_ITEMS = [
  { label: 'Overview', href: '/', icon: Home },
  { label: 'Trades', href: '/trades', icon: BarChart3 },
  { label: 'Logs', href: '/logs', icon: FileText },
  { label: 'Settings', href: '/settings', icon: Settings },
  { label: 'Telegram', href: '/telegram', icon: MessageSquare },
  { label: 'Analytics', href: '/analytics', icon: LineChart },
  { label: 'Admin', href: '/admin', icon: Shield },
];

const MOBILE_NAV_ITEMS = NAV_ITEMS.slice(0, 4);

function SidebarComponent({ collapsed: controlledCollapsed, onToggle }: SidebarProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(true);
  const pathname = usePathname();

  const collapsed = controlledCollapsed ?? internalCollapsed;
  const toggleCollapsed = onToggle ?? (() => setInternalCollapsed(!internalCollapsed));

  return (
    <>
      {/* Desktop Sidebar */}
      <aside
        className={`
          hidden lg:flex flex-col fixed left-0 top-0 h-screen z-40
          bg-white border-r border-marine-navy/10 shadow-sm
          transition-all duration-300 ease-in-out
          ${collapsed ? 'w-16' : 'w-64'}
        `}
        onMouseEnter={() => !controlledCollapsed && setInternalCollapsed(false)}
        onMouseLeave={() => !controlledCollapsed && setInternalCollapsed(true)}
      >
        {/* Logo */}
        <div className="flex h-16 items-center justify-between border-b border-marine-navy/10 px-4">
          {!collapsed && (
            <div className="flex items-center gap-2 animate-fade-in">
              <img src="/icon.png" alt="Logo" className="h-8 w-8 rounded-lg" />
              <div>
                <p className="text-xs font-bold text-marine-navy">Marine Trader</p>
                <p className="text-[9px] text-marine-navy/50">Command Center</p>
              </div>
            </div>
          )}
          <button
            onClick={toggleCollapsed}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-marine-navy/60 hover:bg-marine-mist hover:text-marine-navy"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <Menu className="h-4 w-4" /> : <X className="h-4 w-4" />}
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 p-2">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`
                  flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium
                  transition-all duration-150
                  ${isActive
                    ? 'bg-marine-navy text-white shadow-sm'
                    : 'text-marine-navy/70 hover:bg-marine-mist hover:text-marine-navy'
                  }
                `}
                title={collapsed ? item.label : undefined}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && (
                  <span className="animate-fade-in">{item.label}</span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        {!collapsed && (
          <div className="border-t border-marine-navy/10 p-3 animate-fade-in">
            <div className="flex items-center gap-2 rounded-lg bg-marine-mist/50 px-3 py-2">
              <div className="h-2 w-2 rounded-full bg-trade-up animate-pulse-slow" />
              <span className="text-[10px] font-medium text-marine-navy/60">System Online</span>
            </div>
          </div>
        )}
      </aside>

      {/* Mobile Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 flex h-16 items-center justify-around border-t border-marine-navy/10 bg-white/95 backdrop-blur-sm lg:hidden">
        {MOBILE_NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`
                flex flex-col items-center gap-1 px-4 py-2 rounded-lg
                transition-colors duration-150
                ${isActive
                  ? 'text-marine-accent'
                  : 'text-marine-navy/50 hover:text-marine-navy'
                }
              `}
            >
              <Icon className="h-5 w-5" />
              <span className="text-[9px] font-medium">{item.label}</span>
              {isActive && (
                <div className="absolute top-0 h-0.5 w-8 rounded-full bg-marine-accent" />
              )}
            </Link>
          );
        })}
        
        {/* More menu */}
        <Link
          href="/logs"
          className="flex flex-col items-center gap-1 px-4 py-2 rounded-lg text-marine-navy/50 hover:text-marine-navy"
        >
          <MoreHorizontal className="h-5 w-5" />
          <span className="text-[9px] font-medium">More</span>
        </Link>
      </nav>
    </>
  );
}

export const Sidebar = memo(SidebarComponent);
