'use client';

import { memo, type ReactNode, type ChangeEvent } from 'react';

type FormFieldType = 'text' | 'number' | 'select' | 'toggle';

interface BaseFormFieldProps {
  label: string;
  error?: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
}

interface TextFieldProps extends BaseFormFieldProps {
  type: 'text';
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

interface NumberFieldProps extends BaseFormFieldProps {
  type: 'number';
  value: number | string;
  onChange: (value: number) => void;
  placeholder?: string;
  step?: number;
}

interface SelectFieldProps extends BaseFormFieldProps {
  type: 'select';
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}

interface ToggleFieldProps {
  type: 'toggle';
  value?: boolean;
  checked?: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  error?: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
}

type FormFieldProps = TextFieldProps | NumberFieldProps | SelectFieldProps | ToggleFieldProps;

function FormFieldComponent(props: FormFieldProps) {
  const { label, error, hint, disabled = false, className = '' } = props;

  const renderInput = () => {
    if (props.type === 'toggle') {
      // Support both value and checked for toggle
      const isChecked = props.value ?? props.checked ?? false;
      return (
        <button
          type="button"
          role="switch"
          aria-checked={isChecked}
          onClick={() => props.onChange(!isChecked)}
          disabled={disabled}
          className={`
            relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200
            ${isChecked ? 'bg-marine-accent' : 'bg-marine-navy/20'}
            ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}
          `}
        >
          <span
            className={`
              absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm
              transition-transform duration-200
              ${isChecked ? 'translate-x-5' : 'translate-x-0'}
            `}
          />
        </button>
      );
    }

    if (props.type === 'select') {
      return (
        <select
          value={props.value}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => props.onChange(e.target.value)}
          disabled={disabled}
          className={`
            w-full rounded-lg border bg-white px-3 py-2 text-sm text-marine-navy
            transition-colors duration-150
            ${error ? 'border-trade-down' : 'border-marine-navy/20'}
            ${disabled ? 'cursor-not-allowed opacity-50' : 'hover:border-marine-accent/50 focus:border-marine-accent focus:outline-none focus:ring-2 focus:ring-marine-accent/20'}
          `}
        >
          {props.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );
    }

    if (props.type === 'number') {
      return (
        <input
          type="number"
          value={props.value}
          onChange={(e: ChangeEvent<HTMLInputElement>) => props.onChange(parseFloat(e.target.value) || 0)}
          placeholder={props.placeholder}
          step={props.step}
          disabled={disabled}
          className={`
            w-full rounded-lg border bg-white px-3 py-2 text-sm text-marine-navy
            transition-colors duration-150
            ${error ? 'border-trade-down' : 'border-marine-navy/20'}
            ${disabled ? 'cursor-not-allowed opacity-50' : 'hover:border-marine-accent/50 focus:border-marine-accent focus:outline-none focus:ring-2 focus:ring-marine-accent/20'}
          `}
        />
      );
    }

    // text type
    return (
      <input
        type="text"
        value={props.value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        disabled={disabled}
        className={`
          w-full rounded-lg border bg-white px-3 py-2 text-sm text-marine-navy
          transition-colors duration-150
          ${error ? 'border-trade-down' : 'border-marine-navy/20'}
          ${disabled ? 'cursor-not-allowed opacity-50' : 'hover:border-marine-accent/50 focus:border-marine-accent focus:outline-none focus:ring-2 focus:ring-marine-accent/20'}
        `}
      />
    );
  };

  return (
    <div className={`space-y-1.5 ${className}`}>
      <div
        className={`
        flex items-center justify-between
        ${props.type === 'toggle' ? 'flex-row' : 'flex-col items-start'}
      `}
      >
        <label className="text-xs font-medium text-marine-navy/60">{label}</label>
        {renderInput()}
      </div>

      {hint && !error && <p className="text-[10px] text-marine-navy/40">{hint}</p>}
      {error && <p className="text-[10px] text-trade-down">{error}</p>}
    </div>
  );
}

export const FormField = memo(FormFieldComponent);
