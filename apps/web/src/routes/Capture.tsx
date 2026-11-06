import { Copy, Download } from 'lucide-react';
import { useState } from 'react';
import type { Hex } from 'viem';
import { ExhibitCard } from '../components/ExhibitCard';
import { Notice } from '../ui/Notice';
import { useToast } from '../ui/Toast';
import { captureTitle } from '../verify/captureTitle';
import { CheckPanel, TechnicalDetails, VerdictLine, WhyWitness } from '../verify/CheckPanel';
import { readFile, peekComparisonFile, type GivenFile } from '../verify/handoff';
import { useVerifiedCapture, type VerifiedCapture } from '../verify/useVerifiedCapture';
import { verdictOf } from '../verify/verify';

/** `recall-<urlHash8>-<signedAt>.json`, from the verified facts when there are any. */
function evidenceFilename(v: VerifiedCapture): string {
  if (v.facts) return `recall-${v.facts.urlHash.slice(2, 10)}-${v.facts.signedAt}.json`;
  return `recall-${(v.record?.evidenceRef ?? '').slice(2, 10)}.json`;
}

function downloadEvidence(v: VerifiedCapture): void {
  if (!v.evidenceBytes) return;
  const url = URL.createObjectURL(new Blob([v.evidenceBytes as BlobPart], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = evidenceFilename(v);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The detail page of one capture record: facts, verdict, checks A to E, actions. */
export function Capture({ entityKey }: { entityKey: Hex }) {
  const toast = useToast();
  // A file given on the home page ("compare a file with captures") arrives here for check D.
  const [file, setFile] = useState<GivenFile | null>(() => peekComparisonFile(entityKey));
  const [fileError, setFileError] = useState<string | undefined>();
  const v = useVerifiedCapture(entityKey, file?.bytes);
  const verdict = verdictOf(v.report, file?.bytes);

  const onFile = async (f: File) => {
    try {
      setFile(await readFile(f));
      setFileError(undefined);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : 'That file could not be read.');
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast('Copied');
    } catch {
      toast('Copy is blocked in this browser. Select the address bar instead.');
    }
  };

  if (v.phase === 'missing') {
    return (
      <>
        <h1 tabIndex={-1}>Capture</h1>
        <Notice
          kind="warn"
          title="Record not found"
          actions={
            <a className="btn btn-secondary" href="#/">
              Go to the home page
            </a>
          }
        >
          No live record has this key. It may have expired, or the link may be wrong. If you have the evidence
          file, drop it on the home page to check it without Recall's servers.
        </Notice>
      </>
    );
  }
  if (v.phase === 'not-capture') {
    return (
      <>
        <h1 tabIndex={-1}>Capture</h1>
        <Notice kind="error" title="This is not a capture record">
          The record with this key is not a Recall capture, so there is nothing to check.
        </Notice>
      </>
    );
  }
  if (v.phase === 'error') {
    return (
      <>
        <h1 tabIndex={-1}>Capture</h1>
        <Notice
          kind="error"
          title="Couldn't reach Arkiv."
          actions={
            <>
              <button type="button" className="btn btn-secondary" onClick={v.retry}>
                Retry
              </button>
              <a className="btn btn-secondary" href="#/settings">
                Check settings
              </a>
            </>
          }
        >
          The record could not be read. Check your connection and the Arkiv endpoint, then try again.
          {v.error ? <TechnicalDetails text={v.error} /> : null}
        </Notice>
      </>
    );
  }

  return (
    <>
      <h1 tabIndex={-1}>{captureTitle(v.facts)}</h1>
      {v.phase === 'loading' ? (
        <p className="muted" role="status">
          Loading the record from Arkiv…
        </p>
      ) : null}
      {v.facts ? <ExhibitCard facts={v.facts} evidenceRef={v.record?.evidenceRef} /> : null}
      <VerdictLine verdict={verdict} />
      {v.report?.mismatch?.length ? (
        <Notice kind="error" title="Record does not match its evidence">
          The Arkiv record and the evidence it points to disagree about the {v.report.mismatch.join(', ')}. The
          evidence may belong to a different capture, so none of its details are shown here as this record's.
        </Notice>
      ) : null}
      <WhyWitness />
      <CheckPanel
        report={v.report}
        storage={v.storage}
        batchId={v.record?.batchId}
        file={file}
        fileError={fileError}
        onFile={onFile}
        onRemoveFile={() => {
          setFile(null);
          setFileError(undefined);
        }}
      />
      <div className="page-actions">
        <button type="button" className="btn btn-secondary" disabled={!v.evidenceBytes} onClick={() => downloadEvidence(v)}>
          <Download size={16} strokeWidth={1.75} aria-hidden="true" />
          Download evidence file
        </button>
        <button type="button" className="btn btn-secondary" onClick={copyLink}>
          <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
          Copy link
        </button>
      </div>
    </>
  );
}
