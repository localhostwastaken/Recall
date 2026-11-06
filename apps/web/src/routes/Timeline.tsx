import { CircleCheck, Copy, LoaderCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Hex } from 'viem';
import { Diff } from '../components/Diff';
import { formatBytes, formatLocal, formatUtc, safeDate } from '../format';
import { buildTimeline, type Pending, type Unverified, type Version } from '../timeline/model';
import { useTimeline } from '../timeline/useTimeline';
import { MonoValue, middle } from '../ui/MonoValue';
import { Notice } from '../ui/Notice';
import { StatusBadge } from '../ui/StatusBadge';
import { Switch } from '../ui/Switch';
import { useToast } from '../ui/Toast';
import { TechnicalDetails } from '../verify/CheckPanel';
import { witnessLabel } from '../witness';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** A signed time from verified evidence, in UTC with the local time on hover. */
function When({ seconds }: { seconds: bigint }) {
  const d = safeDate(seconds);
  if (!d) return <span>{formatUtc(seconds)}</span>;
  return (
    <time className="tabular" dateTime={d.toISOString()} title={formatLocal(seconds)}>
      {formatUtc(seconds)}
    </time>
  );
}

function VersionItem({ v }: { v: Version }) {
  const label = witnessLabel(v.facts.witness) ?? 'Unknown witness';
  return (
    <li className="tl-item" data-kind="version" data-entity={v.entityKey}>
      <a className="tl-link" href={`#/c/${v.entityKey}`}>
        <span className="tl-title">
          Version {v.n} · <When seconds={v.facts.signedAt} />
        </span>
        <span className="tl-meta">
          {formatBytes(v.facts.body.length)} · HTTP {v.facts.httpStatus} · {label}
        </span>
        <StatusBadge status="pass" />
      </a>
      {v.confirmations.length > 0 ? (
        <ul className="tl-confirmations">
          {v.confirmations.map((c) => (
            <li key={c.entityKey} className="tl-confirmation" data-kind="confirmation" data-entity={c.entityKey}>
              <CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" className="tl-confirmation-icon" />
              <span>
                Confirmed unchanged on <When seconds={c.facts.signedAt} />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

const kindName = (kind: 'capture' | 'confirmation'): string => (kind === 'capture' ? 'Capture record' : 'Confirmation record');

function PendingItem({ p }: { p: Pending }) {
  return (
    <li className="tl-item tl-plain" data-kind="pending" data-entity={p.entityKey}>
      <span className="tl-title">{kindName(p.kind)}</span>
      <span className="tl-meta">
        <span className="mono">{middle(p.entityKey)}</span>
      </span>
      <StatusBadge status="pending" />
    </li>
  );
}

/** Never a date or a title from the index: only what the record is and why it did not pass. */
function UnverifiedItem({ u }: { u: Unverified }) {
  return (
    <li className="tl-item tl-plain" data-kind="unverified" data-entity={u.entityKey}>
      <span className="tl-title">{kindName(u.kind)}</span>
      <span className="tl-meta">
        <span className="mono" title={u.entityKey}>
          {middle(u.entityKey)}
        </span>
        {' · '}
        {u.reason}
        {u.kind === 'capture' ? (
          <>
            {' · '}
            <a href={`#/c/${u.entityKey}`}>Open record</a>
          </>
        ) : null}
      </span>
      <StatusBadge status={u.status} />
    </li>
  );
}

function Loading() {
  return (
    <div role="status" className="tl-loading">
      <p className="muted">Loading captures from Arkiv…</p>
      <div className="skeleton" aria-hidden="true" />
      <div className="skeleton" aria-hidden="true" />
    </div>
  );
}

/**
 * `#/u/:urlHash`: every capture of one address, oldest first. Records come from Arkiv, then
 * each is checked (A to C and the record cross-check) in this browser. Only records that pass
 * are listed and counted, with dates and details from their verified evidence; the rest wait
 * behind "Show unverified (n)". Nothing here claims completeness: R10's `truncated` is shown.
 */
export function Timeline({ urlHash }: { urlHash: Hex }) {
  const toast = useToast();
  const t = useTimeline(urlHash);
  const [showUnverified, setShowUnverified] = useState(false);
  const tl = useMemo(() => buildTimeline(t.rows, t.checked), [t.rows, t.checked]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast('Copied');
    } catch {
      toast('Copy is blocked in this browser. Select the address bar instead.');
    }
  };

  if (t.phase === 'error') {
    return (
      <>
        <h1 tabIndex={-1}>Captures of this page</h1>
        <Notice
          kind="error"
          title="Couldn't reach Arkiv."
          actions={
            <>
              <button type="button" className="btn btn-secondary" onClick={t.retry}>
                Retry
              </button>
              <a className="btn btn-secondary" href="#/settings">
                Check settings
              </a>
            </>
          }
        >
          The records could not be read. Check your connection and the Arkiv endpoint, then try again.
          <TechnicalDetails text={t.error} />
        </Notice>
      </>
    );
  }

  const first = tl.versions[0];
  const confirmations = tl.versions.reduce((n, v) => n + v.confirmations.length, 0);
  const settled = t.phase === 'ready' && tl.pending.length === 0;
  return (
    <>
      <h1 tabIndex={-1}>{first ? first.facts.serverName : 'Captures of this page'}</h1>
      <p className="tl-address">
        {first ? (
          <MonoValue value={first.facts.canonicalUrl} full />
        ) : (
          <>
            <span className="muted">Address hash </span>
            <MonoValue value={urlHash} />
          </>
        )}
      </p>
      {first ? (
        <p className="tl-summary" data-summary>
          {plural(tl.versions.length, 'version', 'versions')} · {plural(confirmations, 'confirmation', 'confirmations')} ·{' '}
          {t.truncated ? 'earliest shown' : 'first captured'} <When seconds={first.facts.signedAt} />
        </p>
      ) : null}
      <div className="page-actions">
        <button type="button" className="btn btn-secondary" onClick={copyLink}>
          <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
          Copy link
        </button>
      </div>

      {t.truncated ? (
        <Notice kind="warn" title="Results may be incomplete">
          <p>Too many records for this URL (possible spam); some may be hidden.</p>
          <p>
            Anyone can publish records for any address, so spam can push real captures out of this list. To check one
            capture directly, open its link or drop its evidence file.
          </p>
        </Notice>
      ) : null}

      {t.phase === 'loading' ? <Loading /> : null}

      {t.phase === 'ready' && t.rows.length === 0 ? (
        <Notice kind="info" title="No captures of this page yet.">
          Capture it with the Recall extension.
        </Notice>
      ) : null}

      {t.phase === 'ready' && t.rows.length > 0 ? (
        <>
          {tl.pending.length > 0 ? (
            <p className="muted tl-checking" role="status">
              <LoaderCircle size={16} strokeWidth={1.75} aria-hidden="true" className="spin" />
              Checking {plural(tl.pending.length, 'record', 'records')} in your browser…
            </p>
          ) : null}
          {settled && tl.versions.length === 0 ? (
            <Notice kind="info" title="No capture of this page passed its checks.">
              {plural(tl.unverified.length, 'record', 'records')} didn't pass {tl.unverified.length === 1 ? 'its' : 'their'} checks. Turn on
              “Show unverified ({tl.unverified.length})” to see why.
            </Notice>
          ) : null}
          {tl.versions.length > 0 || tl.pending.length > 0 ? (
            <section aria-labelledby="versions-title">
              <h2 className="section-title" id="versions-title">
                Versions
              </h2>
              <ol className="timeline" data-timeline>
                {tl.versions.map((v) => (
                  <VersionItem key={v.entityKey} v={v} />
                ))}
                {tl.pending.map((p) => (
                  <PendingItem key={p.entityKey} p={p} />
                ))}
              </ol>
            </section>
          ) : null}
          {tl.versions.length >= 2 ? <Diff versions={tl.versions} /> : null}
          {tl.unverified.length > 0 ? (
            <div className="tl-unverified">
              <Switch
                label={`Show unverified (${tl.unverified.length})`}
                checked={showUnverified}
                onChange={setShowUnverified}
              />
              {showUnverified ? (
                <section aria-labelledby="unverified-title">
                  <h2 className="section-title" id="unverified-title">
                    Unverified records
                  </h2>
                  <p className="muted">
                    These records did not pass their checks, so nothing they say is shown as fact, and they are not
                    counted above.
                  </p>
                  <ul className="timeline" data-timeline-unverified>
                    {tl.unverified.map((u) => (
                      <UnverifiedItem key={u.entityKey} u={u} />
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
