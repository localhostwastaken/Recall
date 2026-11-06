import { useState } from 'react';
import '../ui/landing.css';

function Arrow() {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.6" /></svg>;
}

export function Landing() {
  const [version, setVersion] = useState<'saved' | 'changed'>('saved');

  return <div className="landing-v2">
    <section className="recall-hero" aria-labelledby="landing-title">
      <div className="recall-hero-copy">
        <p className="recall-eyebrow">For the pages you may need again</p>
        <h1 id="landing-title" tabIndex={-1}>The web moves on.<br /><span>Keep your<br className="hero-break" /> reference.</span></h1>
        <p className="recall-hero-description">Keep a version of an important public page. Return to its words, inspect its evidence, and know what you can rely on.</p>
        <a className="recall-cta" href="#/reader">Open the reader <Arrow /></a>
        <p className="recall-hero-note">Find a saved page or check an evidence file.</p>
      </div>
      <div className="capture-stage" aria-label="Illustration of an earlier notice retained alongside a changed version">
        <div className="stage-heading"><span aria-hidden="true">+</span><span>A PAGE. A MOMENT. A RECORD.</span><span aria-hidden="true">+</span></div>
        <div className="page-layer page-layer-back"><span>Later version</span><p>Application deadline</p><strong>12 December</strong><span className="changed-tag">Deadline changed</span></div>
        <div className="page-layer page-layer-front"><div className="record-tab">RECALL / SAVED VERSION</div><div className="record-sheet-top"><span>STUDENT SUPPORT</span><span>PUBLIC NOTICE</span></div><div className="notice-symbol" aria-hidden="true"><svg width="29" height="29" viewBox="0 0 32 32" fill="none"><path d="m3 13 13-7 13 7-13 7-13-7Zm5 3v8c5 4 11 4 16 0v-8M29 14v10" stroke="currentColor" strokeWidth="1.5" /></svg></div><h2>One opportunity.<br />A deadline to remember.</h2><p>Scholarship applications are open to eligible students.</p><div className="record-deadline"><span>APPLICATIONS CLOSE</span><strong>15 December</strong></div><div className="record-sheet-bottom"><span>Response body</span><span>Saved version / 01</span></div></div>
        <div className="record-slip"><span className="slip-glyph" aria-hidden="true">⌑</span><div><strong>Keep the words. Inspect the evidence.</strong><span>Integrity · Witness signature · Source limits</span></div></div>
        <p className="stage-caption">Fictional notice · Product illustration</p>
      </div>
    </section>

    <div className="context-strip"><span>For moments that need a reference</span><p>Application deadlines <span aria-hidden="true">/</span> Public notices <span aria-hidden="true">/</span> Policies & reports</p></div>

    <section id="deadline-story" className="deadline-story" aria-labelledby="story-title">
      <div className="story-intro"><p className="recall-eyebrow">01 / A familiar problem</p><h2 id="story-title" tabIndex={-1}>You read the notice.<br />Then the notice changed.</h2><p>A scholarship closed on the 15th when you checked. The next time you visit, it says the 12th. What did the earlier version actually say?</p><p className="story-answer">A saved version gives you somewhere to look.</p></div>
      <div className="deadline-demo"><div className="demo-toolbar"><span>TRY THE EXAMPLE</span><span>ILLUSTRATIVE</span></div><div className="demo-switch" role="group" aria-label="Choose a fictional notice version"><button type="button" aria-pressed={version === 'saved'} onClick={() => setVersion('saved')}>01 <span>Earlier version</span></button><button type="button" aria-pressed={version === 'changed'} onClick={() => setVersion('changed')}>02 <span>Later version</span></button></div><div className="demo-content"><p className="demo-source">Student support office / Fictional notice</p><h3>Scholarship applications</h3><p>Applications for the coming academic year are open to eligible students.</p><div className={`demo-date ${version === 'changed' ? 'demo-date-changed' : ''}`}><span>APPLICATION DEADLINE</span><strong>{version === 'saved' ? '15' : '12'} <span>December</span></strong></div><p className="demo-status" role="status">{version === 'saved' ? 'Earlier wording: applications close on 15 December.' : 'Later wording: the deadline is now three days earlier.'}</p></div><p className="demo-disclaimer">A fictional before-and-after story. Version comparison is not yet available in the reader.</p></div>
    </section>

    <section className="inspection-story" aria-labelledby="inspection-title"><div className="inspection-heading"><p className="recall-eyebrow">02 / From saved words to useful evidence</p><h2 id="inspection-title">More than a page<br />to look back at.</h2><p>The reader brings the saved response and its checks together. Read the notice first. Inspect the evidence when you need to.</p></div><div className="inspection-flow"><div className="flow-index"><span>PUBLIC PAGE</span><span aria-hidden="true">→</span><span>SAVED RESPONSE</span><span aria-hidden="true">→</span><span>YOUR INSPECTION</span></div><ol><li><span className="flow-number">01</span><div><h3>Keep a response</h3><p>The Recall extension captures a supported public HTTPS response with a witness. Its evidence file holds the transcript and signed statement.</p></div></li><li><span className="flow-number">02</span><div><h3>Find your reference</h3><p>Search by page address or open a Recall evidence file. Available records depend on the configured index and storage gateways.</p></div></li><li><span className="flow-number">03</span><div><h3>Read with context</h3><p>Inspect readable content and individual check results. Download the evidence file to keep it for later inspection.</p></div></li></ol><a href="#/reader">Explore the reader <Arrow /></a></div></section>

    <section className="evidence-story" aria-labelledby="evidence-title"><div className="evidence-intro"><p className="recall-eyebrow">03 / Confidence needs context</p><h2 id="evidence-title">Every check has<br />a specific meaning.</h2><p>A clear result includes its limits. Recall keeps these questions separate instead of reducing them to one “verified” label.</p></div><div className="evidence-ledger"><div className="ledger-heading"><span>THE QUESTION</span><span>WHAT IT TELLS YOU</span></div><div className="ledger-row"><span className="ledger-symbol" aria-hidden="true">#</span><h3>Do the bytes match?</h3><div><p>The integrity check compares transcript bytes with the hashes in the signed statement.</p><span>Matching bytes do not establish their origin.</span></div></div><div className="ledger-row"><span className="ledger-symbol" aria-hidden="true">↗</span><h3>Who signed them?</h3><div><p>The signature check recovers the witness address and checks whether it is trusted by the reader.</p><span>A valid signature alone does not make a signer trusted.</span></div></div><div className="ledger-row"><span className="ledger-symbol" aria-hidden="true">?</span><h3>Did the source serve them?</h3><div><p>The current evidence relies on the witness’s account of the session.</p><span>No portable TLS source proof is independently verified here.</span></div></div><p className="ledger-note">On-chain commitment and publisher permission are not checked by the current reader. Capture times are witness claims.</p></div></section>

    <section className="recall-final"><div className="final-mark" aria-hidden="true"><span>R</span><span>01</span></div><div><p className="recall-eyebrow">Keep a reference you can return to</p><h2>The next page you need<br />might not stay the same.</h2><a className="recall-cta" href="#/reader">Find a saved page <Arrow /></a></div></section>
  </div>;
}
