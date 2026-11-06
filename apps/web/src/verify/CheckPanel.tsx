import { decodeEvidence, type CheckResult } from '@recall/evidence';
import { isFreeBatch } from '@recall/net';
import { ChevronDown, CircleCheck, CircleDashed, CircleX, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { sha256, type Address } from 'viem';
import { DEFAULT_WITNESS_LABEL } from '../defaults';
import { formatBytes, formatTtl } from '../format';
import { CheckRow } from '../ui/CheckRow';
import { DropZone } from '../ui/DropZone';
import { MonoValue, middle } from '../ui/MonoValue';
import { STATUS_WORD, type Status } from '../ui/StatusBadge';
import { isDefaultWitness, trustedWitness } from '../witness';
import type { GivenFile } from './handoff';
import type { StorageInfo, StorageState } from './useVerifiedCapture';
import type { Verdict, VerdictKind, VerifiedReport } from './verify';

const VERDICT_ICONS: Record<VerdictKind, LucideIcon> = {
  pass: CircleCheck,
  fail: CircleX,
  warn: TriangleAlert,
  na: CircleDashed,
  pending: LoaderCircle,
};

/**
 * The verdict line. Icon + words + colour; green only for "Checks passed", which the caller
 * gets from `verdictOf` and which needs A to C (and D when given) to have run and passed.
 */
export function VerdictLine({ verdict }: { verdict: Verdict }) {
  const Icon = VERDICT_ICONS[verdict.kind];
  return (
    <p
      className={`verdict verdict-${verdict.kind}`}
      role={verdict.kind === 'fail' ? 'alert' : 'status'}
      data-verdict={verdict.kind}
    >
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" className={verdict.kind === 'pending' ? 'spin' : undefined} />
      <span>{verdict.text}</span>
    </p>
  );
}

/** "Why trust one witness?" (design brief 5): once per surface, with the honest explainer. */
export function WhyWitness() {
  return (
    <details className="why-witness">
      <summary>Why trust one witness?</summary>
      <p>Recall uses one witness. If it was compromised or worked with the site, it could sign false bytes.</p>
    </details>
  );
}

/** A raw error text (it can hold URLs or keys later), kept out of the way until asked for. */
export function TechnicalDetails({ text }: { text: string }) {
  return (
    <details className="tech-details">
      <summary>Technical details</summary>
      <p className="mono">{text}</p>
    </details>
  );
}

type RowModel = { status: Status; result: ReactNode; how?: ReactNode };

const PENDING = (text: string): RowModel => ({ status: 'pending', result: text });
const asStatus = (r: CheckResult): Status => r.status;
const how = (...lines: ReactNode[]) => (
  <>
    {lines.map((l, i) => (
      <p key={i}>{l}</p>
    ))}
  </>
);

function rowA(report: VerifiedReport | null): RowModel {
  if (!report) return PENDING('Comparing the evidence with the hashes the witness signed.');
  const { A } = report;
  const detail = how(`Result: ${A.detail}`, report.technical ? <TechnicalDetails text={report.technical} /> : null);
  switch (A.status) {
    case 'pass':
      return { status: 'pass', result: 'The evidence matches the hashes the witness signed.', how: detail };
    case 'fail':
      return {
        status: 'fail',
        result: report.malformed ? `The evidence file is malformed: ${report.malformed}` : 'The evidence was changed after signing.',
        how: detail,
      };
    default:
      return { status: asStatus(A), result: A.detail, how: detail };
  }
}

function rowB(report: VerifiedReport | null): RowModel {
  if (!report) return PENDING('Reading the request and the response.');
  const { B, facts } = report;
  const body = facts ? <MonoValue value={facts.bodySha256} /> : null;
  const detail = how(`Result: ${B.detail}`, body ? <>Body sha256: {body}</> : null);
  switch (B.status) {
    case 'pass':
      return {
        status: 'pass',
        result: facts
          ? `GET ${facts.canonicalUrl} to ${facts.serverName}, no cookies sent, complete response (HTTP ${facts.httpStatus}).`
          : 'The request and the response are well-formed.',
        how: detail,
      };
    case 'warn':
      return { status: 'warn', result: `The witness saw HTTP ${B.detail}, not a normal page.`, how: detail };
    case 'fail':
      return { status: 'fail', result: "The request doesn't match the address claimed.", how: detail };
    default:
      return { status: asStatus(B), result: B.detail, how: detail };
  }
}

/**
 * The pass line of check C. The built-in witness reads as in the design brief. A witness the
 * person (or their browser's settings) added reads differently, so it is never taken for the
 * built-in one: it still passes, but says where the trust came from (R38).
 */
function signedByTrusted(signer: Address | undefined): string {
  if (!signer) return 'Signed by a witness in your trusted list.';
  const w = trustedWitness(signer);
  if (w && !isDefaultWitness(signer)) return `Signed by a witness added in this browser: ${w.label} (${middle(signer)}).`;
  return `Signed by ${w ? DEFAULT_WITNESS_LABEL : 'a pinned witness'} (${middle(signer)}), which is in your trusted list.`;
}

function rowC(report: VerifiedReport | null): RowModel {
  if (!report) return PENDING('Checking the witness signature.');
  const { C, signer } = report;
  const detail = how(`Result: ${C.detail}`, signer ? <>Signer: <MonoValue value={signer} /></> : null);
  switch (C.status) {
    case 'pass':
      return { status: 'pass', result: signedByTrusted(signer), how: detail };
    case 'warn':
      return {
        status: 'warn',
        result: (
          <>
            Signed by an unknown witness <span className="mono">{signer}</span>. Trust it only if you trust its operator.{' '}
            <a href="#/settings">Witness settings</a>
          </>
        ),
        how: detail,
      };
    case 'fail':
      return { status: 'fail', result: 'The signature is invalid.', how: detail };
    default:
      return { status: asStatus(C), result: C.detail, how: detail };
  }
}

/** Files larger than this are never sniffed as evidence (an evidence file is a few KB). */
const EVIDENCE_SNIFF_MAX = 2 * 1024 * 1024;
export const EVIDENCE_IN_D =
  "That's a Recall evidence file, not a copy of the page, so there is nothing to compare here. To check an evidence file, drop it on the Home page.";

/** True when the bytes parse as a Recall evidence file. */
export function looksLikeEvidence(bytes: Uint8Array): boolean {
  try {
    decodeEvidence(bytes);
    return true;
  } catch {
    return false;
  }
}

function rowD(report: VerifiedReport | null, file: GivenFile | null): RowModel {
  const fileLine = file ? (
    <>
      Your file: <span className="mono">{file.name}</span> ({formatBytes(file.bytes.length)}), sha256 <MonoValue value={sha256(file.bytes)} />
    </>
  ) : null;
  if (!file) {
    return { status: 'unavailable', result: 'No file given. Drop a file to compare.' };
  }
  // A report speaks about D only for the file it was computed for. After the file changed it
  // is "Checking…" again, never the previous file's answer.
  if (!report || report.forFile !== file.bytes) {
    return { ...PENDING('Comparing your file with the captured bytes.'), how: how(fileLine) };
  }
  if (!report.D) {
    return { status: 'unavailable', result: 'Not compared: the capture could not be checked.', how: how(fileLine) };
  }
  const { D, facts } = report;
  const detail = how(`Result: ${D.detail}`, fileLine);
  switch (D.status) {
    case 'pass':
      return {
        status: 'pass',
        result: `Your file matches this capture (sha256 ${(facts?.bodySha256 ?? sha256(file.bytes)).slice(2, 6)}…).`,
        how: detail,
      };
    case 'fail':
      return { status: 'fail', result: 'Your file is different from this capture.', how: detail };
    default:
      return { status: asStatus(D), result: D.detail, how: detail };
  }
}

function rowE(storage: StorageState | 'offline', batchId?: string): RowModel {
  if (storage === 'offline') {
    return {
      status: 'unavailable',
      result: 'Storage status not checked (offline or RPC unreachable).',
    };
  }
  if (storage.phase === 'pending') return PENDING('Reading the storage status.');
  const { check, info } = storage;
  return { status: asStatus(check), result: check.detail, how: storageHow(check, info, batchId) };
}

function storageHow(check: CheckResult, info: StorageInfo | null, batchId?: string): ReactNode {
  const free = batchId !== undefined && isFreeBatch(batchId);
  return how(
    'Read live: the Swarm storage batch on Gnosis and the Arkiv record expiry. This check does not count toward the verdict.',
    free ? "Storage batch: none (the gateway's free storage)" : batchId ? <>Storage batch: <MonoValue value={batchId} /></> : null,
    free
      ? null
      : info
        ? `Swarm time left: ${info.ttlSeconds === null ? 'none (expired or not found)' : formatTtl(info.ttlSeconds)}`
        : check.detail,
    info ? `Arkiv record expires at block ${info.arkivExpiresAtBlock}` : null,
  );
}

/**
 * Checks A to E. `report` is null while the evidence is still being fetched and checked:
 * every row is then "Checking…" and none is green. `storage` is 'offline' for a dropped
 * evidence file (check E needs the network and is "Not checked").
 */
export function CheckPanel({
  report,
  storage,
  batchId,
  file,
  fileError,
  onFile,
  onRemoveFile,
}: {
  report: VerifiedReport | null;
  storage: StorageState | 'offline';
  batchId?: string;
  file: GivenFile | null;
  fileError?: string;
  onFile: (file: File) => void | Promise<void>;
  onRemoveFile: () => void;
}) {
  // D compares a copy of the page. A Recall evidence file dropped here (the record page offers
  // one for download) is turned away with a pointer to where it can be checked, instead of
  // showing a red "different" that reads as a failed capture.
  const [evidenceDropped, setEvidenceDropped] = useState(false);
  const compareFile = async (f: File) => {
    if (f.size <= EVIDENCE_SNIFF_MAX && looksLikeEvidence(new Uint8Array(await f.arrayBuffer()))) {
      setEvidenceDropped(true);
      return;
    }
    setEvidenceDropped(false);
    await onFile(f);
  };
  const rows: [string, string, RowModel, ReactNode?][] = [
    ['A', 'Bytes match the signed hashes', rowA(report)],
    ['B', 'Request and response are well-formed', rowB(report)],
    ['C', 'Signed by a trusted witness', rowC(report)],
    [
      'D',
      'Your file matches',
      rowD(report, file),
      <div key="d" className="compare">
        {file ? (
          <p className="file-line">
            <span>
              File to compare: <span className="mono">{file.name}</span> ({formatBytes(file.bytes.length)})
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              onClick={() => {
                setEvidenceDropped(false);
                onRemoveFile();
              }}
            >
              Remove file
            </button>
          </p>
        ) : null}
        <DropZone
          compact
          title={file ? 'Compare with a different file' : 'Drop a file to compare'}
          hint="A saved copy of the page, for example its .html. The file stays in your browser."
          inputLabel="File to compare"
          onFile={compareFile}
          error={evidenceDropped ? EVIDENCE_IN_D : fileError}
        />
      </div>,
    ],
    ['E', 'Storage', rowE(storage, batchId)],
  ];
  return <ChecksDisclosure rows={rows} />;
}

const PILL_ICONS: Record<Status, LucideIcon> = {
  pass: CircleCheck,
  fail: CircleX,
  warn: TriangleAlert,
  unavailable: CircleDashed,
  pending: LoaderCircle,
};

/**
 * Progressive disclosure for check rows: a heading, one small mark per check, and the rows
 * (`children`) behind "Show details". A failed or warning check opens the rows by itself (and
 * opens them again if a later answer fails), so a problem is never hidden behind the toggle.
 */
export function ChecksCard({
  title,
  titleId,
  checks,
  className,
  children,
}: {
  title: string;
  titleId: string;
  checks: { letter: string; status: Status }[];
  className?: string;
  children: ReactNode;
}) {
  const attention = checks.some((c) => c.status === 'fail' || c.status === 'warn');
  const [chosen, setChosen] = useState<boolean | null>(null);
  useEffect(() => {
    if (attention) setChosen(null);
  }, [attention]);
  const open = chosen ?? attention;
  const bodyId = useId();
  return (
    <section aria-labelledby={titleId} className={`checks-panel${className ? ` ${className}` : ''}`}>
      <div className="checks-summary-row">
        <h2 className="section-title" id={titleId}>
          {title}
        </h2>
        <ul className="check-pills" aria-label="Results">
          {checks.map(({ letter, status }) => {
            const Icon = PILL_ICONS[status];
            return (
              <li key={letter} className={`check-pill check-pill-${status}`} data-pill={letter}>
                <Icon size={16} strokeWidth={2} aria-hidden="true" className={status === 'pending' ? 'spin' : undefined} />
                <span aria-hidden="true">{letter}</span>
                <span className="visually-hidden">
                  Check {letter}: {STATUS_WORD[status]}
                </span>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className="checks-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setChosen(!open)}
        >
          {open ? 'Hide details' : 'Show details'}
          <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      <div className="checks-body" id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}

function ChecksDisclosure({ rows }: { rows: [string, string, RowModel, ReactNode?][] }) {
  return (
    <ChecksCard title="Checks" titleId="checks-title" checks={rows.map(([letter, , m]) => ({ letter, status: m.status }))}>
      <ol className="checks">
        {rows.map(([letter, title, model, extra]) => (
          <CheckRow key={letter} letter={letter} title={title} status={model.status} result={model.result} how={model.how} extra={extra} />
        ))}
      </ol>
    </ChecksCard>
  );
}
