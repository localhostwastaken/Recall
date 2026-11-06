import { useEffect, useRef } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import type { CheckReport } from '@recall/evidence';
import { MonoValue } from '../ui/MonoValue';
import { Notice } from '../ui/Notice';
import { useToast } from '../ui/Toast';
import { EvidencePanel } from './EvidencePanel';
import { claimedDate, indexMetadataMatches, type Capture } from './evidenceView';
import { readingText } from './readingText';

export type Detail = { id: number; name: string; row?: Capture } & (
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; report: CheckReport; bytes: Uint8Array; from: string }
);

export function CaptureDetail({ detail, onClose, onRetry }: { detail: Detail; onClose: () => void; onRetry: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const toast = useToast();
  useEffect(() => { heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'start' }); }, []);
  const report = detail.kind === 'done' ? detail.report : undefined;
  const facts = report?.facts;
  const text = facts ? readingText(facts.body, facts.contentType) : null;
  const match = detail.row && report ? indexMetadataMatches(detail.row, report) : null;
  const failed = report && [report.A, report.B, report.C].some(c => c.status === 'fail');

  const download = () => {
    if (detail.kind !== 'done') return;
    const href = URL.createObjectURL(new Blob([new Uint8Array(detail.bytes)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = href; a.download = 'recall-evidence.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    toast('Evidence download started');
  };

  return <section className="capture-detail" aria-labelledby="capture-heading">
    <div className="section-heading">
      <div><p className="overline">The saved record</p><h2 ref={heading} id="capture-heading" tabIndex={-1}>Read it. Inspect it.</h2></div>
      <button className="btn btn-secondary" type="button" onClick={onClose}>Close record</button>
    </div>
    <p className="capture-origin">{detail.name}</p>
    {detail.kind === 'loading' && <div className="detail-loading"><p role="status">Retrieving the evidence and running checks…</p><div className="document-skeleton" aria-hidden="true"><span /><span /><span /><span /></div></div>}
    {detail.kind === 'error' && <>
      <Notice kind="error" title="Evidence could not be inspected" actions={<button type="button" className="btn btn-secondary" onClick={onRetry}>Try again</button>}>
        {detail.row ? 'The record is listed, but its evidence could not be retrieved or read. This does not establish whether the capture is valid.' : 'This file could not be read as Recall evidence. Choose a Recall evidence JSON file or try opening it again.'}
        <details className="error-details"><summary>Technical details</summary><p>{detail.message}</p></details>
      </Notice>
      <EvidencePanel />
    </>}
    {detail.kind === 'done' && report && <>
      {failed ? <Notice kind="error" title="A check failed">Review the individual results before relying on this record. The reading view is withheld when usable response facts cannot be established.</Notice>
        : report.C.status === 'warn' ? <Notice kind="warn" title="Signature checked; witness unknown">The signature recovers to the stated signer. This reader has not established that the witness is trusted.</Notice>
        : <Notice kind="info" title="Evidence checks complete">See each result below. Source authenticity and capture time still depend on the witness’s claims.</Notice>}
      {match === false && <Notice kind="warn" title="Index metadata differs from this evidence">The listed URL hash, body hash or witness does not match the checked response. Reading details below come from the evidence, not the index.</Notice>}
      <div className="record-layout">
        <article className="document-sheet reading-sheet" aria-labelledby="reading-heading">
          <p className="overline">Saved response / derived text</p>
          {facts ? <>
            <h3 id="reading-heading">{facts.serverName}</h3>
            <a className="record-source" href={facts.canonicalUrl} target="_blank" rel="noreferrer">{facts.canonicalUrl}<ExternalLink size={16} aria-hidden="true" /><span className="visually-hidden"> (opens the current source in a new tab)</span></a>
            <dl className="record-facts"><div><dt>Witness-claimed time</dt><dd>{claimedDate(facts.signedAt)}</dd></div><div><dt>HTTP response</dt><dd>{facts.httpStatus} · {facts.body.length.toLocaleString()} bytes</dd></div></dl>
            {text !== null ? <div className="reading-text">{text || 'This response contains no extractable text.'}</div> : <div className="unavailable-reading"><h4>Text view unavailable</h4><p>This content type or encoding is not supported by the reading view. The response bytes remain in the downloadable evidence file.</p></div>}
            <p className="reading-note">A simplified text view of the saved response. Layout, images, scripts and linked resources are not reproduced.</p>
          </> : <div className="unavailable-reading"><h3 id="reading-heading">Reading view unavailable</h3><p>The transcript or signature checks did not establish usable response facts. The individual checks explain why.</p></div>}
        </article>
        <EvidencePanel report={report} />
      </div>
      <details className="technical-details"><summary>Identifiers, retrieval and evidence file</summary>
        <div className="technical-body">
          <dl className="technical-values"><div><dt>Retrieved from</dt><dd>{detail.from}</dd></div>
            {detail.row && <><div><dt>Index record key</dt><dd><MonoValue value={detail.row.entityKey} full /></dd></div><div><dt>Swarm reference</dt><dd><MonoValue value={detail.row.evidenceRef} full /></dd></div><div><dt>Index metadata</dt><dd>{match === null ? 'Could not compare with checked response facts.' : match ? 'URL hash, body hash and witness match the checked facts. Chain inclusion has not been checked.' : 'The indexed fields differ from the checked evidence.'}</dd></div></>}
            {facts && <><div><dt>Response body SHA-256</dt><dd><MonoValue value={facts.bodySha256} full /></dd></div><div><dt>Witness address</dt><dd><MonoValue value={facts.witness} full /></dd></div></>}
          </dl>
          <button className="btn btn-secondary" type="button" onClick={download}><Download size={18} aria-hidden="true" />Download evidence JSON</button>
          <p className="field-helper">The original evidence bytes are retained. You can reopen this file in the reader.</p>
        </div>
      </details>
      <p className="record-limitation">Version comparison is not yet available. You can inspect another record individually.</p>
    </>}
  </section>;
}
