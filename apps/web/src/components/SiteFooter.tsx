import { ExternalLink } from 'lucide-react';
import type { Route } from '../router';

const REPO = 'https://github.com/localhostwastaken/Recall';

/** For judges: where to look, one click each. All open in a new tab. */
const JUDGE_LINKS: { label: string; href: string }[] = [
  { label: 'GitHub repo', href: REPO },
  { label: 'Demo video', href: `${REPO}#demo-video` },
  { label: 'Arkiv notes', href: `${REPO}/tree/main/arkiv` },
  { label: 'Run one query yourself', href: `${REPO}#run-one-query` },
];

/** The site footer, on every route: the standing note, the judges' links and the advanced settings. */
export function SiteFooter({ route }: { route: Route }) {
  return (
    <footer className="site-footer">
      <div className="container footer-stack">
        <div className="footer-row">
          <p className="muted">No trackers. Verification runs in your browser. TLSNotary alpha (unaudited) · testnet.</p>
          {/* Everything is preconfigured, so settings live here and not in the main navigation. */}
          <a className="footer-link" href="#/settings" aria-current={route.name === 'settings' ? 'page' : undefined}>
            Advanced settings
          </a>
        </div>
        <div className="footer-judges">
          <span className="footer-label" id="footer-judges-label">
            For judges:
          </span>
          <ul className="footer-links" aria-labelledby="footer-judges-label">
            {JUDGE_LINKS.map((l) => (
              <li key={l.href}>
                <a className="footer-link" href={l.href} target="_blank" rel="noopener noreferrer">
                  {l.label}
                  <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </footer>
  );
}
