import { ChevronDown, CircleCheck, CircleDashed, CircleX, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { STATUS_WORD, type Status } from './StatusBadge';

const ICONS: Record<Status, LucideIcon> = {
  pass: CircleCheck,
  fail: CircleX,
  warn: TriangleAlert,
  unavailable: CircleDashed,
  pending: LoaderCircle,
};

/**
 * Progressive disclosure for the check rows: one line with a small mark per check, and the rows
 * behind "Show details". A failed or warning check opens the rows by itself, so a problem is
 * never hidden behind the toggle. `children` are the CheckRow items.
 */
export function CheckDetails({
  checks,
  children,
}: {
  checks: { letter: string; status: Status }[];
  children: ReactNode;
}) {
  const attention = checks.some((c) => c.status === 'fail' || c.status === 'warn');
  const [chosen, setChosen] = useState<boolean | null>(null);
  useEffect(() => {
    if (attention) setChosen(null);
  }, [attention]);
  const open = chosen ?? attention;
  const listId = useId();
  return (
    <div className="checks-disclosure">
      <div className="checks-summary-row">
        <ul className="check-pills" aria-label="Checks">
          {checks.map((c) => {
            const Icon = ICONS[c.status];
            return (
              <li key={c.letter} className={`check-pill check-pill-${c.status}`}>
                <Icon size={16} strokeWidth={2} aria-hidden="true" className={c.status === 'pending' ? 'spin' : undefined} />
                <span aria-hidden="true">{c.letter}</span>
                <span className="visually-hidden">
                  Check {c.letter}: {STATUS_WORD[c.status]}
                </span>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className="checks-toggle"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setChosen(!open)}
        >
          {open ? 'Hide details' : 'Show details'}
          <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      <ul className="checks" id={listId} hidden={!open} aria-label="Check details">
        {children}
      </ul>
    </div>
  );
}
