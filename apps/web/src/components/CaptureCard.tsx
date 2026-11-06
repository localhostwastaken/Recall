import {
  Check,
  CircleDashed,
  Clock,
  FileText,
  GitBranch,
  Layers,
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
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

/** The tile letter: the site's first letter (no remote favicons: privacy and CSP). */
export function favLetter(address: string): string {
  const host = address.replace(/^[a-z]+:\/\//i, '').replace(/^www\./i, '');
  const ch = host.match(/[\p{L}\p{N}]/u)?.[0];
  return ch ? ch.toUpperCase() : '?';
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
 * The one capture card (spec 4.4): title and address; status and facts; time left and one action.
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
  const KindIcon = kind === 'repo' ? GitBranch : FileText;
  return (
    <article className={`ccard${className ? ` ${className}` : ''}`}>
      <div className="ccard-head">
        <span className="ccard-fav" aria-hidden="true">
          {favLetter(address)}
        </span>
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
      </div>
      <ul className="ccard-facts" aria-label="Facts">
        <li>
          <StatusPill status={status} label={statusLabel} />
        </li>
        {rank !== undefined ? (
          <li>
            <span className="ccard-rank" aria-label={`Rank ${rank}`}>
              #{rank}
            </span>
          </li>
        ) : null}
        <li>
          <KindIcon size={14} strokeWidth={1.75} aria-hidden="true" />
          {kind === 'repo' ? 'Repo' : 'Page'}
        </li>
        <li>
          <Layers size={14} strokeWidth={1.75} aria-hidden="true" />
          {versions} {versions === 1 ? 'version' : 'versions'}
        </li>
        {date && !Number.isNaN(date.getTime()) ? (
          <li>
            <Clock size={14} strokeWidth={1.75} aria-hidden="true" />
            <time dateTime={date.toISOString()}>{formatShortDay(BigInt(Math.floor(date.getTime() / 1000)))}</time>
          </li>
        ) : null}
      </ul>
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
                <b>{days === 1 ? 'day' : 'days'}</b> left
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
