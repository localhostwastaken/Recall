import { FileSearch } from 'lucide-react';
import { useState } from 'react';
import { ExhibitCard } from '../components/ExhibitCard';
import { Preview } from '../components/Preview';
import { Notice } from '../ui/Notice';
import { captureTitle } from '../verify/captureTitle';
import { CheckPanel, VerdictLine, WhyWitness } from '../verify/CheckPanel';
import { peekEvidenceFile, readFile, type GivenFile } from '../verify/handoff';
import { useVerifiedEvidenceFile } from '../verify/useVerifiedCapture';
import { verdictOf } from '../verify/verify';

/**
 * An evidence file dropped on the home page, checked entirely in the browser: A to C (and D)
 * need no network. Storage (E) is "Not checked".
 */
export function FileCheck() {
  const [dropped] = useState(peekEvidenceFile);
  const [file, setFile] = useState<GivenFile | null>(null);
  const [fileError, setFileError] = useState<string | undefined>();
  const report = useVerifiedEvidenceFile(dropped?.bytes ?? null, file?.bytes);

  if (!dropped) {
    return (
      <>
        <h1 tabIndex={-1}>Evidence file</h1>
        <div className="record-empty">
          <FileSearch size={32} strokeWidth={1.75} aria-hidden="true" />
          <p className="lede muted">
            No evidence file is open. <a href="#/">Go to the home page</a> and drop one there. Nothing is uploaded.
          </p>
        </div>
      </>
    );
  }

  const facts = report?.facts ?? null;
  return (
    <div className="record record-file">
      <h1 tabIndex={-1}>{captureTitle(facts, report?.C.status)}</h1>
      <div className="record-main">
        <VerdictLine verdict={verdictOf(report, file?.bytes)} />
        {facts ? <ExhibitCard facts={facts} unverified={report?.C.status !== 'pass'} /> : null}
        <CheckPanel
          report={report}
          storage="offline"
          file={file}
          fileError={fileError}
          onFile={async (f) => {
            try {
              setFile(await readFile(f));
              setFileError(undefined);
            } catch (e) {
              setFileError(e instanceof Error ? e.message : 'That file could not be read.');
            }
          }}
          onRemoveFile={() => {
            setFile(null);
            setFileError(undefined);
          }}
        />
        {facts ? <Preview facts={facts} /> : null}
      </div>
      {/* Which file this is and how it was checked: beside the record on a desktop, under the title on a phone. */}
      <aside className="record-side" aria-label="Evidence file">
        <div className="record-panel">
          <p className="muted">
            File: <span className="mono">{dropped.name}</span>
          </p>
          <Notice kind="info" title="Checked offline. A–C ran in your browser; storage (E) was not checked." />
        </div>
        <WhyWitness />
      </aside>
    </div>
  );
}
