import { useEffect, useState } from 'react';
import { StatusBadge } from '../../recall/ui/StatusBadge';
import { WitnessChip, type WitnessState } from '../../recall/ui/WitnessChip';
import { loadSettings } from '../../recall/settings';
import { witnessOnline } from '../../recall/witness';

/** The page the popup acts on. `?tab=<id>` picks a tab explicitly (used by tests). */
async function resolveTab(): Promise<chrome.tabs.Tab | undefined> {
  const param = new URLSearchParams(location.search).get('tab');
  if (param !== null && /^\d+$/.test(param)) {
    return chrome.tabs.get(Number(param)).catch(() => undefined);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

type PageInfo = { url: string; host: string; https: boolean };

function pageInfo(rawUrl: string | undefined): PageInfo | null {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    return { url: rawUrl, host: u.host || u.protocol.replace(/:$/, ''), https: u.protocol === 'https:' };
  } catch {
    return { url: rawUrl, host: rawUrl, https: false };
  }
}

export type PopupProps = {
  /** Starts a capture of the current page. Wired by the capture flow (Task 9). */
  onCapture?: (url: string) => void;
};

export function Popup({ onCapture }: PopupProps) {
  const [page, setPage] = useState<PageInfo | null | undefined>(undefined);
  const [witness, setWitness] = useState<WitnessState>('checking');

  useEffect(() => {
    resolveTab()
      .then((tab) => setPage(pageInfo(tab?.url)))
      .catch(() => setPage(null));
    loadSettings()
      .then((s) => witnessOnline(s.witnessUrl))
      .then((ok) => setWitness(ok ? 'online' : 'offline'))
      .catch(() => setWitness('offline'));
  }, []);

  const canCapture = Boolean(page?.https && onCapture);
  const helper =
    page && !page.https
      ? 'Only https:// pages can be captured.'
      : 'Takes about 30 s and ~30 MB of data. Pages up to 64 KB.';

  return (
    <div className="popup">
      <header className="popup-header">
        <h1 className="popup-title">Recall</h1>
        <WitnessChip state={witness} />
      </header>

      <main className="popup-body">
        <section aria-labelledby="this-page">
          <h2 id="this-page" className="section-label">
            This page
          </h2>
          {page === undefined ? (
            <p className="muted">Reading the current tab…</p>
          ) : page === null ? (
            <p className="muted">No page to capture in this tab.</p>
          ) : (
            <>
              <p className="page-host">{page.host}</p>
              <p className="page-url mono" title={page.url}>
                {page.url}
              </p>
            </>
          )}
        </section>

        <hr className="rule" />

        {/* Task 9 replaces this block with progress and errors; Task 13 loads the captures. */}
        <section aria-labelledby="earlier-captures">
          <h2 id="earlier-captures" className="section-label">
            Earlier captures
          </h2>
          <StatusBadge status="unavailable" />
        </section>
      </main>

      <footer className="popup-footer">
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={!canCapture}
          aria-describedby="capture-helper"
          onClick={() => page && onCapture?.(page.url)}
        >
          Capture this page
        </button>
        <p id="capture-helper" className="popup-helper muted">
          {helper}
        </p>
      </footer>
    </div>
  );
}
