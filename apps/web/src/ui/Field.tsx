import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { CircleX } from 'lucide-react';

/**
 * Visible label, helper text and the error below the field, wired with aria-describedby.
 * Validation is the caller's job (on blur); pass `error` to show it.
 */
export function Field({
  label,
  helper,
  error,
  className,
  ...input
}: {
  label: string;
  helper?: ReactNode;
  error?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'aria-describedby' | 'aria-invalid'>) {
  const id = useId();
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;
  const describedBy = [helper ? helperId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        {...input}
        id={id}
        className={`input${className ? ` ${className}` : ''}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      {helper ? (
        <p className="field-helper" id={helperId}>
          {helper}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={errorId}>
          <CircleX size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
