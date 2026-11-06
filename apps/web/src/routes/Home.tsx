import { canonicalPageUrl, decodeEvidence, urlHash } from '@recall/evidence';
import { arkivPublic, listByUrl } from '@recall/net';
import { useEffect, useState } from 'react';
import { sha256 } from 'viem';
import { downloadEvidence } from '../download';
import { errorText } from '../errors';
import { getNetConfig } from '../net';
import { DropZone } from '../ui/DropZone';
import { Field } from '../ui/Field';
import { Notice } from '../ui/Notice';
import { clearHandoff, readFile, setComparisonFile, setEvidenceFile, type GivenFile } from '../verify/handoff';
import { TechnicalDetails } from '../verify/CheckPanel';
import { verifyRecordEvidence } from '../verify/useVerifiedCapture';
import { verdictOf } from '../verify/verify';

const ADDRESS_ERROR = 'Enter a full address starting with https://';

/**
 * The canonical form of what the person typed, or null when it is not a usable https address. It
 * is parsed the way the extension parses the address it captures, so a search finds the capture.
 */
function parseAddress(raw: string): { canonical: string; hash: ReturnType<typeof urlHash> } | null {
  try {
    const canonical = canonicalPageUrl(raw);
    return { canonical, hash: urlHash(canonical) };
  } catch {
    return null;
  }
}

function Search() {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const check = () => {
    const ok = value.trim() !== '' && parseAddress(value) !== null;
    setError(ok ? undefined : ADDRESS_ERROR);
    return ok;
  };
  return (
    <section className="stack" aria-labelledby="search-title">
      <h2 className="section-title" id="search-title">
        Find captures of a page
      </h2>
      <form
        className="search-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const ok = check();
          const parsed = parseAddress(value);
          if (ok && parsed) window.location.hash = `#/u/${parsed.hash}`;
        }}
      >
        <Field
          label="Page address"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://example.org/notice"
          value={value}
          error={error}
          reserveError
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => value !== '' && check()}
        />
        <button type="submit" className="btn btn-primary">
          Show captures
        </button>
      </form>
    </section>
  );
}

function VerifyEvidence() {
  const [error, setError] = useState<string | undefined>();
  return (
    <section className="stack" aria-labelledby="verify-title">
      <h2 className="section-title" id="verify-title">
        Verify an evidence file
      </h2>
      <DropZone
        title="Drop an evidence file to verify"
        hint="Works offline. The file never leaves your browser."
        inputLabel="Evidence file"
        accept=".json,application/json"
        error={error}
        onFile={async (f) => {
          try {
            const given = await readFile(f);
            decodeEvidence(given.bytes); // refuses anything that is not a Recall evidence file
            setError(undefined);
            setEvidenceFile(given);
            window.location.hash = '#/file';
          } catch (e) {
            setError(
              e instanceof Error && /too large/.test(e.message)
                ? e.message
                : "This isn't a Recall evidence file. Choose the .json file you downloaded from Recall.",
            );
          }
        }}
      />
    </section>
  );
}

/** Records to verify, newest first, before giving up: junk records can share a content hash. */
const MAX_CANDIDATES = 5;

type Found = { kind: 'none' } | { kind: 'unverified' } | { kind: 'error'; message: string };

/**
 * "Raw file plus its address": looks the address up on Arkiv and opens the capture whose
 * indexed content hash equals the file's. The index is only used to pick the candidate; the
 * capture page then verifies the evidence and runs check D on the verified bytes.
 */
function CompareFile() {
  const [address, setAddress] = useState('');
  const [addressError, setAddressError] = useState<string | undefined>();
  const [file, setFile] = useState<GivenFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<Found | null>(null);

  const run = async (given: GivenFile, raw: string) => {
    const parsed = parseAddress(raw);
    if (!raw.trim() || !parsed) {
      setAddressError(ADDRESS_ERROR);
      return;
    }
    setAddressError(undefined);
    setFound(null);
    setBusy(true);
    try {
      const cfg = getNetConfig();
      const want = sha256(given.bytes).toLowerCase();
      const { rows } = await listByUrl(arkivPublic(cfg), parsed.hash);
      const matches = rows
        .flatMap((r) => (r.kind === 'capture' && r.bodySha256.toLowerCase() === want ? [r] : []))
        .sort((a, b) => (a.signedAt === b.signedAt ? 0 : a.signedAt < b.signedAt ? 1 : -1));
      if (matches.length === 0) {
        setFound({ kind: 'none' });
        return;
      }
      // The index only proposes candidates. Anyone can publish a record claiming any content
      // hash, so open the first one whose evidence really verifies and holds this exact file.
      for (const m of matches.slice(0, MAX_CANDIDATES)) {
        try {
          const { bytes } = await downloadEvidence(cfg, m);
          const report = await verifyRecordEvidence(m, bytes, given.bytes);
          if (report.D?.status === 'pass' && verdictOf(report).kind !== 'fail') {
            setComparisonFile(m.entityKey, given);
            window.location.hash = `#/c/${m.entityKey}`;
            return;
          }
        } catch {
          /* this record's evidence is unavailable: try the next one */
        }
      }
      setFound({ kind: 'unverified' });
    } catch (e) {
      setFound({ kind: 'error', message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="compare-details">
      <summary>Compare a file with captures</summary>
      <div className="stack">
        <p className="muted">
          Have the page itself, such as a saved HTML or PDF file? Enter the address it came from and choose the
          file. Recall looks for a capture with exactly the same bytes, and the file never leaves your browser.
        </p>
        <Field
          label="Address the file came from"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://example.org/notice"
          value={address}
          error={addressError}
          reserveError
          onChange={(e) => setAddress(e.target.value)}
        />
        <DropZone
          compact
          title="Drop the file here"
          hint="Any file type. It is only hashed in your browser."
          inputLabel="File to compare"
          onFile={async (f) => {
            let given: GivenFile;
            try {
              given = await readFile(f);
            } catch (e) {
              setFound({ kind: 'error', message: e instanceof Error ? e.message : 'That file could not be read.' });
              return;
            }
            setFile(given);
            await run(given, address);
          }}
        />
        {file ? (
          <p className="file-line">
            <span>
              File: <span className="mono">{file.name}</span>
            </span>
            <button type="button" className="btn btn-secondary btn-compact" disabled={busy} onClick={() => void run(file, address)}>
              {busy ? 'Looking…' : 'Find matching capture'}
            </button>
          </p>
        ) : null}
        {found?.kind === 'none' ? (
          <Notice kind="info" title="No capture of this address has these exact bytes.">
            Only records on Arkiv for this address were searched. To check one capture directly, open its link or
            drop its evidence file above.
          </Notice>
        ) : null}
        {found?.kind === 'unverified' ? (
          <Notice kind="warn" title="Records were found, but none passed their checks.">
            Records for this address claim to hold these bytes, but their evidence was unavailable or did not check
            out, so none is opened. Open a record's link to see which check failed.
          </Notice>
        ) : null}
        {found?.kind === 'error' ? (
          <Notice kind="error" title="Couldn't search for captures.">
            The search could not finish. Check your connection and the Arkiv endpoint, then try again.
            <TechnicalDetails text={found.message} />
          </Notice>
        ) : null}
      </div>
    </details>
  );
}

export function Home() {
  // The home page starts fresh: files from an earlier visit are forgotten.
  useEffect(() => clearHandoff(), []);
  return (
    <>
      <h1 tabIndex={-1}>Recall</h1>
      <p className="lede muted">Prove what a web page said, even after it changes.</p>
      <Search />
      <VerifyEvidence />
      <CompareFile />
    </>
  );
}
