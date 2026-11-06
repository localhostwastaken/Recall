import type { CheckReport } from '@recall/evidence';
import { StatusBadge } from '../ui/StatusBadge';
import { evidenceItems } from './evidenceView';

export function EvidencePanel({ report }: { report?: CheckReport }) {
  return <section className="evidence-panel" aria-labelledby="evidence-heading">
    <p className="overline">Read the results separately</p>
    <h3 id="evidence-heading">What the evidence tells you</h3>
    <p className="panel-intro">A passing hash or signature check does not establish the source on its own.</p>
    <ul className="evidence-list">
      {evidenceItems(report).map(item => <li className="evidence-row" key={item.title}>
        <div className="evidence-row-heading"><h4>{item.title}</h4><StatusBadge status={item.status} label={item.label} /></div>
        <p>{item.description}</p>
        {item.detail && <details className="check-explanation"><summary>Check details</summary><p>{item.detail}</p></details>}
      </li>)}
    </ul>
  </section>;
}
