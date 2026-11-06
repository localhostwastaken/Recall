import { Check, CircleDashed, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatShortDay } from '../format';
import './captureCard.css';

/**
 * What a card says about a capture's checks. Green ("Verified") only for a capture this browser
 * verified; everything else is grey or amber (spec 4.2, 12.1).
 */
export type CardStatus = 'verified' | 'checking' | 'unchecked' | 'unverified';

export type CaptureCardProps = {
  /** The page title (from verified evidence) or host + path until then. */
  title: string;
  /** host/path, shown on one line with an ellipsis. */
  address: string;
  /** Where the card leads: the capture page `#/c/<entityKey>`. */
  href: string;
  status: CardStatus;
  /** Shown as "#n" only where a ranking is shown (library sorted by time left). */
  rank?: number;
  kind: 'page' | 'repo';
  versions: number;
  date?: Date;
  /** Whole days left in storage; null when it could not be read. */
  daysLeft: number | null;
  /** The card's one action ("Keep alive"). It sits outside the card link. */
  keepAlive?: ReactNode;
  /** Overrides the status word (e.g. "Not checked" after a check that could not run). */
  statusLabel?: string;
  className?: string;
};

const STATUS: Record<CardStatus, { word: string; tone: 'pass' | 'na' | 'warn'; Icon: LucideIcon }> = {
  verified: { word: 'Verified', tone: 'pass', Icon: Check },
  checking: { word: 'Checking…', tone: 'na', Icon: LoaderCircle },
  unchecked: { word: 'Not checked yet', tone: 'na', Icon: CircleDashed },
  unverified: { word: 'Unverified', tone: 'warn', Icon: TriangleAlert },
};

/** Days that fill the life bar: about eight months of storage reads as "full". */
export const FULL_LIFE_DAYS = 240;
/** Fewer days than this left is "ends soon" (amber). */
export const SOON_DAYS = 7;

export const lifeWidth = (daysLeft: number): number => Math.max(0, Math.min(100, (daysLeft / FULL_LIFE_DAYS) * 100));

/** The plain facts after the status pill: "Page", "Repo · 3 versions" (versions only when more than one). */
export function cardFacts(kind: 'page' | 'repo', versions: number): string {
  const what = kind === 'repo' ? 'Repo' : 'Page';
  return versions > 1 ? `${what} · ${versions} versions` : what;
}

export function StatusPill({ status, label }: { status: CardStatus; label?: string }) {
  const { word, tone, Icon } = STATUS[status];
  return (
    <span className={`ccard-pill pill-${tone}`} data-status={status}>
      <Icon size={14} strokeWidth={2.25} aria-hidden="true" className={status === 'checking' ? 'spin' : undefined} />
      <span>{label ?? word}</span>
    </span>
  );
}

/**
 * The one capture card (spec 4.4), kept calm: title (and a quiet rank) over the address; the status
 * pill and plain facts; time left and one action.
 * The title link stretches over the whole card, so the card opens the capture page, while the
 * keep-alive slot stays outside the link (a button must not sit inside a link).
 */
export function CaptureCard({
  title,
  address,
  href,
  status,
  rank,
  kind,
  versions,
  date,
  daysLeft,
  keepAlive,
  statusLabel,
  className,
}: CaptureCardProps) {
  const life = daysLeft === null ? 'is-unknown' : daysLeft < SOON_DAYS ? 'is-soon' : 'is-ok';
  const days = daysLeft === null ? null : Math.max(0, Math.floor(daysLeft));
  const validDate = date && !Number.isNaN(date.getTime()) ? date : undefined;
  return (
    <article className={`ccard${className ? ` ${className}` : ''}`}>
      <div className="ccard-head">
        <div className="ccard-ttl">
          <h3 className="ccard-title">
            <a className="ccard-link" href={href}>
              {title}
            </a>
          </h3>
          <p className="ccard-addr" title={address}>
            {address}
          </p>
        </div>
        {rank !== undefined ? (
          <span className="ccard-rank" aria-label={`Rank ${rank}`}>
            #{rank}
          </span>
        ) : null}
      </div>
      <div className="ccard-facts">
        <StatusPill status={status} label={statusLabel} />
        <span className="ccard-meta">
          {cardFacts(kind, versions)}
          {validDate ? (
            <>
              {' · '}
              <time dateTime={validDate.toISOString()}>{formatShortDay(BigInt(Math.floor(validDate.getTime() / 1000)))}</time>
            </>
          ) : null}
        </span>
      </div>
      <div className="ccard-foot">
        <div className={`ccard-life ${life}`}>
          <p className="ccard-life-label">
            {days === null ? (
              'Time left unknown'
            ) : (
              <>
                <b className="ccard-days" data-days={days}>
                  {days}
                </b>{' '}
                {days === 1 ? 'day' : 'days'} left
              </>
            )}
          </p>
          <span className="ccard-bar" aria-hidden="true">
            <span className="ccard-bar-fill" style={{ width: `${days === null ? 0 : lifeWidth(days)}%` }} />
          </span>
        </div>
        {keepAlive ? <div className="ccard-action">{keepAlive}</div> : null}
      </div>
    </article>
  );
}
