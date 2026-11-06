import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, FileText, Search, Upload } from 'lucide-react';
import { canonicalUrl, decodeEvidence, runChecks, urlHash } from '@recall/evidence';
import { arkivPublic, downloadBytes, listByUrl } from '@recall/net';
import { getNetConfig } from '../net';
import { Notice } from '../ui/Notice';
import { claimedDate, type Capture } from '../reader/evidenceView';
import { CaptureDetail, type Detail } from '../reader/CaptureDetail';
import '../ui/reader.css';

type SearchState =
  | { kind: 'idle' | 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; url: string; rows: Capture[]; confirmations: number; truncated: boolean };

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function Home() {
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [search, setSearch] = useState<SearchState>({ kind: 'idle' });
  const [detail, setDetail] = useState<Detail | null>(null);
  const [filename, setFilename] = useState('');
  const [cfg] = useState(getNetConfig);
  const input = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchSequence = useRef(0);
  const detailSequence = useRef(0);
  const retryDetail = useRef<(() => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  // Ignore late responses after navigation or a more recent selection.
  useEffect(() => () => { searchSequence.current++; detailSequence.current++; }, []);

  async function find(event?: FormEvent) {
    event?.preventDefault();
    let canonical: string;
    try { canonical = canonicalUrl(url.trim()); }
    catch (error) {
      setUrlError(url.trim() ? `Use a public HTTPS address. ${errorMessage(error).replace(/^invalid URL: /, '')}.` : 'Enter the full HTTPS address of the page you want to find.');
      input.current?.focus();
      return;
    }
    setUrlError(null);
    const id = ++searchSequence.current;
    detailSequence.current++;
    setDetail(null);
    setSearch({ kind: 'loading' });
    try {
      const result = await listByUrl(arkivPublic(cfg), urlHash(canonical));
      if (id !== searchSequence.current) return;
      setSearch({
        kind: 'done', url: canonical,
        rows: result.rows.filter((row): row is Capture => row.kind === 'capture')
          .sort((a, b) => a.signedAt > b.signedAt ? -1 : a.signedAt < b.signedAt ? 1 : 0),
        confirmations: result.rows.filter(row => row.kind === 'confirmation').length,
        truncated: result.truncated,
      });
    } catch (error) {
      if (id === searchSequence.current) setSearch({ kind: 'error', message: errorMessage(error) });
    }
  }

  async function loadEvidence(source: { name: string; row?: Capture }, getBytes: () => Promise<{ bytes: Uint8Array; from: string }>) {
    const id = ++detailSequence.current;
    retryDetail.current = () => { void loadEvidence(source, getBytes); };
    setDetail({ id, kind: 'loading', ...source });
    try {
      const { bytes, from } = await getBytes();
      const report = await runChecks(decodeEvidence(bytes), { pinnedWitnesses: cfg.witness.pinned });
      if (id === detailSequence.current) setDetail({ id, kind: 'done', ...source, bytes, from, report });
    } catch (error) {
      if (id === detailSequence.current) setDetail({ id, kind: 'error', ...source, message: errorMessage(error) });
    }
  }

  function openRow(row: Capture, trigger: HTMLButtonElement) {
    returnFocus.current = trigger;
    void loadEvidence({ name: `Index record: ${row.canonicalUrl || row.serverName}`, row }, () => downloadBytes(row.evidenceRef, cfg.swarm.downloadUrls));
  }

  function openFile(file?: File) {
    if (!file) return;
    setFilename(file.name);
    returnFocus.current = fileInput.current;
    void loadEvidence({ name: `Local file: ${file.name}` }, async () => ({ bytes: new Uint8Array(await file.arrayBuffer()), from: `Local file: ${file.name}` }));
  }

  function closeDetail() {
    detailSequence.current++;
    setDetail(null);
    returnFocus.current?.focus();
  }

  return <div className="reader">
    <header className="reader-intro">
      <div><p className="overline">The Recall reader</p><h1 tabIndex={-1}>Come back to the page.<br /><span>Get the full picture.</span></h1><p>Find a saved version or open an evidence file. Read the response, then see what each check tells you.</p></div>
      <div className="reader-context"><span className="environment-label">{cfg.arkiv.chain === 'local' ? 'Local development network' : 'Arkiv testnet'}</span><p>No wallet needed to read.</p></div>
    </header>

    <section className="reader-entry" aria-label="Find or open evidence">
      <form className="lookup-form" onSubmit={find} noValidate>
        <h2><span className="entry-number" aria-hidden="true">01</span> Find a saved page</h2>
        <p className="entry-description">Start with the address of the original page.</p>
        <label htmlFor="source-url" className="field-label">Page address</label>
        <div className="search-controls"><input ref={input} id="source-url" className="input" type="url" inputMode="url" required autoComplete="url" spellCheck={false} value={url} onChange={e => { setUrl(e.target.value); setUrlError(null); }} placeholder="https://example.org/notice" aria-invalid={urlError ? true : undefined} aria-describedby={urlError ? 'url-error url-help' : 'url-help'} /><button className="btn btn-primary" disabled={search.kind === 'loading'} aria-busy={search.kind === 'loading'}><Search size={18} aria-hidden="true" />{search.kind === 'loading' ? 'Searching…' : 'Find captures'}</button></div>
        {urlError && <p id="url-error" className="field-error" role="alert">{urlError}</p>}
        <p id="url-help" className="field-helper">Use the full HTTPS address, including its path and query.</p>
      </form>
      <div className="file-entry"><h2><span className="entry-number" aria-hidden="true">02</span> Open an evidence file</h2><p className="entry-description">Check a Recall JSON file locally in this browser.</p><label className="file-picker"><Upload size={18} aria-hidden="true" /><span>Choose evidence JSON</span><input ref={fileInput} type="file" accept=".json,application/json" aria-label="Choose evidence JSON file" onChange={e => { openFile(e.target.files?.[0]); e.target.value = ''; }} /></label><p className="field-helper file-name">{filename ? `Selected: ${filename}` : 'The file is read locally; it is not uploaded.'}</p></div>
    </section>

    <p className="visually-hidden" role="status">{search.kind === 'loading' ? 'Looking up the page in the index.' : search.kind === 'done' ? `${search.rows.length} captures returned.${search.truncated ? ' The results are partial.' : ''}` : ''}</p>
    <section className="results" aria-labelledby="results-heading" aria-busy={search.kind === 'loading'}>
      <div className="section-heading"><div><p className="overline">From the index</p><h2 id="results-heading">Available records</h2></div>{search.kind === 'done' && <span className="results-count">{search.rows.length} {search.rows.length === 1 ? 'capture' : 'captures'} returned</span>}</div>
      {search.kind === 'idle' && <div className="reader-empty"><FileText size={34} strokeWidth={1.25} aria-hidden="true" /><div><h3>Your reference starts here.</h3><p>Search for a page to see its available captures, or choose an evidence file above.</p>{cfg.arkiv.chain === 'local' && <p className="empty-context">Online lookup needs the local development network. Evidence files can be checked without it.</p>}</div></div>}
      {search.kind === 'loading' && <div className="results-loading"><p>Looking up the page in the index…</p><div className="result-skeletons" aria-hidden="true">{[0, 1].map(n => <div key={n}><span /><span /></div>)}</div></div>}
      {search.kind === 'error' && <div className="results-feedback"><Notice kind="error" title="The index could not be reached" actions={<button type="button" className="btn btn-secondary" onClick={() => void find()}>Retry search</button>}>Check your connection{cfg.arkiv.chain === 'local' ? ' and that the local development network is running' : ' or try again later'}. You can still open a local evidence file.<details className="error-details"><summary>Technical details</summary><p>{search.message}</p></details></Notice></div>}
      {search.kind === 'done' && <>
        <p className="results-source">Results for <span>{search.url}</span></p>
        <p className="results-guidance">Listed records are index metadata. Open a capture to retrieve its evidence and run checks. Sorted by witness-claimed time, newest first.</p>
        {search.truncated && <Notice kind="warn" title="Some records are not shown">The result limit was reached. This list is a partial view of the index.</Notice>}
        {search.confirmations > 0 && <p className="confirmation-note">The index also returned {search.confirmations} confirmation {search.confirmations === 1 ? 'record' : 'records'}. Confirmation inspection is not available yet.</p>}
        {search.rows.length === 0 ? <div className="reader-empty"><FileText size={34} strokeWidth={1.25} aria-hidden="true" /><div><h3>No captures found for this address.</h3><p>Check the exact URL or open an evidence file. Missing or expired records may not appear in the index.</p></div></div> : <ol className="capture-list">{search.rows.map((row, i) => <li key={row.entityKey}>
          <button className="capture-item" type="button" onClick={e => openRow(row, e.currentTarget)} aria-expanded={detail?.row?.entityKey === row.entityKey}>
            <span className="capture-number">{String(i + 1).padStart(2, '0')}</span>
            <span className="capture-summary"><strong>{row.serverName || 'Unnamed source'}</strong><span className="capture-url">{row.canonicalUrl}</span><span className="capture-meta">Witness-claimed {claimedDate(row.signedAt)} <span aria-hidden="true">·</span> HTTP {row.httpStatus}</span></span>
            <span className="capture-action"><span>Inspect record</span><ArrowRight size={20} aria-hidden="true" /><small>Not yet verified</small></span>
          </button>
        </li>)}</ol>}
        <p className="history-note">This is not a complete history. Records can expire, be missing, or be unavailable through the configured index.</p>
      </>}
    </section>

    {detail && <CaptureDetail key={detail.id} detail={detail} onClose={closeDetail} onRetry={() => retryDetail.current?.()} />}

    <details className="reader-help"><summary>What can this reader establish?</summary><div><p>It checks transcript hashes, response structure and the witness signature. A valid signature can belong to an unknown witness.</p><p>The source and capture time remain witness claims. Portable TLS source proof, chain inclusion and publisher permission are not independently checked here. Real version comparison is not yet available.</p></div></details>
  </div>;
}
