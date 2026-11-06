import type { CheckReport } from '@recall/evidence';
import type { Listed } from '@recall/net';
import type { Status } from '../ui/StatusBadge';

export type Capture = Extract<Listed, { kind: 'capture' }>;
export type EvidenceItem = { title: string; status: Status; label?: string; description: string; detail?: string };

/** Presentation only. The shared runChecks function remains the verifier. */
export function evidenceItems(report?: CheckReport): EvidenceItem[] {
  return [
    { title: 'Transcript integrity', status: report?.A.status ?? 'unavailable', description: 'Do the saved request and response match the statement’s hashes?', detail: report?.A.detail },
    { title: 'Response structure', status: report?.B.status ?? 'unavailable', description: 'Is the HTTP response complete and consistent with the stated request?', detail: report?.B.detail },
    { title: 'Witness signature', status: report?.C.status === 'warn' ? 'unknown' : report?.C.status ?? 'unavailable', label: report?.C.status === 'warn' ? 'Unknown witness' : undefined, description: report?.C.status === 'warn' ? 'The signature recovers to the stated signer, but this reader does not pin that witness as trusted.' : 'Does the signature match the stated signer and the reader’s trusted witness list?', detail: report?.C.detail },
    { title: 'Source authenticity', status: 'unknown', label: 'Not proven', description: 'The source depends on the witness’s account. This reader does not independently verify a portable TLS proof.' },
    { title: 'On-chain commitment', status: 'unknown', label: 'Not checked', description: 'An index record is not proof of chain inclusion. A matching chain event has not been verified.' },
    { title: 'Publisher permission', status: 'unknown', label: 'Not checked', description: 'This reader does not check permission to publish under an organisation’s identity.' },
  ];
}

/** Discovery metadata matching is deliberately separate from evidence verification. */
export function indexMetadataMatches(row: Capture, report: CheckReport): boolean | null {
  const facts = report.facts;
  if (!facts) return null;
  return row.urlHash.toLowerCase() === facts.urlHash.toLowerCase()
    && row.bodySha256.toLowerCase() === facts.bodySha256.toLowerCase()
    && row.witness.toLowerCase() === facts.witness.toLowerCase();
}

export function claimedDate(seconds: bigint): string {
  const d = new Date(Number(seconds) * 1000);
  return Number.isNaN(d.getTime()) ? 'Date unavailable' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
