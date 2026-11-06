import { ChevronDown } from 'lucide-react';
import './popupExtras.css';

/** A raw error text, kept behind a small "Details" disclosure so it is there to read or copy. */
export function TechDetails({ text }: { text: string }) {
  return (
    <details className="tech-details">
      <summary>
        Details
        <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" className="tech-details-chevron" />
      </summary>
      <p className="mono">{text}</p>
    </details>
  );
}
