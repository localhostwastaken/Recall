import { ExternalLink } from 'lucide-react';
import './tryit.css';

// "Try it in 2 minutes": the four steps from nothing to a saved, verifiable capture, plus a
// link to a real capture that already exists, so a visitor can see the result first.

export const RELEASE_URL = 'https://github.com/localhostwastaken/Recall/releases/tag/v0.1.0-mumbai';
export const METAMASK_URL = 'https://metamask.io/download/';
export const EXAMPLE_REPO_URL = 'https://github.com/permissionlesstech/bitchat';
/** A live capture on Arkiv Rabdi (docs/evidence-log.md, "P2 live capture"). */
export const EXAMPLE_CAPTURE_KEY = '0xc50021a907dbd1d511d2e4a1482614647cbbb4a0dd2d4bf26ad70065b3611244';
export const EXAMPLE_CAPTURE_HREF = `#/c/${EXAMPLE_CAPTURE_KEY}`;

/** A link that opens in a new tab and says so. */
function Outside({ href, className, children }: { href: string; className?: string; children: string }) {
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

export function TryIt() {
  return (
    <section className="panel tryit" aria-labelledby="tryit-title">
      <div className="tryit-main">
        <h2 className="section-title" id="tryit-title">
          Try it in 2 minutes
        </h2>
        <ol className="tryit-steps">
          <li className="tryit-step">
            <span className="tryit-marker" aria-hidden="true">
              1
            </span>
            <div className="tryit-text">
              <p className="tryit-name">Install the extension</p>
              <p className="muted">Download the zip from the release, unzip it, then Load unpacked on chrome://extensions.</p>
              <Outside className="btn btn-primary btn-compact tryit-action" href={RELEASE_URL}>
                Get the extension
              </Outside>
            </div>
          </li>
          <li className="tryit-step">
            <span className="tryit-marker" aria-hidden="true">
              2
            </span>
            <div className="tryit-text">
              <p className="tryit-name">Install MetaMask</p>
              <p className="muted">You use it once, to save the capture.</p>
              <Outside className="btn btn-secondary btn-compact tryit-action" href={METAMASK_URL}>
                Get MetaMask
              </Outside>
            </div>
          </li>
          <li className="tryit-step">
            <span className="tryit-marker" aria-hidden="true">
              3
            </span>
            <div className="tryit-text">
              <p className="tryit-name">Open a GitHub repo and click Capture</p>
              <p className="muted">
                Try{' '}
                <Outside className="tryit-link" href={EXAMPLE_REPO_URL}>
                  github.com/permissionlesstech/bitchat
                </Outside>
                . The witness watches GitHub answer. It takes about 30 seconds.
              </p>
            </div>
          </li>
          <li className="tryit-step">
            <span className="tryit-marker" aria-hidden="true">
              4
            </span>
            <div className="tryit-text">
              <p className="tryit-name">Save it in the Recall tab</p>
              <p className="muted">MetaMask: buy storage, then publish. Anyone can verify it after.</p>
            </div>
          </li>
        </ol>
      </div>
      <aside className="tryit-example" aria-labelledby="tryit-example-title">
        <h3 className="tryit-example-title" id="tryit-example-title">
          Want to see a result first?
        </h3>
        <p>Open a real capture. Recall checks it in your browser, with nothing to install.</p>
        <a className="btn btn-secondary" href={EXAMPLE_CAPTURE_HREF}>
          Verify an example
        </a>
      </aside>
    </section>
  );
}
