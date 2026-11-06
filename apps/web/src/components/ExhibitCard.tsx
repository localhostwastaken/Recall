import type { VerifiedFacts } from '@recall/evidence';
import type { ReactNode } from 'react';
import { INVALID_TIME, formatBytes, formatLocal, formatUtc, safeDate } from '../format';
import { MonoValue } from '../ui/MonoValue';
import { witnessLabel } from '../witness';

/**
 * What the witness saw, as a hairline-framed list of labelled facts. Every value comes from
 * `facts` (the verified evidence); `evidenceRef` is the Swarm reference the evidence was
 * downloaded from, which was checked against the downloaded bytes.
 */
export function ExhibitCard({ facts, evidenceRef }: { facts: VerifiedFacts; evidenceRef?: string }) {
  const label = witnessLabel(facts.witness);
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
        What the witness saw
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
    </section>
  );
}
