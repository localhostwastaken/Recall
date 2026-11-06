import { CircleX } from 'lucide-react';
import { useId, useRef, useState } from 'react';

/**
 * A labelled region that takes a dropped file, plus a "Choose file" button as the keyboard
 * path. States: idle, drag-over (dashed focus border), reading, invalid file (`error`).
 * `onFile` may be async; the zone shows "Reading…" until it settles.
 */
export function DropZone({
  title,
  hint,
  inputLabel,
  onFile,
  accept,
  error,
  compact = false,
}: {
  title: string;
  hint: string;
  /** The accessible name of the file input (what a script or screen reader selects). */
  inputLabel: string;
  onFile: (file: File) => void | Promise<void>;
  accept?: string;
  error?: string;
  compact?: boolean;
}) {
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const hintId = useId();
  const errorId = useId();

  const take = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setReading(true);
    try {
      await onFile(file);
    } finally {
      setReading(false);
    }
  };

  return (
    <div
      className={`dropzone${over ? ' dropzone-over' : ''}${compact ? ' dropzone-compact' : ''}`}
      role="group"
      aria-labelledby={titleId}
      aria-describedby={error ? `${hintId} ${errorId}` : hintId}
      data-over={over ? 'true' : undefined}
      onDragEnter={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void take(e.dataTransfer.files);
      }}
    >
      <div className="dropzone-text">
        <p className="dropzone-title" id={titleId}>
          {title}
        </p>
        <p className="dropzone-hint muted" id={hintId}>
          {hint}
        </p>
      </div>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={reading}
        aria-busy={reading || undefined}
        onClick={() => input.current?.click()}
      >
        {reading ? 'Reading…' : 'Choose file'}
      </button>
      <input
        ref={input}
        type="file"
        className="visually-hidden"
        tabIndex={-1}
        aria-label={inputLabel}
        accept={accept}
        onChange={(e) => {
          const files = e.target.files;
          void take(files).then(() => {
            // Picking the same file again must still fire a change event.
            if (input.current) input.current.value = '';
          });
        }}
      />
      {error ? (
        <p className="field-error dropzone-error" id={errorId} role="alert">
          <CircleX size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
