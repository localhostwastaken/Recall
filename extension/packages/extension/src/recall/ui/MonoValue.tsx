/** Middle-truncated mono value (0x12ab…9f3c); the full value is in title and aria-label. */
export function middle(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function MonoValue({ value }: { value: string }) {
  return (
    <span className="mono mono-value" title={value} aria-label={value}>
      {middle(value)}
    </span>
  );
}
