'use client';

import { memo } from 'react';
import { AlertCircle, CheckCircle, AlertTriangle, Info } from 'lucide-react';

export interface ActivityItem {
  id: string;
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  metadata?: Record<string, unknown>;
}

interface ActivityFeedProps {
  items: ActivityItem[];
  maxItems?: number;
  emptyMessage?: string;
}

const typeConfig = {
  info: {
    icon: Info,
    color: 'text-marine-accent',
    bg: 'bg-marine-accent/10',
    line: 'bg-marine-accent/30',
  },
  success: {
    icon: CheckCircle,
    color: 'text-trade-up',
    bg: 'bg-trade-up/10',
    line: 'bg-trade-up/30',
  },
  warning: {
    icon: AlertTriangle,
    color: 'text-amber-500',
    bg: 'bg-amber-500/10',
    line: 'bg-amber-500/30',
  },
  error: {
    icon: AlertCircle,
    color: 'text-trade-down',
    bg: 'bg-trade-down/10',
    line: 'bg-trade-down/30',
  },
};

function ActivityFeedComponent({
  items,
  maxItems = 10,
  emptyMessage = 'No recent activity',
}: ActivityFeedProps) {
  const displayItems = items.slice(0, maxItems);

  if (displayItems.length === 0) {
    return (
      <div className="rounded-xl border border-marine-navy/10 bg-white p-6 shadow-sm">
        <p className="text-center text-sm text-marine-navy/40">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-marine-navy/10 bg-white shadow-sm">
      <div className="max-h-[260px] overflow-auto p-2 sm:p-4">
        <div className="relative">
          {/* Timeline line removed as requested */}

          <div className="space-y-0.5">
            {displayItems.map((item, idx) => {
              const config = typeConfig[item.type];
              const Icon = config.icon;

              return (
                <div
                  key={item.id}
                  className={`
                    group relative flex items-start gap-2 rounded-md p-1.5 
                    transition-colors duration-150 hover:bg-marine-mist/50
                    ${idx === 0 ? 'animate-fade-in' : ''}
                  `}
                >
                  {/* Icon dot */}
                  <div
                    className={`
                      relative z-10 flex h-5 w-5 shrink-0 items-center justify-center 
                      rounded-full ${config.bg}
                    `}
                  >
                    <Icon className={`h-2.5 w-2.5 ${config.color}`} />
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1 pt-0.5">
                    <p className="text-xs text-marine-navy/80 leading-tight line-clamp-2 break-words">{item.message}</p>
                    <p className="mt-0.5 text-[9px] text-marine-navy/40">{item.timestamp}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {items.length > maxItems && (
        <div className="border-t border-marine-navy/10 px-2 py-1">
          <p className="text-center text-[10px] text-marine-navy/40">
            +{items.length - maxItems} more items
          </p>
        </div>
      )}
    </div>
  );
}

export const ActivityFeed = memo(ActivityFeedComponent);
