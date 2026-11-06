import { useState } from 'react';
import { ExhibitCard } from '../components/ExhibitCard';
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
        <p className="lede muted">
          No evidence file is open. <a href="#/">Go to the home page</a> and drop one there. Nothing is uploaded.
        </p>
      </>
    );
  }

  const facts = report?.facts ?? null;
  return (
    <>
      <h1 tabIndex={-1}>{captureTitle(facts)}</h1>
      <p className="muted">
        File: <span className="mono">{dropped.name}</span>
      </p>
      <Notice kind="info" title="Checked offline. A–C ran in your browser; storage (E) was not checked." />
      {facts ? <ExhibitCard facts={facts} /> : null}
      <VerdictLine verdict={verdictOf(report, file?.bytes)} />
      <WhyWitness />
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
    </>
  );
}
