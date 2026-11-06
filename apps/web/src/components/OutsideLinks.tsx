import { ExternalLink } from 'lucide-react';
import { useId } from 'react';
import type { OutsideLinkSpec } from '../explorers';
import './outsideLinks.css';

/**
 * A quiet text link to an outside tool (an explorer, a gateway). It opens a new tab and says so.
 * `after`: it follows a value on the same line, so it keeps some room from it.
 */
export function OutsideLink({ href, after = false, children }: { href: string; after?: boolean; children: string }) {
  return (
    <a className={after ? 'outside-link outside-link-after' : 'outside-link'} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

/** The links as one wrapping list (8 px or more apart), or nothing when there are none. */
export function OutsideLinkList({ links, labelledBy }: { links: OutsideLinkSpec[]; labelledBy?: string }) {
  if (links.length === 0) return null;
  return (
    <ul className="outside-links" {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}>
      {links.map((l) => (
        <li key={l.href}>
          <OutsideLink href={l.href}>{l.label}</OutsideLink>
        </li>
      ))}
    </ul>
  );
}

/** "Check it yourself": the same record in the outside tools' own pages. Nothing when there are none. */
export function CheckItYourself({ links }: { links: OutsideLinkSpec[] }) {
  const id = useId();
  if (links.length === 0) return null;
  return (
    <div className="check-yourself">
      <span className="check-yourself-label" id={id}>
        Check it yourself
      </span>
      <OutsideLinkList links={links} labelledBy={id} />
    </div>
  );
}
