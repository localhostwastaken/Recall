import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import './popupExtras.css';

/**
 * The one disclosure for technical facts (hashes, addresses, raw reasons): a native
 * <details>, closed by default, so Enter/Space on the summary and screen readers work
 * without any script. `summary` defaults to "Details"; extra classes keep older hooks.
 */
export function Details({
  summary = 'Details',
  className,
  children,
}: {
  summary?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <details className={className ? `rc-details ${className}` : 'rc-details'}>
      <summary className="rc-details-summary">
        {summary}
        <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" className="rc-details-chevron" />
      </summary>
      <div className="rc-details-body">{children}</div>
    </details>
  );
}
