'use client';

import { memo } from 'react';

interface StatusBadgeProps {
  status: 'success' | 'warning' | 'danger' | 'neutral' | 'info';
  label: string;
  pulse?: boolean;
  size?: 'sm' | 'md';
}

const statusConfig = {
  success: {
    bg: 'bg-trade-up/10',
    text: 'text-trade-up',
    dot: 'bg-trade-up',
  },
  warning: {
    bg: 'bg-amber-500/10',
    text: 'text-amber-600',
    dot: 'bg-amber-500',
  },
  danger: {
    bg: 'bg-trade-down/10',
    text: 'text-trade-down',
    dot: 'bg-trade-down',
  },
  neutral: {
    bg: 'bg-trade-neutral/10',
    text: 'text-trade-neutral',
    dot: 'bg-trade-neutral',
  },
  info: {
    bg: 'bg-marine-accent/10',
    text: 'text-marine-accent',
    dot: 'bg-marine-accent',
  },
};

function StatusBadgeComponent({ status, label, pulse = false, size = 'sm' }: StatusBadgeProps) {
  const config = statusConfig[status];
  const sizeClasses = size === 'sm' ? 'h-6 px-2 text-[10px]' : 'h-8 px-3 text-xs';
  const dotSize = size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2';

  return (
    <span
      className={`
        inline-flex items-center gap-1.5 rounded-full font-medium
        ${config.bg} ${config.text} ${sizeClasses}
      `}
    >
      <span
        className={`
          ${dotSize} rounded-full ${config.dot}
          ${pulse ? 'animate-pulse-slow' : ''}
        `}
      />
      {label}
    </span>
  );
}

export const StatusBadge = memo(StatusBadgeComponent);
