import type { VerifiedFacts } from '@recall/evidence';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { formatBytes } from '../format';
import { contentKind, decodeBody } from '../timeline/content';
import { Notice } from '../ui/Notice';
import { previewDocument } from './previewDoc';

/** Bigger bodies are not drawn: a hostile file must not be able to make the page struggle. */
const MAX_PREVIEW_BYTES = 1_000_000;

/** Why a file has no preview, and what to do instead. */
function NoPreview({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  return (
    <div className="preview-none">
      <p>{children}</p>
      {fallback}
    </div>
  );
}

/**
 * A PDF cannot be previewed in the sandbox: Chrome refuses to draw its PDF viewer inside an
 * iframe with an empty `sandbox` and shows a broken-page icon instead. So the captured file is
 * offered for download, to open in the person's own viewer.
 */
function PdfDownload({ facts }: { facts: VerifiedFacts }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([facts.body as BlobPart], { type: 'application/pdf' }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [facts.body]);
  const name = `recall-${facts.urlHash.slice(2, 10)}-${facts.signedAt}.pdf`;
  return (
    <NoPreview
      fallback={
        url ? (
          <p>
            <a className="btn btn-secondary" href={url} download={name}>
              Download the captured PDF
            </a>
          </p>
        ) : null
      }
    >
      PDF files can't be previewed in the sandbox. Download the captured file to open it in your own viewer, and
      only if you trust {facts.serverName}.
    </NoPreview>
  );
}

/**
 * The captured bytes, drawn safely (design brief 4.5). HTML and text go into
 * `<iframe sandbox="" srcdoc>` (an empty sandbox: no scripts, no same-origin, no forms, no
 * popups) with outside resources blocked and every link and redirect taken out (see
 * `previewDoc`). The captured page is never put into the app's own DOM.
 *
 * `facts` exist when checks A and B passed and the signature is not invalid, so they can also
 * belong to a witness the person has not trusted (check C warns) or to an HTTP error page; the
 * verdict above says so. This shows what the witness signed, not that the page was trustworthy.
 * `fallback` is an action (the evidence download) offered when there is no preview.
 *
 * Backstop, advisory only: a preview loads once, so a second load means something navigated it
 * and the frame is replaced by a notice. It cannot be relied on (a navigation to a page whose
 * subresources hang never fires `load`); the protection is that nothing in the document can
 * navigate at all (see `previewDoc`).
 */
export function Preview({ facts, fallback }: { facts: VerifiedFacts; fallback?: ReactNode }) {
  const kind = contentKind(facts.contentType);
  const tooBig = facts.body.length > MAX_PREVIEW_BYTES;
  const doc = useMemo(
    () => (!tooBig && (kind === 'html' || kind === 'text') ? previewDocument(kind, decodeBody(facts.body, facts.contentType)) : null),
    [facts.body, facts.contentType, kind, tooBig],
  );

  const [loads, setLoads] = useState(0);
  useEffect(() => setLoads(0), [doc]); // a different document is a fresh frame
  let content: ReactNode;
  if (loads > 1) {
    content = (
      <Notice kind="warn" title="The preview was stopped.">
        The captured page tried to load something else in its frame, so it is not shown.
      </Notice>
    );
  } else if (kind === 'pdf') content = <PdfDownload facts={facts} />;
  else if (doc !== null) {
    content = (
      <iframe
        className="preview-frame"
        title="Preview of the captured bytes"
        sandbox=""
        srcDoc={doc}
        referrerPolicy="no-referrer"
        onLoad={() => setLoads((n) => n + 1)}
      />
    );
  } else if (tooBig && (kind === 'html' || kind === 'text')) {
    content = <NoPreview fallback={fallback}>This file is {formatBytes(facts.body.length)}, too large to preview.</NoPreview>;
  } else content = <NoPreview fallback={fallback}>No preview for this file type.</NoPreview>;

  return (
    <section aria-labelledby="preview-title" className="preview">
      <h2 className="section-title" id="preview-title">
        Preview of the captured bytes
      </h2>
      {doc !== null ? (
        <p className="muted preview-caption">Sandboxed: scripts and outside resources are blocked, so it may look plain.</p>
      ) : null}
      {content}
    </section>
  );
}
