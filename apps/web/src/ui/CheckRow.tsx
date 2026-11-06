import type { ReactNode } from 'react';
import { StatusBadge, type Status } from './StatusBadge';

/**
 * One check (A to E): letter, title, badge and a one-line result; the method sits behind
 * "How this was checked". `extra` is for a control that belongs to the check (check D's file chooser).
 */
export function CheckRow({
  letter,
  title,
  status,
  result,
  how,
  extra,
}: {
  letter: string;
  title: string;
  status: Status;
  result: ReactNode;
  how?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <li className="check-row" data-check={letter}>
      <div className="check-head">
        <span className="check-letter" aria-hidden="true">
          {letter}
        </span>
        <span className="check-title">
          <span className="visually-hidden">Check {letter}: </span>
          {title}
        </span>
        <StatusBadge status={status} />
      </div>
      <p className="check-result">{result}</p>
      {extra ? <div className="check-extra">{extra}</div> : null}
      {how ? (
        <details className="check-how">
          <summary>How this was checked</summary>
          <div className="check-how-body">{how}</div>
        </details>
      ) : null}
    </li>
  );
}
