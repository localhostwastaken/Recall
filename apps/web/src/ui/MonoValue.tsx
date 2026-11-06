import { Copy } from 'lucide-react';
import { useToast } from './Toast';

/** Middle-truncated mono value (0x12ab…9f3c); the full value is in title and aria-label. */
export function middle(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Hashes and addresses. `copy` adds a Copy button that confirms with the "Copied" toast. */
export function MonoValue({ value, copy = true }: { value: string; copy?: boolean }) {
  const toast = useToast();
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast('Copied');
    } catch {
      toast('Copy is blocked in this browser. Select the value instead.');
    }
  };
  return (
    <span className="mono-value-wrap">
      <span className="mono mono-value" title={value} aria-label={value}>
        {middle(value)}
      </span>
      {copy ? (
        <button type="button" className="icon-btn" aria-label={`Copy ${value}`} onClick={onCopy}>
          <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}
