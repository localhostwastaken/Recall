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
  reserveError = false,
  className,
  ...input
}: {
  label: string;
  helper?: ReactNode;
  error?: string;
  /**
   * Keeps one line free for the error, so showing or clearing it on blur does not move the
   * controls below. Without it, an error appearing when focus leaves the field (as the person
   * presses the button underneath) shifts the button away and the click is lost.
   */
  reserveError?: boolean;
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
      ) : reserveError ? (
        <div className="field-error-slot" aria-hidden="true" />
      ) : null}
    </div>
  );
}
