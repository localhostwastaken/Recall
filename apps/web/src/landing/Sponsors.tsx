import './landing.css';
import './sponsors.css';
import { Award, ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';

const REPO = 'https://github.com/localhostwastaken/Recall';
const DOC = (path: string) => `${REPO}/blob/main/${path}`;

/** A link that opens in a new tab and says so. */
export function OutLink({ href, children, className = 'lk' }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

type Sponsor = {
  id: 'ef' | 'arkiv' | 'swarm';
  /** Initials, kept as data only (the card shows the sponsor's own logo from public/sponsors/). */
  mark: string;
  name: string;
  prize: string;
  line: string;
  rows: { title: string; text: ReactNode }[];
  link: { href: string; label: string };
};

export const SPONSORS: Sponsor[] = [
  {
    id: 'ef',
    mark: 'EF',
    name: 'Ethereum Foundation',
    prize: 'Best CROPS App',
    line: 'CROPS is why Recall exists: a record of the public web that no one can quietly take down.',
    rows: [
      { title: 'Censorship resistant', text: 'Evidence and this app live on Swarm, not one domain' },
      { title: 'Open source', text: 'MIT licensed, every line public' },
      { title: 'Private', text: 'Your cookies never reach the witness' },
      { title: 'Secure', text: 'Every check runs in your own browser' },
    ],
    link: { href: `${REPO}#crops`, label: 'How Recall meets CROPS' },
  },
  {
    id: 'arkiv',
    mark: 'A',
    name: 'Arkiv',
    prize: 'Build on Arkiv',
    line: "The public index: anyone can ask \"what captures exist of this page?\" without asking us.",
    rows: [
      {
        title: 'Public index',
        text: (
          <>
            Find every capture of a page, site or witness (<OutLink href={DOC('arkiv/why-arkiv.md')}>why Arkiv</OutLink>,{' '}
            <OutLink href={DOC('arkiv/how-you-use-arkiv.md')}>how we use it</OutLink>,{' '}
            <OutLink href={DOC('arkiv/schema.md')}>schema</OutLink>)
          </>
        ),
      },
      { title: 'Read-only records', text: 'No one can rewrite a capture, not even us' },
      { title: 'Anyone keeps it alive', text: 'Extend a record without the original capturer' },
    ],
    link: { href: DOC('arkiv/friction.md'), label: 'Our Arkiv feedback' },
  },
  {
    id: 'swarm',
    mark: 'S',
    name: 'Swarm',
    prize: 'Arkiv + Swarm bonus',
    line: 'Where the evidence lives, and where this site lives too, so neither depends on our servers.',
    rows: [
      { title: 'Evidence storage', text: 'Signed snapshots, paid for as long as someone cares' },
      { title: 'This website', text: 'Published to a Swarm feed, so it outlives our hosting' },
      { title: 'No backend', text: 'Uploads are stamped right in the extension' },
    ],
    link: { href: DOC('arkiv/swarm.md'), label: 'How we use Swarm' },
  },
];

/** Section 4, "Built on open infrastructure": what each sponsor makes possible. */
export function Sponsors() {
  return (
    <section id="sponsors" className="lsec lsec-alt" aria-labelledby="sponsors-title">
      <h2 className="lsec-title" id="sponsors-title">
        Built on open infrastructure
      </h2>
      <p className="lsec-intro">
        Recall works without us because these projects exist. Thank you to the Ethereum Foundation, Arkiv and Swarm.
      </p>
      <ul className="sp-grid">
        {SPONSORS.map((s) => (
          <li key={s.id} className="sp-card">
            <div className="sp-who">
              {/* Their own logos (from their brand packs, unaltered apart from the EF text colour on light),
                  one per theme; the name stays as the heading for screen readers. */}
              <span className={`sp-logo sp-logo-${s.id}`} aria-hidden="true">
                <img className="sp-logo-on-light" src={`./sponsors/${s.id}-light.svg`} alt="" />
                <img className="sp-logo-on-dark" src={`./sponsors/${s.id}-dark.svg`} alt="" />
              </span>
              <h3 className="sp-name visually-hidden">{s.name}</h3>
              <p className="sp-prize">
                <Award size={14} strokeWidth={1.75} aria-hidden="true" />
                <span className="visually-hidden">Prize: </span>
                {s.prize}
              </p>
            </div>
            <p className="sp-line">{s.line}</p>
            <dl className="sp-rows">
              {s.rows.map((r) => (
                <div key={r.title}>
                  <dt>{r.title}</dt>
                  <dd>{r.text}</dd>
                </div>
              ))}
            </dl>
            <OutLink href={s.link.href} className="lk sp-link">
              {s.link.label}
            </OutLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
