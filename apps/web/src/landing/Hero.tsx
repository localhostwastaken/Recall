import './landing.css';
import { useRef } from 'react';
import { Duo } from '../brand/Duo';
import { CaptureCard } from '../components/CaptureCard';
import { useLibraryCounts } from './LibraryPreview';
import { exampleCardProps, exampleStatus, type ExampleCheck } from './SeeItWork';

/** The four steps of how Recall works, shown as the hero's rail. */
export const RAIL_STEPS = ['Captured', 'Witness signed', 'Stored on Swarm', 'Indexed on Arkiv'] as const;

const WORD = 'forgets';

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Scrolls to a landing section (hash routes cannot use #anchors). */
export function scrollToId(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

/** Below this many captures the hero shows no numbers: a tiny number undersells the product. */
export const STATS_MIN = 10;

function Stats() {
  const counts = useLibraryCounts();
  if (!counts || counts.captures < STATS_MIN) return null;
  const n = (v: number, one: string, many: string) => `${v.toLocaleString('en')} ${v === 1 ? one : many}`;
  return (
    <p className="hero-stats">
      {n(counts.captures, 'capture', 'captures')} · {n(counts.sites, 'site', 'sites')} · {n(counts.repos, 'repo', 'repos')}{' '}
      on Arkiv
    </p>
  );
}

/**
 * Section 1: what Recall is in one line, the two ways forward, and a panel with the rail, the duo
 * and the real example capture. Its card shows "Checking…" until the shared check has a verdict.
 */
export function Hero({
  check,
  onSeeProof,
  onGetExtension,
}: {
  check: ExampleCheck;
  onSeeProof: () => void;
  onGetExtension: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const status = exampleStatus(check);
  return (
    <section className="hero" ref={root} aria-labelledby="hero-title">
      <div className="hero-grid">
        <div className="hero-copy">
          <h1 className="hero-title" id="hero-title" tabIndex={-1} aria-label="The web forgets. Recall doesn't.">
            The web{' '}
            <span className="nw">
              <span className="hero-forgets">
                {[...WORD].map((ch, i) => (
                  <span key={i} className="ch" aria-hidden="true">
                    {ch}
                  </span>
                ))}
              </span>
              .
            </span>
            <br />
            Recall doesn't.
          </h1>
          <p className="hero-lead">
            Capture any public page or GitHub repo with proof of what it said. Anyone can check that proof, even offline,
            even if we disappear.
          </p>
          <div className="hero-ctas">
            <button type="button" className="btn btn-primary land-btn" onClick={onSeeProof}>
              See a proof check itself
            </button>
            <button type="button" className="btn btn-secondary land-btn" onClick={onGetExtension}>
              Get the extension
            </button>
          </div>
          <p className="hero-reassure">No wallet or install needed to look around.</p>
          <Stats />
        </div>
        <div className="hero-panel">
          <ol className="hero-rail" aria-label="How a capture is kept">
            {RAIL_STEPS.map((s) => (
              <li key={s} className="hero-step is-on">
                <span className="hero-track" aria-hidden="true">
                  <span className="hero-fill" />
                </span>
                {s}
              </li>
            ))}
          </ol>
          <div className="hero-stage">
            <Duo className="hero-duo" />
          </div>
          <CaptureCard
            {...exampleCardProps(check)}
            className="hero-card"
            status={status.status}
            statusLabel={status.label}
          />
        </div>
      </div>
    </section>
  );
}
