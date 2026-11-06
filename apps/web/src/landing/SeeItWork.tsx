import './landing.css';
import type { CheckResult, VerifiedFacts } from '@recall/evidence';
import { ChevronDown, CircleDashed, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Hex } from 'viem';
import { CaptureCard, type CardStatus } from '../components/CaptureCard';
import { EXAMPLE_CAPTURE_HREF, EXAMPLE_CAPTURE_KEY } from '../components/TryIt';
import { StatusBadge, type Status } from '../ui/StatusBadge';
import { VerdictLine } from '../verify/CheckPanel';
import { useVerifiedCapture, type CapturePhase, type CaptureRecord, type StorageState } from '../verify/useVerifiedCapture';
import { verdictOf, type Verdict, type VerifiedReport } from '../verify/verify';

/** Where the example capture was taken (our own demo notice), shown until its evidence is verified. */
export const EXAMPLE_ADDRESS = 'localhostwastaken.github.io/Recall/notice/';

/** One run of the real verification of the example capture, shared by the hero and section 2. */
export type ExampleCheck = {
  phase: CapturePhase;
  report: VerifiedReport | null;
  storage: StorageState;
  verdict: Verdict;
  record: CaptureRecord | null;
  facts: VerifiedFacts | null;
  retry: () => void;
};

/** A thin wrapper over `useVerifiedCapture` for the example capture (spec 6.2, 12.1). */
export function useExampleCheck(): ExampleCheck {
  const v = useVerifiedCapture(EXAMPLE_CAPTURE_KEY as Hex);
  return {
    phase: v.phase,
    report: v.report,
    storage: v.storage,
    verdict: verdictOf(v.report),
    record: v.record,
    facts: v.facts,
    retry: v.retry,
  };
}

/** The record could not be read at all (Arkiv unreachable, or the record is gone). */
export const recordFailed = (c: ExampleCheck): boolean => c.phase === 'error' || c.phase === 'missing' || c.phase === 'not-capture';

/**
 * The card status for the example: "Checking…" until the real verdict, then the verdict. Green only
 * for a verdict that passed; a check that could not run is "Not checked" (grey), never green.
 */
export function exampleStatus(c: ExampleCheck): { status: CardStatus; label?: string } {
  if (recordFailed(c)) return { status: 'unchecked', label: 'Not checked' };
  switch (c.verdict.kind) {
    case 'pending':
      return { status: 'checking' };
    case 'pass':
      return { status: 'verified' };
    case 'na':
      return { status: 'unchecked', label: 'Not checked' };
    default:
      return { status: 'unverified' };
  }
}

/** host + path of a verified address, without the query. */
function hostPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/** The page title from the verified body: text only, never markup, at most 120 characters. */
export function titleFromBody(facts: VerifiedFacts | null): string | null {
  if (!facts || typeof DOMParser === 'undefined') return null;
  if (facts.contentType && !/html/i.test(facts.contentType)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(facts.body.slice(0, 64 * 1024));
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const t = (doc.querySelector('title')?.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return t.length > 120 ? `${t.slice(0, 120)}…` : t;
  } catch {
    return null;
  }
}

/** Days left on the Arkiv record, from the live storage read (null until read or unreadable). */
export function exampleDaysLeft(storage: StorageState): number | null {
  if (storage.phase !== 'done' || !storage.info) return null;
  const s = storage.info.arkivSecondsLeft;
  return s === null || !Number.isFinite(s) ? null : Math.max(0, Math.floor(s / 86_400));
}

/** The example capture's card props (the same card in the hero and in section 2). */
export function exampleCardProps(c: ExampleCheck) {
  const verified = c.verdict.kind === 'pass';
  return {
    title: (verified && titleFromBody(c.facts)) || 'Example capture',
    address: verified && c.facts ? hostPath(c.facts.canonicalUrl) : EXAMPLE_ADDRESS,
    href: EXAMPLE_CAPTURE_HREF,
    kind: 'page' as const,
    versions: 1,
    date: c.record ? new Date(Number(c.record.signedAt) * 1000) : undefined,
    daysLeft: exampleDaysLeft(c.storage),
  };
}

type Row = { letter: string; title: string; how: string; status: Status; detail?: string };

const NOT_READ = 'Not checked: the record could not be read from Arkiv.';

const fromResult = (r: CheckResult): { status: Status; detail?: string } => ({
  status: r.status,
  detail: r.status === 'pass' ? undefined : r.detail,
});

/** Rows A, B, C and E with their real results (pending while the checks still run). */
export function checkRows(c: ExampleCheck): Row[] {
  const failed = recordFailed(c);
  const pick = (r: CheckResult | undefined): { status: Status; detail?: string } =>
    failed ? { status: 'unavailable', detail: NOT_READ } : r ? fromResult(r) : { status: 'pending' };
  const e: { status: Status; detail?: string } = failed
    ? { status: 'unavailable', detail: NOT_READ }
    : c.storage.phase === 'done'
      ? fromResult(c.storage.check)
      : { status: 'pending' };
  return [
    {
      letter: 'A',
      title: 'Bytes match the signed hashes',
      how: 'Your browser fetched the evidence from Swarm by its content address and re-hashed every byte against what the witness signed.',
      ...pick(c.report?.A),
    },
    {
      letter: 'B',
      title: 'Request and response are well-formed',
      how: 'The extension, a TLSNotary fork, captured a plain HTTPS request with no cookies, and this confirms the request and the answer are complete.',
      ...pick(c.report?.B),
    },
    {
      letter: 'C',
      title: 'Signed by a trusted witness',
      how: 'An independent witness watched the HTTPS session and signed what it saw; your browser checks that signature against the witnesses you trust.',
      ...pick(c.report?.C),
    },
    {
      letter: 'E',
      title: 'Storage',
      how: 'Arkiv, the public index, and the Swarm storage batch are read live to show how long this capture stays stored.',
      ...e,
    },
  ];
}

/** Rows revealed one by one, this far apart (spec 6.2: motion that answers an action). */
export const REVEAL_MS = 150;

function CheckList({ rows, shown }: { rows: Row[]; shown: number }) {
  return (
    <ol className="try-checks" aria-label="Checks">
      {rows.map((r, i) => {
        const revealed = i < shown;
        const status: Status = revealed ? r.status : 'unavailable';
        return (
          <li key={r.letter} className={`try-check${revealed ? ' is-revealed' : ''}`} data-try-check={r.letter}>
            <div className="try-check-head">
              <span className="try-letter" aria-hidden="true">
                {r.letter}
              </span>
              <span className="try-title">
                <span className="visually-hidden">Check {r.letter}: </span>
                {r.title}
              </span>
              <span className="try-badge">
                <StatusBadge status={status} label={revealed ? undefined : 'Not run yet'} />
              </span>
            </div>
            {revealed && r.detail ? <p className="try-detail">{r.detail}</p> : null}
            <details className="try-how">
              <summary>
                How?
                <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
              </summary>
              <p>{r.how}</p>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Section 2, "See it work on a real capture": the example card, "Run the checks", and the rows
 * revealed one by one with their real results. `started` is lifted into Home so the hero's
 * "See a proof check itself" can start it too. `children` go under "More ways to check".
 */
export function SeeItWork({
  check,
  started,
  onStart,
  children,
}: {
  check: ExampleCheck;
  started: boolean;
  onStart: () => void;
  children?: ReactNode;
}) {
  const rows = checkRows(check);
  const [shown, setShown] = useState(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!started) return;
    let n = 0;
    const tick = () => {
      n += 1;
      setShown(n);
      if (n < rows.length) timer.current = window.setTimeout(tick, REVEAL_MS);
    };
    timer.current = window.setTimeout(tick, REVEAL_MS);
    return () => window.clearTimeout(timer.current);
    // The reveal runs once per start; results fill in as they arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  const allShown = shown >= rows.length;
  const failed = recordFailed(check);
  const done = allShown && (failed || check.verdict.kind !== 'pending');
  const base = exampleStatus(check);
  const card = exampleCardProps(check);
  const status = !started ? { status: 'unchecked' as const } : done ? base : { status: 'checking' as const };

  const action = done ? (
    <a className="btn btn-secondary land-btn" href={EXAMPLE_CAPTURE_HREF}>
      Open the full proof
    </a>
  ) : (
    <button
      type="button"
      className="btn btn-primary land-btn"
      onClick={onStart}
      disabled={started}
      aria-busy={started || undefined}
    >
      {started ? 'Checking…' : 'Run the checks'}
    </button>
  );

  return (
    <section id="how-it-works" className="lsec lsec-alt" aria-labelledby="how-it-works-title">
      <h2 className="lsec-title" id="how-it-works-title">
        See it work on a real capture
      </h2>
      <p className="lsec-intro">
        A page we captured during the hackathon. Press the button: your browser fetches the evidence from Swarm and
        checks it right here. Nothing is taken on trust, not even from us.
      </p>
      <div className="try-grid">
        {/* Left: the capture, its verdict and the one action; right: the checks. The verdict has a
            reserved slot, so the two columns weigh the same before and after the run. */}
        <div className="try-left">
          <CaptureCard {...card} status={status.status} statusLabel={'label' in status ? status.label : undefined} />
          {done && !failed ? <VerdictLine verdict={check.verdict} /> : null}
          {done && failed ? (
            <div className="try-error" role="alert">
              <p>
                <b>Couldn't read the example from Arkiv.</b> Nothing was checked. Check your connection, then try again.
              </p>
              <button type="button" className="btn btn-secondary land-btn" onClick={check.retry}>
                Try again
              </button>
            </div>
          ) : null}
          {!done ? (
            <p className="try-slot">
              {started ? (
                <LoaderCircle size={20} strokeWidth={1.75} aria-hidden="true" className="spin" />
              ) : (
                <CircleDashed size={20} strokeWidth={1.75} aria-hidden="true" />
              )}
              <span>{started ? 'Fetching the evidence from Swarm and checking it…' : 'The verdict appears here once the checks have run.'}</span>
            </p>
          ) : null}
          <div className="try-action">{action}</div>
        </div>
        <div className="try-right">
          <CheckList rows={rows} shown={shown} />
        </div>
      </div>
      {children ? (
        <details className="more-ways">
          <summary>
            More ways to check
            <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
          </summary>
          <div className="more-ways-body">{children}</div>
        </details>
      ) : null}
    </section>
  );
}
