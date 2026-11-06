import type { VerifiedFacts } from '@recall/evidence';
import { useMemo, type ReactNode } from 'react';
import { recordLinks } from '../explorers';
import { INVALID_TIME, formatBytes, formatLocal, formatUtc, safeDate } from '../format';
import { getNetConfig } from '../net';
import { MonoValue } from '../ui/MonoValue';
import { witnessLabel } from '../witness';
import { CheckItYourself } from './OutsideLinks';

/**
 * What the witness saw, as a hairline-framed list of labelled facts. Every value comes from
 * `facts` (the verified evidence); `evidenceRef` is the Swarm reference the evidence was
 * downloaded from, which was checked against the downloaded bytes. `unverified`: the witness is
 * not one you trust (check C did not pass), so the facts are shown as its claim. `record`: the
 * Arkiv record on a record page; with it, "Check it yourself" links to the same record (and its
 * evidence file and publisher) in the outside tools, where the network has them (live only).
 */
export function ExhibitCard({
  facts,
  evidenceRef,
  unverified = false,
  record,
}: {
  facts: VerifiedFacts;
  evidenceRef?: string;
  unverified?: boolean;
  record?: { entityKey: string; owner?: string };
}) {
  const label = witnessLabel(facts.witness);
  const links = useMemo(
    () => (record ? recordLinks(getNetConfig(), { entityKey: record.entityKey, evidenceRef, owner: record.owner }) : []),
    [record?.entityKey, record?.owner, evidenceRef],
  );
  // The signed time comes from evidence anyone can make: an impossible one must not crash the page.
  const when = safeDate(facts.signedAt);
  const row = (term: string, value: ReactNode) => (
    <div className="exhibit-row">
      <dt>{term}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <section className="exhibit" aria-labelledby="exhibit-title">
      <h2 className="exhibit-title" id="exhibit-title">
        {unverified ? 'Unverified: what a witness you have not pinned says it saw' : 'What the witness saw'}
      </h2>
      <dl className="exhibit-list">
        {row('Site', <span className="mono">{facts.serverName}</span>)}
        {row('Address', <MonoValue value={facts.canonicalUrl} full />)}
        {row(
          'Captured',
          when ? (
            <time className="tabular" dateTime={when.toISOString()} title={formatLocal(facts.signedAt)}>
              {formatUtc(facts.signedAt)}
            </time>
          ) : (
            <span>{INVALID_TIME}</span>
          ),
        )}
        {row('Size', <span className="mono">{formatBytes(facts.body.length)}</span>)}
        {row('HTTP status', <span className="mono">{facts.httpStatus}</span>)}
        {row('Content type', facts.contentType ? <span className="mono">{facts.contentType}</span> : <span className="muted">Not stated</span>)}
        {row(
          'Witness',
          <span className="exhibit-witness">
            <span>{label ?? 'Unknown witness'}</span>
            <MonoValue value={facts.witness} />
          </span>,
        )}
        {evidenceRef ? row('Evidence', <MonoValue value={evidenceRef} />) : null}
      </dl>
      <CheckItYourself links={links} />
    </section>
  );
}
