import { StatusBadge } from './StatusBadge';

export type WitnessState = 'checking' | 'online' | 'offline';

const VIEW = {
  checking: { status: 'pending', label: 'Checking witness…' },
  online: { status: 'pass', label: 'Witness online' },
  offline: { status: 'fail', label: 'Witness offline' },
} as const;

/** Witness reachability, announced politely to screen readers when it changes. */
export function WitnessChip({ state }: { state: WitnessState }) {
  const v = VIEW[state];
  return (
    <span role="status" aria-live="polite" className="witness-chip">
      <StatusBadge status={v.status} label={v.label} />
    </span>
  );
}
