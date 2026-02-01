'use client';

import { memo, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  isLoading?: boolean; // Alias for loading
  icon?: ReactNode;
  children: ReactNode;
}

const variantStyles = {
  primary:
    'bg-marine-navy text-white hover:bg-marine-navy/90 active:bg-marine-navy/80 shadow-sm',
  secondary:
    'bg-marine-mist text-marine-navy hover:bg-marine-navy/10 active:bg-marine-navy/15 border border-marine-navy/10',
  danger:
    'bg-trade-down text-white hover:bg-trade-down/90 active:bg-trade-down/80 shadow-sm',
  ghost:
    'bg-transparent text-marine-navy hover:bg-marine-mist active:bg-marine-navy/10',
};

const sizeStyles = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2',
};

function ButtonComponent({
  variant = 'primary',
  size = 'md',
  loading = false,
  isLoading = false,
  icon,
  children,
  disabled,
  className = '',
  ...rest
}: ButtonProps) {
  const isLoadingState = loading || isLoading;
  const isDisabled = disabled || isLoadingState;

  return (
    <button
      {...rest}
      disabled={isDisabled}
      className={`
        inline-flex items-center justify-center rounded-lg font-medium
        transition-all duration-150
        ${variantStyles[variant]}
        ${sizeStyles[size]}
        ${isDisabled ? 'cursor-not-allowed opacity-50' : 'active:scale-[0.98]'}
        ${className}
      `}
    >
      {isLoadingState ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : icon ? (
        <span className="flex items-center justify-center">{icon}</span>
      ) : null}
      {children}
    </button>
  );
}

export const Button = memo(ButtonComponent);
