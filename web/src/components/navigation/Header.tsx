'use client';

import { memo, type ReactNode } from 'react';
import { Bell, User, ChevronRight } from 'lucide-react';

interface HeaderProps {
  title: string;
  subtitle?: string;
  breadcrumbs?: { label: string; href?: string }[];
  actions?: ReactNode;
}

function HeaderComponent({ title, subtitle, breadcrumbs, actions }: HeaderProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-marine-navy/10 bg-white/95 backdrop-blur-sm">
      <div className="flex h-14 items-center justify-between px-4 lg:px-6">
        <div className="min-w-0 flex-1">
          {/* Breadcrumbs */}
          {breadcrumbs && breadcrumbs.length > 0 && (
            <nav className="mb-0.5 flex items-center gap-1 text-[10px] text-marine-navy/50">
              {breadcrumbs.map((crumb, idx) => (
                <span key={idx} className="flex items-center gap-1">
                  {idx > 0 && <ChevronRight className="h-3 w-3" />}
                  {crumb.href ? (
                    <a href={crumb.href} className="hover:text-marine-navy">
                      {crumb.label}
                    </a>
                  ) : (
                    <span>{crumb.label}</span>
                  )}
                </span>
              ))}
            </nav>
          )}

          {/* Title */}
          <div className="flex items-baseline gap-2">
            <h1 className="truncate text-lg font-semibold text-marine-navy">{title}</h1>
            {subtitle && (
              <span className="hidden text-xs text-marine-navy/50 sm:inline">{subtitle}</span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {actions}
          
          {/* Notifications */}
          <button
            className="relative flex h-9 w-9 items-center justify-center rounded-lg text-marine-navy/60 hover:bg-marine-mist hover:text-marine-navy transition-colors"
            aria-label="Notifications"
          >
            <Bell className="h-4 w-4" />
            <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-trade-down" />
          </button>

          {/* Profile */}
          <button
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-marine-mist text-marine-navy/60 hover:text-marine-navy transition-colors"
            aria-label="Profile"
          >
            <User className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
}

export const Header = memo(HeaderComponent);
