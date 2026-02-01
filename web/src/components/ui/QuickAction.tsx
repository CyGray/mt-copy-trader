'use client';

import { memo, type ReactNode } from 'react';

interface QuickActionProps {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  active?: boolean;
}

const variantStyles = {
  primary: {
    base: 'bg-marine-navy text-white hover:bg-marine-navy/90',
    active: 'bg-marine-accent text-white',
  },
  secondary: {
    base: 'bg-marine-mist text-marine-navy hover:bg-marine-navy/10',
    active: 'bg-marine-accent/10 text-marine-accent',
  },
  danger: {
    base: 'bg-trade-down/10 text-trade-down hover:bg-trade-down/20',
    active: 'bg-trade-down text-white',
  },
};

function QuickActionComponent({
  label,
  icon,
  onClick,
  variant = 'secondary',
  disabled = false,
  active = false,
}: QuickActionProps) {
  const styles = variantStyles[variant];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`
        group flex flex-col items-center gap-1 rounded-lg p-2 sm:p-3
        transition-all duration-150
        ${active ? styles.active : styles.base}
        ${disabled ? 'cursor-not-allowed opacity-50' : 'active:scale-95 hover:scale-105'}
      `}
      aria-pressed={active}
    >
      <div className="flex h-7 w-7 sm:h-10 sm:w-10 items-center justify-center">{icon}</div>
      <span className="text-[9px] font-medium uppercase tracking-wide">{label}</span>
    </button>
  );
}

export const QuickAction = memo(QuickActionComponent);
