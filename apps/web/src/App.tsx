import { useEffect, useRef } from 'react';
import { WalletChip } from './components/WalletChip';
import { useRoute, type Route } from './router';
import { Home } from './routes/Home';
import { Landing } from './routes/Landing';
import { Settings } from './routes/Settings';
import { Storage } from './routes/Storage';
import { ToastProvider } from './ui/Toast';
import { ArchiveMark } from './ui/ArchiveMark';

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
      return <Landing />;
    case 'reader':
      return <Home />;
    case 'storage':
      return <Storage />;
    case 'settings':
      return <Settings />;
    case 'not-found':
      return <NotFound path={route.path} />;
  }
}

export function App() {
  const route = useRoute();
  const isLanding = route.name === 'home';
  const main = useRef<HTMLElement>(null);
  const previousRoute = useRef(route.name);

  // On each route change focus moves to the page's h1 (not on first load).
  useEffect(() => {
    if (previousRoute.current === route.name) return;
    previousRoute.current = route.name;
    document.querySelector<HTMLElement>('main h1')?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [route.name]);

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
          <a className="brand" href="#/" aria-label="Recall home"><ArchiveMark /><span>Recall<span className="brand-caption">The living archive</span></span></a>
          <nav aria-label="Main" className="nav product-nav">
            {isLanding ? <>
              <button className="nav-story" type="button" onClick={() => {
                document.getElementById('date-story')?.scrollIntoView({ behavior: 'auto' });
                document.getElementById('story-title')?.focus({ preventScroll: true });
              }}>See how it works</button>
              <a className="btn btn-primary" href="#/reader">Open reader</a>
            </> : <>
              {link('#/reader', 'reader', 'Reader')}
              {link('#/settings', 'settings', 'Settings')}
              <details key={route.name} className="product-tools" onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector('summary')?.focus();
                  event.preventDefault();
                }
              }} onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;
              }}>
                <summary>Tools</summary>
                <div className="tools-panel">
                  <h2>Reader tools</h2>
                  <a href="#/storage">Buy storage</a>
                  <div className="wallet-tools"><p className="field-helper">A wallet is only needed for paid storage.</p><WalletChip /></div>
                </div>
              </details>
            </>}
          </nav>
        </div>
      </header>
      <main id="main" ref={main} tabIndex={-1} className={`container page${isLanding ? ' landing-page' : ''}`}>
        <Page route={route} />
      </main>
      <footer className="site-footer">
        <div className="container footer-row">
          <a className="footer-brand" href="#/">Recall</a>
          <p>Inspect the record. Understand its limits.<br /><span>Evidence checks run in your browser. Source claims depend on the witness.</span></p>
          <a href={isLanding ? '#/reader' : '#/'}>{isLanding ? 'Open reader' : 'About Recall'}</a>
        </div>
      </footer>
    </ToastProvider>
  );
}
