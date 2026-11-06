import { ArrowRight, ArrowUpRight, FileText } from 'lucide-react';
import { useState } from 'react';
import '../ui/landing.css';

const announcementUrl = 'https://www.linkedin.com/posts/ethglobal_devconindia-mumbai-ethglobal-activity-7505708854693900289-TCpe';
const reconstruction = 'Illustrative reconstruction based on the public date change.';

export function Landing() {
  const [version, setVersion] = useState<'earlier' | 'updated'>('earlier');
  const showExample = () => {
    document.getElementById('date-story')?.scrollIntoView({ behavior: 'auto' });
    document.getElementById('story-title')?.focus({ preventScroll: true });
  };

  return <div className="landing">
    <section className="archive-hero" aria-labelledby="landing-title">
      <div className="archive-hero-copy">
        <h1 id="landing-title" tabIndex={-1}>Save a page.<br /><span>Keep the<br className="hero-line-break" /> context.</span></h1>
        <p className="hero-lede">The web changes. Keep a version of a public page, return to its words, and understand the evidence behind it.</p>
        <div className="hero-actions">
          <a className="btn btn-primary btn-large" href="#/reader">Open the reader <ArrowRight size={20} aria-hidden="true" /></a>
          <button type="button" className="btn btn-ghost" onClick={showExample}>See a real-world example</button>
        </div>
        <p className="hero-helper">Find a saved page or open an evidence file. No wallet needed to read.</p>
      </div>

      <figure className="archive-exhibit">
        <div className="exhibit-heading"><span><FileText size={18} aria-hidden="true" /> A change worth keeping</span><span>2026</span></div>
        <div className="exhibit-event"><p>Hackathon / Mumbai, India</p><h2>ETHGlobal <br />Mumbai</h2></div>
        <div className="announcement-pair">
          <div className="announcement-sheet announcement-earlier"><p>Earlier announcement</p><strong>6–8</strong><span>November 2026</span><small>Friday to Sunday</small></div>
          <div className="announcement-sheet announcement-updated"><p>Updated announcement</p><strong>5–7</strong><span>November 2026</span><small>Thursday to Saturday</small></div>
        </div>
        <p className="date-change"><span className="change-offset" aria-hidden="true">−1</span><span>Date moved<br /><strong>one day earlier.</strong></span></p>
        <figcaption>{reconstruction} These are not Recall captures.</figcaption>
      </figure>
    </section>

    <div className="archive-context"><span>A reference for the details that matter</span><p>Event dates <span aria-hidden="true">/</span> Public notices <span aria-hidden="true">/</span> Policies & reports</p></div>

    <section id="date-story" className="story-section" aria-labelledby="story-title">
      <div className="story-copy">
        <p className="overline">When the details change</p>
        <h2 id="story-title" tabIndex={-1}>One day earlier.<br />A different plan.</h2>
        <p>You note 6–8 November for ETHGlobal Mumbai. Later, the announcement says 5–7 November. That is a different day to arrive.</p>
        <p>Keeping a version gives you a reference for what you saw, even after the schedule moves on.</p>
        <a className="story-source" href={announcementUrl} target="_blank" rel="noreferrer">Read the public announcement <ArrowUpRight size={18} aria-hidden="true" /><span className="visually-hidden"> (opens in a new tab)</span></a>
      </div>
      <div className="version-example">
        <div className="example-heading"><span className="overline">A closer look at the change</span><span>November 2026</span></div>
        <div className="version-switch" role="group" aria-label="Choose an illustrative announcement">
          <button type="button" aria-pressed={version === 'earlier'} onClick={() => setVersion('earlier')}>Earlier announcement</button>
          <button type="button" aria-pressed={version === 'updated'} onClick={() => setVersion('updated')}>Updated announcement</button>
        </div>
        <article className="example-notice" aria-labelledby="example-title">
          <h3 id="example-title">ETHGlobal Mumbai</h3>
          <div className="example-date" aria-live="polite"><strong>{version === 'earlier' ? '6–8' : '5–7'}</strong><span>November<br />2026</span></div>
          <div className="calendar-strip" aria-hidden="true">{[
            ['Thu', 5], ['Fri', 6], ['Sat', 7], ['Sun', 8],
          ].map(([day, date]) => <div key={date} className={(version === 'earlier' ? Number(date) >= 6 : Number(date) <= 7) ? 'calendar-day is-selected' : 'calendar-day'}><span>{day}</span><strong>{date}</strong><span className="calendar-mark" /></div>)}</div>
          <p className="example-update" role="status">{version === 'earlier' ? 'The originally advertised dates: Friday to Sunday.' : 'The updated dates: Thursday to Saturday. One day earlier.'}</p>
        </article>
        <div className="example-limitation"><p>{reconstruction}</p><p>No archived pages or verified evidence are shown. Comparing real captures is not yet available in the reader.</p></div>
      </div>
    </section>

    <section className="journey-section" aria-labelledby="journey-title">
      <div className="journey-intro"><p className="overline">A page. A record. A return.</p><h2 id="journey-title">Give useful pages<br />a second life.</h2><p>A saved response keeps the words close. Its evidence helps you understand what you can rely on.</p><a href="#/reader" className="journey-link">Explore the reader <ArrowRight size={18} aria-hidden="true" /></a><div className="journey-art" aria-hidden="true"><span>Public page</span><span>Saved response</span><span>Evidence file</span></div></div>
      <ol className="journey-steps">
        <li><span className="step-number">01</span><div><h3>Keep a version</h3><p>The Recall extension captures supported public HTTPS responses with a witness. The transcript and signed statement form an evidence file.</p></div></li>
        <li><span className="step-number">02</span><div><h3>Find your way back</h3><p>Look up the original page address, or open a local evidence file. Online lookup depends on the configured index and storage gateways.</p></div></li>
        <li><span className="step-number">03</span><div><h3>Read it. Inspect it.</h3><p>Read supported response content, examine each check, and download the evidence for later inspection.</p></div></li>
      </ol>
    </section>

    <section className="trust-section" aria-labelledby="trust-title">
      <div className="trust-heading"><div><p className="overline">Evidence you can understand</p><h2 id="trust-title">A clear result.<br />An honest explanation.</h2></div><p>Matching content, a valid signature, and a proven source mean different things. Recall keeps their results separate.</p></div>
      <dl className="trust-ledger">
        <div><dt><span>01</span> Do the bytes match?</dt><dd>The integrity check compares the saved transcript with the hashes in the statement.<small>A match alone does not prove where the content came from.</small></dd></div>
        <div><dt><span>02</span> Who signed the statement?</dt><dd>The signature check recovers the witness address and checks it against the reader’s trusted list.<small>A valid signature can still belong to an unknown witness.</small></dd></div>
        <div><dt><span>03</span> What establishes the source?</dt><dd>The current evidence depends on the witness’s account of the session.<small>This reader does not independently verify a portable TLS source proof.</small></dd></div>
      </dl>
      <p className="trust-note">Capture times are witness claims. On-chain commitment and publisher permission are not checked by the current reader.</p>
    </section>

    <section className="landing-invitation" aria-labelledby="invitation-title"><div><p className="overline">Your next reference starts here</p><h2 id="invitation-title">Come back to<br />what matters.</h2></div><div><p>Find a saved page or take a closer look at a Recall evidence file.</p><a className="btn btn-primary btn-large" href="#/reader">Open the reader <ArrowRight size={20} aria-hidden="true" /></a></div></section>
  </div>;
}
