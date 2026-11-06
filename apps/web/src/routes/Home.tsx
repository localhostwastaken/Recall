import { useState, type FormEvent } from 'react';
import { canonicalUrl, decodeEvidence, runChecks, urlHash, type CheckReport } from '@recall/evidence';
import { arkivPublic, downloadBytes, listByUrl, type Listed } from '@recall/net';
import { getNetConfig } from '../net';
import { MonoValue } from '../ui/MonoValue';
import { StatusBadge, type Status } from '../ui/StatusBadge';

type Capture = Extract<Listed, { kind: 'capture' }>;
type Search = { kind: 'idle' | 'loading' } | { kind: 'error'; message: string } | { kind: 'done'; rows: Capture[]; confirmations: number; truncated: boolean };
type Detail = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'done'; report: CheckReport; row?: Capture; bytes: Uint8Array; from: string };

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function date(seconds: bigint) {
  const d = new Date(Number(seconds) * 1000);
  return Number.isNaN(d.getTime()) ? 'Date unavailable' : d.toLocaleString();
}

// This is a derived reading view, never the archived HTML. Strip active and hidden
// content before parsing, and render only text; no archived markup enters the DOM.
function readingText(body: Uint8Array, contentType?: string): string | null {
  if (!contentType || !/^text\/(html|plain)(?:\s*;|$)/i.test(contentType) || /charset\s*=\s*(?!["']?utf-?8(?:["'\s;]|$))/i.test(contentType)) return null;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return null; }
  if (/^text\/plain/i.test(contentType)) return text;
  const stripped = text.replace(/<(script|style|noscript|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  const doc = new DOMParser().parseFromString(`<body>${stripped.replace(/</g, '&lt;')}</body>`, 'text/html');
  return (doc.body.textContent ?? '').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}

function Check({ title, status, children }: { title: string; status: Status; children: string }) {
  return <li className="evidence-row"><div><h3>{title}</h3><p>{children}</p></div><StatusBadge status={status} /></li>;
}

export function Home() {
  const [url, setUrl] = useState('');
  const [search, setSearch] = useState<Search>({ kind: 'idle' });
  const [detail, setDetail] = useState<Detail | null>(null);
  const cfg = getNetConfig();

  async function find(e?: FormEvent) {
    e?.preventDefault();
    setDetail(null);
    let canonical: string;
    try { canonical = canonicalUrl(url.trim()); } catch (error) { setSearch({ kind: 'error', message: message(error) }); return; }
    setSearch({ kind: 'loading' });
    try {
      const result = await listByUrl(arkivPublic(cfg), urlHash(canonical));
      setSearch({ kind: 'done', rows: result.rows.filter((r): r is Capture => r.kind === 'capture').sort((a, b) => a.signedAt > b.signedAt ? -1 : a.signedAt < b.signedAt ? 1 : 0), confirmations: result.rows.filter(r => r.kind === 'confirmation').length, truncated: result.truncated });
    } catch (error) { setSearch({ kind: 'error', message: message(error) }); }
  }

  async function inspect(bytes: Uint8Array, from: string, row?: Capture) {
    const report = await runChecks(decodeEvidence(bytes), { pinnedWitnesses: cfg.witness.pinned });
    setDetail({ kind: 'done', report, row, bytes, from });
  }

  async function open(row: Capture) {
    setDetail({ kind: 'loading' });
    try {
      const result = await downloadBytes(row.evidenceRef, cfg.swarm.downloadUrls);
      await inspect(result.bytes, result.from, row);
    } catch (error) { setDetail({ kind: 'error', message: message(error) }); }
  }

  async function openFile(file?: File) {
    if (!file) return;
    setDetail({ kind: 'loading' });
    try { await inspect(new Uint8Array(await file.arrayBuffer()), `Local file: ${file.name}`); }
    catch (error) { setDetail({ kind: 'error', message: message(error) }); }
  }

  const report = detail?.kind === 'done' ? detail.report : null;
  const facts = report?.facts;
  const text = facts ? readingText(facts.body, facts.contentType) : null;
  const matched = !!(detail?.kind === 'done' && detail.row && facts && detail.row.urlHash.toLowerCase() === facts.urlHash.toLowerCase() && detail.row.bodySha256.toLowerCase() === facts.bodySha256.toLowerCase() && detail.row.witness.toLowerCase() === facts.witness.toLowerCase());

  return <div className="reader">
    <section className="reader-intro" aria-labelledby="reader-title">
      <div><p className="eyebrow">Recall / public record reader</p><h1 id="reader-title" tabIndex={-1}>Keep the version<br />that mattered.</h1></div>
      <div className="intro-copy"><p>Find a saved public page and examine the evidence behind it.</p><p className="muted">A record can tell you what was saved. Its origin still depends on the witness.</p></div>
    </section>

    <section className="lookup" aria-labelledby="find-heading">
      <div><p className="eyebrow">01 / Find a record</p><h2 id="find-heading">Start with the page address</h2><p>Search the configured Arkiv index for captures of an exact public HTTPS address.</p></div>
      <form onSubmit={find} className="lookup-form"><label htmlFor="source-url">Page URL</label><div className="search-controls"><input id="source-url" className="input" type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.org/notice" /><button className="btn btn-primary" disabled={search.kind === 'loading'}>{search.kind === 'loading' ? 'Searching…' : 'Find captures'}</button></div><p className="field-helper">Search uses the full address, including its path and query. Arkiv records can expire.</p></form>
    </section>

    <div className="reader-grid">
      <section className="results" aria-labelledby="results-heading"><div className="section-heading"><div><p className="eyebrow">02 / Saved versions</p><h2 id="results-heading">Search results</h2></div><span className="network-label">{cfg.arkiv.chain === 'local' ? 'Local network' : 'Arkiv testnet'}</span></div>
        {search.kind === 'idle' && <div className="empty-state"><span className="empty-mark">↗</span><h3>Find a page to begin</h3><p>Enter its address above to look for saved versions. You can also inspect an evidence file below.</p></div>}
        {search.kind === 'loading' && <p className="state-message" role="status">Searching the index for saved records…</p>}
        {search.kind === 'error' && <div className="state-message" role="alert"><h3>Could not search</h3><p>{search.message}</p><button className="link-btn" onClick={() => void find()}>Try again</button></div>}
        {search.kind === 'done' && <><p className="result-note">{search.rows.length} {search.rows.length === 1 ? 'capture' : 'captures'} returned. Times are witness claims; index results are not a complete history.</p>{search.truncated && <p className="warning-text" role="status">The result limit was reached. Some records are hidden.</p>}{search.confirmations > 0 && <p className="result-note">{search.confirmations} additional confirmation {search.confirmations === 1 ? 'record was' : 'records were'} found; confirmation inspection is not available yet.</p>}{search.rows.length === 0 ? <div className="empty-state"><h3>No captures found</h3><p>Check the address or try an evidence file. Missing or expired records may not appear.</p></div> : <ol className="capture-list">{search.rows.map((row, i) => <li key={row.entityKey}><button className="capture-item" onClick={() => void open(row)}><span className="capture-number">{String(i + 1).padStart(2, '0')}</span><span className="capture-summary"><strong>{row.serverName}</strong><span>Witness-claimed time · {date(row.signedAt)}</span><span>HTTP {row.httpStatus} · Index metadata, not yet verified</span></span><span aria-hidden="true">↗</span></button></li>)}</ol>}</>}
      </section>
      <aside className="reader-aside"><p className="eyebrow">Have a file?</p><h2>Check evidence offline</h2><p>Open a Recall evidence JSON file to check its transcript and signature in this browser.</p><label className="file-label" htmlFor="evidence-file">Choose evidence file</label><input id="evidence-file" type="file" accept=".json,application/json" onChange={e => { void openFile(e.target.files?.[0]); e.target.value = ''; }} /><p className="aside-note">Evidence files contain the captured request and response. Treat them as public.</p></aside>
    </div>

    {detail && <section className="detail" aria-labelledby="detail-heading"><div className="section-heading"><div><p className="eyebrow">03 / Inspect the evidence</p><h2 id="detail-heading">Capture details</h2></div><button className="link-btn" onClick={() => setDetail(null)}>Close details</button></div>
      {detail.kind === 'loading' && <p role="status" className="state-message">Retrieving and checking evidence…</p>}
      {detail.kind === 'error' && <div className="state-message" role="alert"><h3>Evidence unavailable</h3><p>{detail.message}</p><p>Check the network or choose another file or capture.</p></div>}
      {detail.kind === 'done' && report && <><div className="detail-layout"><article className="reading"><p className="eyebrow">Saved response / derived text</p>{facts ? <><h3>{facts.serverName}</h3><p className="source-address"><a href={facts.canonicalUrl} target="_blank" rel="noreferrer">{facts.canonicalUrl}</a></p><p className="reading-meta">HTTP {facts.httpStatus} · Witness-claimed {date(facts.signedAt)}</p>{text !== null ? <div className="reading-text">{text || 'No readable text was extracted from this response.'}</div> : <p className="state-message">A readable text view is unavailable for this content type or encoding. The evidence file retains the response bytes.</p>}<p className="reading-note">This text is a simplified view of the response body. Layout, images, scripts and linked resources are not preserved here.</p></> : <div className="state-message"><h3>Reading view unavailable</h3><p>The transcript or signature checks did not establish usable response facts. Review the results before relying on this record.</p></div>}</article>
      <div className="evidence-panel"><p className="eyebrow">What the evidence says</p><h3>Verification results</h3><p className="panel-intro">Each check answers a different question. A passing check does not establish the source on its own.</p><ul className="evidence-list"><Check title="Transcript integrity" status={report.A.status}>{report.A.detail}</Check><Check title="Response structure" status={report.B.status}>{report.B.detail}</Check><Check title="Witness signature" status={report.C.status}>{report.C.detail}</Check><Check title="Source authenticity" status="unavailable">No portable TLS proof is independently verified here. The witness attests to the session and must be trusted.</Check><Check title="On-chain commitment" status="unavailable">An index result is not a checked chain event. Commitment inclusion has not been verified.</Check><Check title="Publisher permission" status="unavailable">Publisher permission is not checked by this reader.</Check></ul></div></div>
      <details className="technical"><summary>Technical details and evidence file</summary><div className="technical-content"><p>Retrieved from: {detail.from}</p>{detail.row && <><p>Index metadata {matched ? 'matches the checked URL hash, body hash and witness.' : 'has not been matched to checked evidence, or differs from it.'} This is not a chain inclusion check.</p><p>Entity key: <MonoValue value={detail.row.entityKey} /></p><p>Swarm reference: <MonoValue value={detail.row.evidenceRef} /></p></>}{facts && <><p>Body SHA-256: <MonoValue value={facts.bodySha256} /></p><p>Witness: <MonoValue value={facts.witness} /></p></>}<button className="btn btn-secondary" onClick={() => { const blob = new Blob([new Uint8Array(detail.bytes)], { type: 'application/json' }); const href = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = href; a.download = 'recall-evidence.json'; a.click(); URL.revokeObjectURL(href); }}>Download evidence JSON</button></div></details><p className="comparison-note">Version comparison is not available yet. A safe, versioned text extraction and comparison flow still needs to be implemented.</p></>}
    </section>}
  </div>;
}
