/** A raw error text, kept behind a small "Details" disclosure so it is there to read or copy. */
export function TechDetails({ text }: { text: string }) {
  return (
    <details className="tech-details">
      <summary>Details</summary>
      <p className="mono">{text}</p>
    </details>
  );
}
