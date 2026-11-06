/** A fictional notice illustrates the reader; no verification results are implied. */
export function Landing() {
  return (
    <div className="landing">
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="hero-copy">
          <p className="landing-kicker">A reader for the changing web</p>
          <h1 id="landing-title" tabIndex={-1}>Remember the page<br /><span>as it was.</span></h1>
          <p className="hero-description">Save a version of a public webpage, then come back to read it and examine the evidence behind it.</p>
          <a className="landing-primary" href="#/reader">Find a saved page <span aria-hidden="true">↗</span></a>
          <p className="hero-footnote">Already have a Recall evidence file? You can check it in the reader.</p>
        </div>
        <div className="hero-visual" aria-label="Illustration of a saved notice">
          <div className="visual-index"><span>RECALL / READER</span><span>ILLUSTRATIVE EXAMPLE</span></div>
          <div className="archive-sheet">
            <div className="sheet-top"><span>PUBLIC NOTICE</span><span>01 / 02</span></div>
            <p className="sheet-institution">Student support office</p>
            <h2>Scholarship<br />applications</h2>
            <p className="sheet-copy">Applications for the coming academic year are open to eligible students.</p>
            <div className="sheet-deadline"><span>APPLICATION DEADLINE</span><strong>15 December</strong></div>
            <div className="sheet-footer"><span>Saved response</span><span>Evidence available to inspect</span></div>
          </div>
          <p className="visual-caption"><span>FIG. 01</span> A fictional notice, shown to illustrate a saved version.</p>
        </div>
      </section>

      <section className="landing-problem" aria-labelledby="problem-title">
        <div className="section-index">01 <span>/ WHY IT MATTERS</span></div>
        <div className="problem-content"><h2 id="problem-title">The details can change.<br />Your reference point shouldn’t disappear.</h2>
          <div className="problem-columns"><p>A student reads that a scholarship closes on 15 December. Later, the notice says 12 December. The earlier wording may no longer be on the page.</p><p>Recall is built to help keep a particular response and the evidence that came with it, so it can be inspected later.</p></div>
        </div>
      </section>

      <section className="landing-preview" aria-labelledby="preview-title">
        <div className="preview-heading"><div><div className="section-index">02 <span>/ THE READER</span></div><h2 id="preview-title">The notice first.<br />The evidence close by.</h2></div><p>Read the saved response, then see what each check can and cannot tell you.</p></div>
        <div className="preview-frame">
          <div className="preview-bar"><span>RECALL / CAPTURE DETAILS</span><span>ILLUSTRATIVE EXAMPLE</span></div>
          <div className="preview-body"><div className="preview-notice"><p className="preview-label">SAVED RESPONSE / DERIVED TEXT</p><h3>Scholarship applications</h3><p className="preview-muted">Student support office · Fictional notice</p><div className="preview-rule" /><p>Applications for the coming academic year are open to eligible students.</p><p><strong>Application deadline</strong><br />15 December</p><p className="preview-small">A simplified reading view. The original response is retained in the evidence file.</p></div>
            <div className="preview-evidence"><p className="preview-label">WHAT THE EVIDENCE SAYS</p><h3>Verification results</h3><p>Each result answers a different question.</p><div className="preview-check"><span>Transcript integrity</span><span>Check saved bytes</span></div><div className="preview-check"><span>Witness signature</span><span>Check signer</span></div><div className="preview-check"><span>Source authenticity</span><span>Witness-dependent</span></div><p className="preview-small">Illustration only. Open an actual record to see its results.</p></div>
          </div>
        </div>
        <p className="preview-caption">This is a fictional example, not a saved capture. The reader can list available captures for a URL; a comparison view is not yet available.</p>
      </section>

      <section className="landing-journey" aria-labelledby="journey-title"><div className="section-index">03 <span>/ HOW IT WORKS</span></div><div><h2 id="journey-title">From a page to a record you can inspect.</h2><div className="journey-list"><div><span>01</span><h3>Capture a public page</h3><p>The Recall browser extension captures a supported public HTTPS response with a witness. The response and signed statement form an evidence file.</p></div><div><span>02</span><h3>Find the saved version</h3><p>Search by the page’s address in the reader, or open an evidence file you already have. Retrieval depends on the configured networks and available records.</p></div><div><span>03</span><h3>Read and check</h3><p>Inspect the response and the results of checks on its transcript and witness signature. The reader explains when a result is unknown or unavailable.</p></div></div></div></section>

      <section className="landing-trust" aria-labelledby="trust-title"><div className="trust-intro"><div className="section-index">04 <span>/ EVIDENCE & LIMITS</span></div><h2 id="trust-title">A clear view of what can be checked.</h2><p>Evidence is most useful when its limits are visible. Recall keeps these questions separate.</p></div><dl className="trust-list"><div><dt>Integrity</dt><dd>Do the saved transcript bytes match the hashes in the signed statement? A match alone does not prove where those bytes came from.</dd></div><div><dt>Signature</dt><dd>Does the signature recover to the stated witness? A valid signature does not by itself establish that the witness is trusted.</dd></div><div><dt>Source</dt><dd>The current evidence file is a witness-signed statement, not an independently verified portable proof that the original site served the response.</dd></div></dl></section>

      <section className="landing-end"><div><p className="landing-kicker">A place to start</p><h2>Have a page in mind?</h2><p>Look for a saved version or inspect a Recall evidence file.</p></div><a className="landing-primary" href="#/reader">Open the reader <span aria-hidden="true">↗</span></a></section>
    </div>
  );
}
