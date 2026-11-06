import { useEffect, useRef } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { WalletChip } from './components/WalletChip';
import { routeId, useRoute, type Route } from './router';
import { Approve } from './routes/Approve';
import { Capture } from './routes/Capture';
import { FileCheck } from './routes/FileCheck';
import { Home } from './routes/Home';
import { Settings } from './routes/Settings';
import { Storage } from './routes/Storage';
import { Timeline } from './routes/Timeline';
import { ToastProvider } from './ui/Toast';

function NotFound({ path }: { path: string }) {
  return (
    <>
      <h1 tabIndex={-1}>Page not found</h1>
      <p className="lede muted">
        There is nothing at <span className="mono">{path}</span>. <a href="#/">Go to the home page</a>.
      </p>
    </>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <Home />;
    case 'url':
      // Keyed by the address, so moving between two timelines never carries state over.
      return <Timeline key={route.urlHash} urlHash={route.urlHash} />;
    case 'capture':
      // Keyed by the record, so moving between two captures never carries state over.
      return <Capture key={route.key} entityKey={route.key} />;
    case 'file':
      return <FileCheck />;
    case 'storage':
      return <Storage />;
    case 'settings':
      return <Settings />;
    case 'approve':
      return <Approve key={route.captureId ?? ''} captureId={route.captureId} />;
    case 'not-found':
      return <NotFound path={route.path} />;
  }
}

/** The brand mark: a filed page with a citrus corner, in the accent colour. Decorative. */
function ArchiveMark() {
  return (
    <svg className="archive-mark" viewBox="0 0 32 36" width="26" height="30" aria-hidden="true" fill="none">
      <path d="M6 3h17l6 6v24H6V3Z" fill="var(--accent-soft)" stroke="currentColor" strokeWidth="2" />
      <path d="M23 3v7h6" fill="var(--citrus)" />
      <path d="M23 3v7h6M11 15h13M11 20h13M11 25h8M2 8v26" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function App() {
  const route = useRoute();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  // On each route change focus moves to the page's h1 (not on first load).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    document.querySelector<HTMLElement>('main h1')?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [routeId(route)]);

  const link = (href: string, name: Route['name'], label: string) => (
    <a href={href} aria-current={route.name === name ? 'page' : undefined}>
      {label}
    </a>
  );

  return (
    <ToastProvider>
      {/* A hash router cannot use #main as an anchor, so the skip link moves focus itself. */}
      <a
        className="skip-link"
        href="#/"
        onClick={(e) => {
          e.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="site-header">
        <div className="container header-row">
          <a className="brand" href="#/">
            <ArchiveMark />
            Recall
          </a>
          <nav aria-label="Main" className="nav">
            {link('#/', 'home', 'Home')}
            {link('#/settings', 'settings', 'Settings')}
          </nav>
          <div className="header-tools">
            <WalletChip />
          </div>
        </div>
      </header>
      <main id="main" ref={main} tabIndex={-1} className="container page">
        <ErrorBoundary
          key={routeId(route)}
          title={route.name === 'capture' || route.name === 'file' ? "Couldn't display this record" : "Couldn't display this page"}
        >
          <Page route={route} />
        </ErrorBoundary>
      </main>
      <footer className="site-footer">
        <div className="container">
          <p className="muted">No trackers. Verification runs in your browser. TLSNotary alpha (unaudited) · testnet.</p>
        </div>
      </footer>
    </ToastProvider>
  );
}
