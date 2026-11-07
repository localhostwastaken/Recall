import { Download, History } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Hex } from 'viem';
import { repoOf } from '../attachments/git';
import { useRepoSnapshot } from '../attachments/useRepoSnapshot';
import { ExhibitCard } from '../components/ExhibitCard';
import { CheckItYourself } from '../components/OutsideLinks';
import { KeepAlive } from '../components/KeepAlive';
import { Preview } from '../components/Preview';
import { RepoSnapshot } from '../components/RepoSnapshot';
import { evidenceFileName, saveBytes } from '../download';
import { recordLinks } from '../explorers';
import { getNetConfig } from '../net';
import { CopyLinkButton } from '../ui/CopyLinkButton';
import { Notice } from '../ui/Notice';
import { captureTitle } from '../verify/captureTitle';
import { CheckPanel, TechnicalDetails, VerdictLine, WhyWitness } from '../verify/CheckPanel';
import { readFile, peekComparisonFile, type GivenFile } from '../verify/handoff';
import { useVerifiedCapture, type VerifiedCapture } from '../verify/useVerifiedCapture';
import { isVerifiedReport, verdictOf } from '../verify/verify';
import { ConfirmationRecord } from './Confirmation';

/** `recall-<urlHash8>-<signedAt>.json`, from the verified facts when there are any. */
function evidenceFilename(v: VerifiedCapture): string {
  if (v.facts) return evidenceFileName(v.facts.urlHash, v.facts.signedAt);
  return `recall-${(v.record?.evidenceRef ?? '').slice(2, 10)}.json`;
}

function downloadEvidence(v: VerifiedCapture): void {
  if (v.evidenceBytes) saveBytes(v.evidenceBytes, evidenceFilename(v), 'application/json');
}

/** The detail page of one capture record: facts, verdict, checks A to E, actions. */
export function Capture({ entityKey }: { entityKey: Hex }) {
  // A file given on the home page ("compare a file with captures") arrives here for check D.
  const [file, setFile] = useState<GivenFile | null>(() => peekComparisonFile(entityKey));
  const [fileError, setFileError] = useState<string | undefined>();
  const v = useVerifiedCapture(entityKey, file?.bytes);
  const verdict = verdictOf(v.report, file?.bytes);
  // R46: a capture of GitHub's branch API names a commit; its code snapshot is checked only
  // against facts whose checks passed and that agree with their record.
  const verified = v.facts && isVerifiedReport(v.report) && !v.report.mismatch?.length ? v.facts : null;
  const snapshots = useRepoSnapshot(v.record?.entityKey ?? null, verified, v.record?.creator ?? null);
  const branch = repoOf(v.facts);
  // "Check it yourself": the same record (and its evidence file and publisher) in the outside tools.
  const recordKey = v.record?.entityKey;
  const recordOwner = v.record?.creator;
  const evidenceRef = v.record?.evidenceRef;
  const links = useMemo(
    () => (recordKey ? recordLinks(getNetConfig(), { entityKey: recordKey, evidenceRef, owner: recordOwner }) : []),
    [recordKey, recordOwner, evidenceRef],
  );

  const onFile = async (f: File) => {
    try {
      setFile(await readFile(f));
      setFileError(undefined);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : 'That file could not be read.');
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
    // A confirmation record has its own small page; anything else is not ours.
    return (
      <ConfirmationRecord
        entityKey={entityKey}
        fallback={
          <>
            <h1 tabIndex={-1}>Capture</h1>
            <Notice kind="error" title="This is not a capture record">
              The record with this key is not a Recall capture, so there is nothing to check.
            </Notice>
          </>
        }
      />
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
    <div className="record">
      {branch && v.report?.C.status === 'pass' ? (
        <>
          <h1 tabIndex={-1}>
            GitHub branch {branch.owner}/{branch.repo}@{branch.branch}
          </h1>
          <p className="muted mono capture-subtitle">{v.facts?.canonicalUrl}</p>
        </>
      ) : (
        <h1 tabIndex={-1}>{captureTitle(v.facts, v.report?.C.status)}</h1>
      )}
      {/* The record: the verdict, what the witness saw, the checks, the preview. Desktop keeps the
          actions in a side panel beside it; phones show the panel after the checks. */}
      <div className="record-main">
        {v.phase === 'loading' ? (
          <p className="muted" role="status">
            Loading the record from Arkiv…
          </p>
        ) : null}
        <VerdictLine verdict={verdict} />
        {v.report?.mismatch?.length ? (
          <Notice kind="error" title="Record does not match its evidence">
            The Arkiv record and the evidence it points to disagree about the {v.report.mismatch.join(', ')}. The
            evidence may belong to a different capture, so none of its details are shown here as this record's.
          </Notice>
        ) : null}
        {v.facts ? (
          <ExhibitCard facts={v.facts} evidenceRef={v.record?.evidenceRef} unverified={v.report?.C.status !== 'pass'} />
        ) : null}
        <RepoSnapshot snapshots={snapshots} />
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
        {v.facts ? (
          <Preview
            facts={v.facts}
            fallback={
              <button type="button" className="btn btn-secondary" disabled={!v.evidenceBytes} onClick={() => downloadEvidence(v)}>
                <Download size={16} strokeWidth={1.75} aria-hidden="true" />
                Download evidence file
              </button>
            }
          />
        ) : null}
      </div>
      <aside className="record-side" aria-label="Capture actions">
        <div className="record-panel">
          <div className="page-actions">
            {v.facts ? (
              <a className="btn btn-primary" href={`#/u/${v.facts.urlHash}`}>
                <History size={16} strokeWidth={1.75} aria-hidden="true" />
                View timeline
              </a>
            ) : null}
            <button type="button" className="btn btn-secondary" disabled={!v.evidenceBytes} onClick={() => downloadEvidence(v)}>
              <Download size={16} strokeWidth={1.75} aria-hidden="true" />
              Download evidence file
            </button>
            {v.record && isVerifiedReport(v.report) ? (
              <KeepAlive
                target={{ entityKeys: [v.record.entityKey], batchId: v.record.batchId }}
                onChanged={v.refreshStorage}
              />
            ) : null}
            <CopyLinkButton />
          </div>
          {v.report && !isVerifiedReport(v.report) ? (
            <p className="ka-hint">Keep-alive is offered only for captures whose checks A to C passed.</p>
          ) : null}
        </div>
        {links.length > 0 ? (
          <div className="record-panel">
            <CheckItYourself links={links} />
          </div>
        ) : null}
        <WhyWitness />
      </aside>
    </div>
  );
}
