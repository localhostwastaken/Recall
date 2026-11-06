import { useEffect, useRef } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SiteFooter } from './components/SiteFooter';
import { SiteHeader } from './components/SiteHeader';
import { routeId, useRoute, type Route } from './router';
import { Approve } from './routes/Approve';
import { Capture } from './routes/Capture';
import { FileCheck } from './routes/FileCheck';
import { Home } from './routes/Home';
import { Library } from './routes/Library';
import { Settings } from './routes/Settings';
import { Storage } from './routes/Storage';
import { Timeline } from './routes/Timeline';
import { flushPendingSection } from './sectionNav';
import { ToastProvider } from './ui/Toast';
import './app.css';
import './components/shell.css';

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
    case 'library':
      return <Library key={routeId(route)} q={route.q} type={route.type} sort={route.sort} />;
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
    // A header link to a landing section (How it works, Sponsors, Get the extension) clicked on
    // another page: the new page is rendered now, so finish the scroll.
    flushPendingSection();
  }, [routeId(route)]);

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
      <SiteHeader route={route} />
      <main id="main" ref={main} tabIndex={-1} className="container page">
        <ErrorBoundary
          key={routeId(route)}
          title={route.name === 'capture' || route.name === 'file' ? "Couldn't display this record" : "Couldn't display this page"}
        >
          <Page route={route} />
        </ErrorBoundary>
      </main>
      <SiteFooter route={route} />
    </ToastProvider>
  );
}
