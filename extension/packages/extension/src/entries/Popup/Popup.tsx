import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { StatusBadge } from '../../recall/ui/StatusBadge';
import { WitnessChip, type WitnessState } from '../../recall/ui/WitnessChip';
import { Notice } from '../../recall/ui/Notice';
import { Steps, type StepState } from '../../recall/ui/Steps';
import { CheckRow } from '../../recall/ui/CheckRow';
import { loadSettings } from '../../recall/settings';
import { witnessOnline } from '../../recall/witness';
import { CAPTURE_STATE_KEY, STALE_AFTER_MS, type CaptureState } from '../../recall/jobState';
import type { PopupRequest } from '../../recall/messages';
import {
  CAPTURE_STEPS,
  checkLines,
  errorCopy,
  formatElapsed,
  verdict,
} from '../../recall/captureView';

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
    return {
      url: rawUrl,
      host: u.host || u.protocol.replace(/:$/, ''),
      https: u.protocol === 'https:',
    };
  } catch {
    return { url: rawUrl, host: rawUrl, https: false };
  }
}

const sameUrl = (a: string, b: string) => a.replace(/#.*$/, '') === b.replace(/#.*$/, '');

function send(msg: PopupRequest): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

/** The capture job state from chrome.storage.session, kept live. */
function useCaptureState(): CaptureState | undefined {
  const [state, setState] = useState<CaptureState | undefined>(undefined);
  useEffect(() => {
    chrome.storage.session
      .get(CAPTURE_STATE_KEY)
      .then((r) => setState(r[CAPTURE_STATE_KEY] as CaptureState | undefined))
      .catch(() => undefined);
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (CAPTURE_STATE_KEY in changes)
        setState(changes[CAPTURE_STATE_KEY].newValue as CaptureState | undefined);
    };
    chrome.storage.session.onChanged.addListener(onChanged);
    return () => chrome.storage.session.onChanged.removeListener(onChanged);
  }, []);
  return state;
}

/** Re-renders every second while `on`, for the elapsed-time text. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export function Popup() {
  const [page, setPage] = useState<PageInfo | null | undefined>(undefined);
  const [witness, setWitness] = useState<WitnessState>('checking');
  const [copied, setCopied] = useState(false);
  const job = useCaptureState();

  const probeWitness = useCallback(() => {
    loadSettings()
      .then((s) => witnessOnline(s.witnessUrl))
      .then((ok) => setWitness(ok ? 'online' : 'offline'))
      .catch(() => setWitness('offline'));
  }, []);
  const checkWitness = useCallback(() => {
    setWitness('checking');
    probeWitness();
  }, [probeWitness]);

  useEffect(() => {
    resolveTab()
      .then((tab) => setPage(pageInfo(tab?.url)))
      .catch(() => setPage(null));
    probeWitness();
  }, [probeWitness]);

  const now = useNow(job?.status === 'running');
  const running =
    job?.status === 'running' && now - job.startedAt < STALE_AFTER_MS ? job : undefined;
  // This popup shows the job of its own page; another page's running job only blocks the button.
  const mine = job && page && sameUrl(job.url, page.url) ? job : undefined;

  const capture = useCallback(() => {
    if (!page) return;
    setCopied(false);
    void send({ type: 'recall.startCapture', url: page.url });
  }, [page]);
  const retry = useCallback(() => {
    checkWitness();
    capture();
  }, [capture, checkWitness]);
  const dismiss = useCallback(() => void send({ type: 'recall.dismissCapture' }), []);
  const cancel = useCallback(() => void send({ type: 'recall.cancelCapture' }), []);
  const openSettings = useCallback(() => void chrome.runtime.openOptionsPage(), []);

  let disabledReason: string | null = null;
  if (running) disabledReason = mine ? null : 'Another capture is running. Wait for it to finish.';
  else if (page === undefined) disabledReason = 'Reading the current tab…';
  else if (page === null || !page.https) disabledReason = 'Only https:// pages can be captured.';
  else if (witness === 'checking') disabledReason = 'Checking the witness…';
  else if (witness === 'offline')
    disabledReason = 'The witness is offline, so new captures are paused.';
  const busy = Boolean(running && mine);
  const helper = disabledReason ?? 'Takes about 30 s and ~30 MB of data. Pages up to 64 KB.';

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

        {mine?.status === 'running' && running ? (
          <section aria-labelledby="capture-progress">
            <h2 id="capture-progress" className="section-label">
              Capture progress
            </h2>
            <Steps
              steps={CAPTURE_STEPS.map((label, i) => ({
                label,
                state: (i + 1 < mine.step
                  ? 'done'
                  : i + 1 === mine.step
                    ? 'active'
                    : 'waiting') as StepState,
              }))}
            />
            <progress className="progress" aria-label="Capture progress" />
            <p className="progress-text">
              {formatElapsed(now - mine.startedAt)} elapsed · usually 15–30 s
            </p>
            <div className="popup-actions">
              <button type="button" className="btn btn-secondary" onClick={cancel}>
                Cancel capture
              </button>
            </div>
            <p className="popup-note muted">You can close this popup. The capture keeps running.</p>
          </section>
        ) : mine?.status === 'done' ? (
          <CaptureResult job={mine} openSettings={openSettings} />
        ) : mine && mine.status !== 'running' ? (
          <section aria-labelledby="capture-result">
            <h2 id="capture-result" className="section-label">
              Capture result
            </h2>
            <CaptureError
              job={mine}
              host={page?.host ?? ''}
              copied={copied}
              onOk={dismiss}
              onRetry={retry}
              onSettings={openSettings}
              onCopy={() => {
                void navigator.clipboard
                  .writeText(
                    JSON.stringify({
                      url: mine.url,
                      ...('error' in mine ? { error: mine.error, code: mine.code } : {}),
                    }),
                  )
                  .then(() => setCopied(true));
              }}
            />
          </section>
        ) : witness === 'offline' ? (
          <section aria-labelledby="capture-result">
            <h2 id="capture-result" className="section-label">
              Witness
            </h2>
            <Notice
              kind="error"
              title="Witness offline"
              actions={
                <>
                  <button type="button" className="btn btn-secondary" onClick={checkWitness}>
                    Try again
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={openSettings}>
                    Witness settings
                  </button>
                </>
              }
            >
              New captures are paused until the witness is back. Existing captures can still be
              verified by anyone.
            </Notice>
          </section>
        ) : (
          // Task 13 loads the earlier captures from Arkiv.
          <section aria-labelledby="earlier-captures">
            <h2 id="earlier-captures" className="section-label">
              Earlier captures
            </h2>
            <StatusBadge status="unavailable" />
          </section>
        )}
      </main>

      <footer className="popup-footer">
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={busy || disabledReason !== null}
          aria-busy={busy}
          aria-describedby="capture-helper"
          onClick={capture}
        >
          {busy ? (
            <>
              <LoaderCircle size={16} strokeWidth={1.75} aria-hidden="true" className="spin" />
              Capturing…
            </>
          ) : (
            'Capture this page'
          )}
        </button>
        <p id="capture-helper" className="popup-helper muted">
          {helper}
        </p>
      </footer>
    </div>
  );
}

function CaptureResult({
  job,
  openSettings,
}: {
  job: Extract<CaptureState, { status: 'done' }>;
  openSettings: () => void;
}) {
  const lines = checkLines(job.checks, job.evidence);
  const v = verdict(lines, job.checks);
  return (
    <section aria-labelledby="capture-result">
      <h2 id="capture-result" className="section-label">
        Capture result
      </h2>
      <Notice
        kind={v.kind}
        title={v.title}
        focus
        actions={
          v.witnessSettings ? (
            <button type="button" className="btn btn-ghost" onClick={openSettings}>
              Witness settings
            </button>
          ) : undefined
        }
      >
        {v.body}
      </Notice>
      <ul className="checks" aria-label="Checks">
        {lines.map((l) => (
          <CheckRow
            key={l.letter}
            letter={l.letter}
            title={l.title}
            status={l.status}
            result={l.result}
            how={l.how.map((h) => (
              <span key={h} className="mono">
                {h}
              </span>
            ))}
          />
        ))}
      </ul>
    </section>
  );
}

function CaptureError({
  job,
  host,
  copied,
  onOk,
  onRetry,
  onSettings,
  onCopy,
}: {
  job: Exclude<CaptureState, { status: 'running' } | { status: 'done' }>;
  host: string;
  copied: boolean;
  onOk: () => void;
  onRetry: () => void;
  onSettings: () => void;
  onCopy: () => void;
}) {
  const copy =
    job.status === 'cancelled'
      ? errorCopy('cancelled', '', host)
      : errorCopy(job.code, job.error, host, job.size);
  const buttons = {
    ok: (
      <button key="ok" type="button" className="btn btn-secondary" onClick={onOk}>
        OK
      </button>
    ),
    retry: (
      <button key="retry" type="button" className="btn btn-secondary" onClick={onRetry}>
        Try again
      </button>
    ),
    witnessSettings: (
      <button key="settings" type="button" className="btn btn-ghost" onClick={onSettings}>
        Witness settings
      </button>
    ),
    copy: (
      <button key="copy" type="button" className="btn btn-ghost" onClick={onCopy}>
        {copied ? 'Copied' : 'Copy details'}
      </button>
    ),
  };
  return (
    <Notice
      kind={copy.kind}
      title={copy.title}
      focus
      actions={copy.actions.length ? copy.actions.map((a) => buttons[a]) : undefined}
    >
      {copy.body}
    </Notice>
  );
}
