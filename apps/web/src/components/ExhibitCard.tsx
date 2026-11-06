import type { VerifiedFacts } from '@recall/evidence';
import type { ReactNode } from 'react';
import { formatBytes, formatLocal, formatUtc } from '../format';
import { MonoValue } from '../ui/MonoValue';
import { witnessLabel } from '../witness';

/**
 * What the witness saw, as a hairline-framed list of labelled facts. Every value comes from
 * `facts` (the verified evidence); `evidenceRef` is the Swarm reference the evidence was
 * downloaded from, which was checked against the downloaded bytes.
 */
export function ExhibitCard({ facts, evidenceRef }: { facts: VerifiedFacts; evidenceRef?: string }) {
  const label = witnessLabel(facts.witness);
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
          <time className="tabular" dateTime={new Date(Number(facts.signedAt) * 1000).toISOString()} title={formatLocal(facts.signedAt)}>
            {formatUtc(facts.signedAt)}
          </time>,
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
