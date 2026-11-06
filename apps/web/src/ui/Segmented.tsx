import { useId } from 'react';

/** A radio group drawn as joined buttons (7 days / 30 days). Native radios keep the keyboard path. */
export function Segmented<T extends string | number>({
  legend,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  legend: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Extra class, e.g. `segmented-stack` (options stacked on a phone, for long labels). */
  className?: string;
}) {
  const name = useId();
  return (
    <fieldset className={className ? `segmented ${className}` : 'segmented'} disabled={disabled}>
      <legend className="field-label">{legend}</legend>
      <div className="segmented-options">
        {options.map((o) => (
          <label key={String(o.value)} className="segmented-option">
            <input
              type="radio"
              name={name}
              value={String(o.value)}
              checked={o.value === value}
              onChange={() => onChange(o.value)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
