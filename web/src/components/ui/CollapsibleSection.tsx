'use client';

import { memo, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

interface CollapsibleSectionProps {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  badge?: ReactNode;
  icon?: ReactNode;
}

function CollapsibleSectionComponent({
  title,
  children,
  defaultOpen = false,
  badge,
  icon,
}: CollapsibleSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultOpen);

  return (
    <div className="overflow-hidden rounded-xl border border-marine-navy/10 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-marine-mist/50"
        aria-expanded={isExpanded}
      >
        <div className="flex items-center gap-2">
          {icon && <span className="text-marine-navy/60">{icon}</span>}
          <h3 className="text-sm font-semibold text-marine-navy">{title}</h3>
          {badge}
        </div>
        <ChevronDown
          className={`
            h-4 w-4 text-marine-navy/40 transition-transform duration-300
            ${isExpanded ? 'rotate-180' : ''}
          `}
        />
      </button>

      <div
        className={`
          grid transition-all duration-300 ease-in-out
          ${isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}
        `}
      >
        <div className="overflow-hidden">
          <div className="border-t border-marine-navy/10 p-4">{children}</div>
        </div>
      </div>
    </div>
  );
}

export const CollapsibleSection = memo(CollapsibleSectionComponent);
