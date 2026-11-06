import { CircleCheck, CircleDashed, CircleHelp, CircleMinus, CircleX, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react';

export type Status = 'pass' | 'fail' | 'warn' | 'unknown' | 'unavailable' | 'not-applicable' | 'pending';

const ICONS: Record<Status, LucideIcon> = {
  pass: CircleCheck,
  fail: CircleX,
  warn: TriangleAlert,
  unknown: CircleHelp,
  unavailable: CircleDashed,
  'not-applicable': CircleMinus,
  pending: LoaderCircle,
};

/** Default words per status (design brief section 2). */
export const STATUS_WORD: Record<Status, string> = {
  pass: 'Passed',
  fail: 'Failed',
  warn: 'Warning',
  unknown: 'Unknown',
  unavailable: 'Unavailable',
  'not-applicable': 'Not applicable',
  pending: 'Checking…',
};

/** Icon + word + colour. The icon is decorative; the word is the accessible name. */
export function StatusBadge({ status, label }: { status: Status; label?: string }) {
  const Icon = ICONS[status];
  return (
    <span className={`badge badge-${status}`} data-status={status}>
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" className={status === 'pending' ? 'spin' : undefined} />
      <span>{label ?? STATUS_WORD[status]}</span>
    </span>
  );
}
