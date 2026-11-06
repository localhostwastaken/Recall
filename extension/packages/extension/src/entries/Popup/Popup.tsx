import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Settings as SettingsIcon } from 'lucide-react';
import { StatusBadge } from '../../recall/ui/StatusBadge';
import { WitnessChip, type WitnessState } from '../../recall/ui/WitnessChip';
import { Notice } from '../../recall/ui/Notice';
import { Steps, type StepState } from '../../recall/ui/Steps';
import { CheckRow } from '../../recall/ui/CheckRow';
import { CheckDetails } from '../../recall/ui/CheckDetails';
import { MonoValue } from '../../recall/ui/MonoValue';
import { loadSettings } from '../../recall/settings';
import { focusOrOpenApproveTab } from '../../recall/appTabs';
import { SettingsPanel } from './SettingsPanel';
import { Onboarding } from './Onboarding';
import { parseRepoPage, type RepoTarget } from '../../recall/gitRepo';
import { CAPTURE_STATE_KEY, isLiveRunning, type CaptureState } from '../../recall/jobState';
import type { PopupRequest } from '../../recall/messages';
import {
  CAPTURE_HELPER,
  PAGE_BUTTON,
  REPO_BUTTON,
  approveUrl,
  repoSubline,
  uploadProgressText,
  earlierCopy,
  type EarlierCaptures,
  checkLines,
  errorCopy,
  formatElapsed,
  jobSteps,
  uploadCopy,
  verdict,
  pageBlockedReason,
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

type PageInfo = { url: string; host: string };

function pageInfo(rawUrl: string | undefined): PageInfo | null {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    return {
      url: rawUrl,
      host: u.host || u.protocol.replace(/:$/, ''),
    };
  } catch {
    return { url: rawUrl, host: rawUrl };
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

/** The verified history of the page, from the service worker (undefined while loading). */
function useEarlierCaptures(url: string | undefined): EarlierCaptures | undefined {
  const [state, setState] = useState<{ url: string; value: EarlierCaptures } | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!url) return;
    let live = true;
    send({ type: 'recall.earlierCaptures', url })
      .then((r) => r as EarlierCaptures | undefined)
      .catch((err: unknown) => ({ error: String(err) }))
      .then((value) => {
        if (live) setState({ url, value: value ?? { error: 'no answer' } });
      });
    return () => {
      live = false;
    };
  }, [url]);
  return state && state.url === url ? state.value : undefined;
}

type RepoInfo =
  | { status: 'loading' }
  | { status: 'ok'; target: RepoTarget; captureUrl: string }
  | { status: 'error'; error: string };

/**
 * On a GitHub repository page (R46): the branch a capture would notarize (the default branch is
 * looked up by the service worker) and the API URL it captures. Undefined elsewhere.
 */
function useRepoTarget(url: string | undefined): RepoInfo | undefined {
  const isRepo = url ? parseRepoPage(url) !== null : false;
  const [state, setState] = useState<{ url: string; value: RepoInfo } | undefined>(undefined);
  useEffect(() => {
    if (!url || !isRepo) return;
    let live = true;
    send({ type: 'recall.repoTarget', url })
      .then((r) => r as { target?: RepoTarget; captureUrl?: string; error?: string } | undefined)
      .catch((err: unknown) => ({ error: String(err) }) as { error?: string; target?: undefined; captureUrl?: undefined })
      .then((r) => {
        if (!live) return;
        const value: RepoInfo =
          r?.target && r.captureUrl
            ? { status: 'ok', target: r.target, captureUrl: r.captureUrl }
            : { status: 'error', error: r?.error ?? 'no answer' };
        setState({ url, value });
      });
    return () => {
      live = false;
    };
  }, [url, isRepo]);
  if (!url || !isRepo) return undefined;
  return state && state.url === url ? state.value : { status: 'loading' };
}

/** "Earlier captures": counts of verified records only (unverified ones are never counted). */
function EarlierCapturesView({ value }: { value: EarlierCaptures | undefined }) {
  const v = earlierCopy(value);
  const timeline = (href: string) => (
    <a className="link" href={href} target="_blank" rel="noreferrer">
      View timeline
    </a>
  );
  return (
    <section aria-labelledby="earlier-captures" aria-busy={v.kind === 'loading'}>
      <h2 id="earlier-captures" className="section-label">
        Earlier captures
      </h2>
      {v.kind === 'loading' ? (
        <p className="muted earlier-loading">
          <StatusBadge status="pending" label={v.text} />
        </p>
      ) : v.kind === 'some' ? (
        <div className="earlier">
          <p className="earlier-counts tabular">{v.counts}</p>
          <p className="muted tabular">{v.latest}</p>
          {v.note ? <p className="muted">{v.note}</p> : null}
          <p>{timeline(v.timelineUrl)}</p>
        </div>
      ) : v.kind === 'unavailable' ? (
        <div className="earlier">
          <p>
            <StatusBadge status="unavailable" />
          </p>
          <p className="muted">{v.text}</p>
          <p>{timeline(v.timelineUrl)}</p>
        </div>
      ) : v.kind === 'unchecked' ? (
        <div className="earlier">
          <p className="muted">{v.text}</p>
          <p>{timeline(v.timelineUrl)}</p>
        </div>
      ) : (
        <p className="muted">{v.text}</p>
      )}
    </section>
  );
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
  const [view, setView] = useState<'main' | 'settings'>('main');
  const job = useCaptureState();
  // Storage is chosen after the capture, in the Recall tab (R44): nothing here gates on it.
  // Only pages the extension can capture have a history to look up.
  const capturable = page && !pageBlockedReason(page.url) ? page.url : undefined;
  // A GitHub repository page captures GitHub's API answer for the branch (R46): its history is
  // that URL's.
  const repo = useRepoTarget(capturable);
  const earlier = useEarlierCaptures(
    repo ? (repo.status === 'ok' ? repo.captureUrl : undefined) : capturable,
  );

  // The service worker tries the URL the pinned witness announced on Arkiv, then the
  // settings URL; online needs /info within 2 s from a pinned signer.
  const probeWitness = useCallback(() => {
    send({ type: 'recall.witnessStatus' })
      .then((r) =>
        setWitness((r as { online?: boolean } | undefined)?.online ? 'online' : 'offline'),
      )
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
  const running = isLiveRunning(job, now) ? job : undefined;
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
  // The settings are a panel of this popup (the options page has the same form).
  const openSettings = useCallback(() => {
    cameFromSettings.current = true;
    setView('settings');
  }, []);
  // Back puts the keyboard on the Settings button of the header (the control that stays).
  const settingsButton = useRef<HTMLButtonElement>(null);
  const cameFromSettings = useRef(false);
  useEffect(() => {
    if (view === 'main' && cameFromSettings.current) {
      cameFromSettings.current = false;
      settingsButton.current?.focus();
    }
  }, [view]);

  let disabledReason: string | null = null;
  let blocked: string | null;
  if (running) disabledReason = mine ? null : 'Another capture is running. Wait for it to finish.';
  else if (page === undefined) disabledReason = 'Reading the current tab…';
  else if (page === null) disabledReason = 'Only https:// pages can be captured.';
  else if ((blocked = pageBlockedReason(page.url))) disabledReason = blocked;
  else if (repo?.status === 'loading') disabledReason = 'Finding the branch on GitHub…';
  else if (repo?.status === 'error')
    disabledReason = `Couldn't read this repository from GitHub: ${repo.error.replace(/\.+$/, '')}.`;
  else if (witness === 'checking') disabledReason = 'Checking the witness…';
  else if (witness === 'offline')
    disabledReason = 'The witness is offline, so new captures are paused.';
  const busy = Boolean(running && mine);
  const helper =
    disabledReason ?? (repo?.status === 'ok' ? repoSubline(repo.target.branch) : CAPTURE_HELPER);

  return (
    <div className="popup">
      <Onboarding />
      <header className="popup-header">
        <h1 className="popup-title">Recall</h1>
        <div className="popup-header-tools">
          <WitnessChip state={witness} />
          {view === 'main' ? (
            <button type="button" className="icon-btn" aria-label="Settings" ref={settingsButton} onClick={openSettings}>
              <SettingsIcon size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      {view === 'settings' ? (
        <main className="popup-body">
          <SettingsPanel
            onBack={() => setView('main')}
            onSaved={(_s, info) => {
              // New pins or a new witness URL: look at the witness again.
              if (info.witnessChanged) checkWitness();
            }}
          />
        </main>
      ) : (
        <>
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
                  steps={(({ labels, current }) =>
                    labels.map((label, i) => ({
                      label,
                      state: (i < current
                        ? 'done'
                        : i === current
                          ? 'active'
                          : 'waiting') as StepState,
                    })))(jobSteps(mine))}
                />
                <progress className="progress" aria-label="Capture progress" />
                <p className="progress-text">
                  {formatElapsed(now - mine.startedAt)} elapsed ·{' '}
                  {mine.repo ? 'usually under a minute' : 'usually 15–30 s'}
                </p>
                <div className="popup-actions">
                  <button type="button" className="btn btn-secondary" onClick={cancel}>
                    Cancel capture
                  </button>
                </div>
                <p className="popup-note muted">
                  You can close this popup. The capture keeps running.
                </p>
              </section>
            ) : mine?.status === 'done' ? (
              <CaptureResult
                job={mine}
                copied={copied}
                openSettings={openSettings}
                onCopy={() => {
                  const u = mine.upload;
                  void navigator.clipboard
                    .writeText(
                      JSON.stringify({
                        url: mine.url,
                        ...(u?.status === 'failed' ? { error: u.error } : {}),
                      }),
                    )
                    .then(() => setCopied(true));
                }}
              />
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
            ) : capturable ? (
              <EarlierCapturesView value={earlier} />
            ) : null}
          </main>

          <footer className="popup-footer">
            <button
              type="button"
              // One primary action per screen: after a capture the result's own action leads.
              className={`btn ${mine?.status === 'done' ? 'btn-secondary' : 'btn-primary'} btn-block`}
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
              ) : repo ? (
                REPO_BUTTON
              ) : (
                PAGE_BUTTON
              )}
            </button>
            <p id="capture-helper" className="popup-helper muted">
              {helper}
            </p>
          </footer>
        </>
      )}
    </div>
  );
}

/**
 * The repository snapshot's upload progress of a pending capture, read live from its pending
 * record (the publish tab started the upload). Null when there is none.
 */
function useUploadProgress(captureId: string | undefined): { done: number; total: number } | null {
  const [p, setP] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    if (!captureId) return;
    const key = `recall.pending.${captureId}`;
    const read = (raw: unknown) => {
      try {
        const u = typeof raw === 'string' ? (JSON.parse(raw) as { upload?: { status?: string; progress?: unknown } }).upload : undefined;
        const g = u?.status === 'uploading' ? (u.progress as { done?: unknown; total?: unknown } | undefined) : undefined;
        setP(g && typeof g.done === 'number' && typeof g.total === 'number' ? { done: g.done, total: g.total } : null);
      } catch {
        setP(null);
      }
    };
    chrome.storage.local.get(key).then((r) => read(r[key])).catch(() => undefined);
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (key in changes) read(changes[key].newValue);
    };
    chrome.storage.local.onChanged.addListener(onChanged);
    return () => chrome.storage.local.onChanged.removeListener(onChanged);
  }, [captureId]);
  return p;
}

function CaptureResult({
  job,
  copied,
  openSettings,
  onCopy,
}: {
  job: Extract<CaptureState, { status: 'done' }>;
  copied: boolean;
  openSettings: () => void;
  onCopy: () => void;
}) {
  const lines = checkLines(job.checks, job.evidence);
  const v = verdict(lines, job.checks);
  const up = job.upload ? uploadCopy(job.upload, v.kind === 'success') : null;
  const u = job.upload;
  const progress = useUploadProgress(u?.status === 'pending' ? u.captureId : undefined);
  const openApprove = () => {
    if (u?.status === 'pending' || u?.status === 'confirmation') {
      // The capture's publish tab if it is open, else a new one (one tab per capture).
      void loadSettings().then(({ appUrl }) =>
        focusOrOpenApproveTab(approveUrl(appUrl, u.captureId, chrome.runtime.id), u.captureId),
      );
    }
  };
  const upActions = {
    openApprove: (
      <button key="approve" type="button" className="btn btn-primary" onClick={openApprove}>
        Open Recall tab
      </button>
    ),
    copy: (
      <button key="copy" type="button" className="btn btn-ghost" onClick={onCopy}>
        {copied ? 'Copied' : 'Copy details'}
      </button>
    ),
  };
  return (
    <section aria-labelledby="capture-result">
      <h2 id="capture-result" className="section-label">
        Capture result
      </h2>
      {up ? (
        <div className="upload-result">
          <Notice
            kind={up.kind}
            title={up.title}
            focus
            actions={up.actions.length ? up.actions.map((a) => upActions[a]) : undefined}
          >
            {up.body}
          </Notice>
          {progress ? (
            <p className="muted tabular" role="status">
              {uploadProgressText(progress)}
            </p>
          ) : null}
        </div>
      ) : null}
      <Notice
        kind={v.kind}
        title={v.title}
        focus={!up}
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
      <CheckDetails checks={lines}>
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
      </CheckDetails>
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
