import type { CheckResult } from '@recall/evidence';
import { isFreeBatch } from '@recall/net';
import { CircleCheck, CircleDashed, CircleX, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { sha256 } from 'viem';
import { formatBytes, formatTtl } from '../format';
import { CheckRow } from '../ui/CheckRow';
import { DropZone } from '../ui/DropZone';
import { MonoValue, middle } from '../ui/MonoValue';
import type { Status } from '../ui/StatusBadge';
import { witnessLabel } from '../witness';
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

function rowC(report: VerifiedReport | null): RowModel {
  if (!report) return PENDING('Checking the witness signature.');
  const { C, signer } = report;
  const detail = how(`Result: ${C.detail}`, signer ? <>Signer: <MonoValue value={signer} /></> : null);
  switch (C.status) {
    case 'pass':
      return {
        status: 'pass',
        result: signer
          ? `Signed by ${witnessLabel(signer) ?? 'a pinned witness'} (${middle(signer)}), which is in your trusted list.`
          : 'Signed by a witness in your trusted list.',
        how: detail,
      };
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
            <button type="button" className="btn btn-ghost btn-compact" onClick={onRemoveFile}>
              Remove file
            </button>
          </p>
        ) : null}
        <DropZone
          compact
          title={file ? 'Compare with a different file' : 'Drop a file to compare'}
          hint="The file stays in your browser."
          inputLabel="File to compare"
          onFile={onFile}
          error={fileError}
        />
      </div>,
    ],
    ['E', 'Storage', rowE(storage, batchId)],
  ];
  return (
    <section aria-labelledby="checks-title">
      <h2 className="section-title" id="checks-title">
        Checks
      </h2>
      <ol className="checks">
        {rows.map(([letter, title, model, extra]) => (
          <CheckRow key={letter} letter={letter} title={title} status={model.status} result={model.result} how={model.how} extra={extra} />
        ))}
      </ol>
    </section>
  );
}
