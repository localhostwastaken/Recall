import type { ReactNode } from 'react';
import { StatusBadge, type Status } from './StatusBadge';

/** One check (A-E): letter, title, badge and a one-line result; the method sits behind details. */
export function CheckRow({
  letter,
  title,
  status,
  result,
  how,
}: {
  letter: string;
  title: string;
  status: Status;
  result: string;
  how?: ReactNode;
}) {
  return (
    <li className="check-row">
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
      {how ? (
        <details className="check-how">
          <summary>How this was checked</summary>
          <div className="check-how-body">{how}</div>
        </details>
      ) : null}
    </li>
  );
}
