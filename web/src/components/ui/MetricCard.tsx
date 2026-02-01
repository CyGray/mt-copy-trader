'use client';

import { type ReactNode, memo } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface MetricCardProps {
  label: string;
  value: string | number;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
  icon?: ReactNode;
  className?: string;
}

function MetricCardComponent({
  label,
  value,
  trend,
  trendValue,
  icon,
  className = '',
}: MetricCardProps) {
  const TrendIcon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus;
  const trendColor =
    trend === 'up'
      ? 'text-trade-up'
      : trend === 'down'
        ? 'text-trade-down'
        : 'text-trade-neutral';

  return (
    <div
      className={`
        group relative overflow-hidden rounded-lg border border-marine-navy/10 
        bg-white p-2 sm:p-3 shadow-sm transition-all duration-200
        hover:border-marine-accent/30 hover:shadow-md
        ${className}
      `}
    >
      {/* Subtle gradient overlay on hover */}
      <div className="absolute inset-0 bg-gradient-to-br from-marine-accent/0 to-marine-accent/5 opacity-0 transition-opacity duration-200 group-hover:opacity-100" />

      <div className="relative z-10">
        <div className="flex items-center justify-between">
          <p className="text-[9px] font-medium uppercase tracking-wider text-marine-navy/50">
            {label}
          </p>
          {icon && (
            <div className="text-marine-navy/30 transition-colors group-hover:text-marine-accent/60">
              {icon}
            </div>
          )}
        </div>

        <div className="mt-1 flex items-baseline gap-1">
          <p className="text-lg font-bold tracking-tight text-marine-navy">{value}</p>
          {trend && trendValue && (
            <div className={`flex items-center gap-0.5 text-xs font-medium ${trendColor}`}>
              <TrendIcon className="h-3 w-3" />
              <span>{trendValue}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const MetricCard = memo(MetricCardComponent);
