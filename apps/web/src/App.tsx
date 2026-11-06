import { useEffect, useRef, useState } from 'react';
import { WalletChip } from './components/WalletChip';
import { useRoute, type Route } from './router';
import { Home } from './routes/Home';
import { Settings } from './routes/Settings';
import { Storage } from './routes/Storage';
import { applyTheme, getSettings, saveSettings, type Theme } from './settings';
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
    case 'storage':
      return <Storage />;
    case 'settings':
      return <Settings />;
    case 'not-found':
      return <NotFound path={route.path} />;
  }
}

function ThemeMenu() {
  const [theme, setTheme] = useState<Theme>(() => getSettings().theme);
  return (
    <label className="theme-menu">
      <span className="visually-hidden">Theme</span>
      <select
        className="input input-compact"
        value={theme}
        onChange={(e) => {
          const next = e.target.value as Theme;
          setTheme(next);
          saveSettings({ theme: next });
          applyTheme(next);
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
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
          <a className="brand" href="#/">
            Recall
          </a>
          <nav aria-label="Main" className="nav">
            {link('#/', 'home', 'Home')}
            {link('#/settings', 'settings', 'Settings')}
          </nav>
          <div className="header-tools">
            <WalletChip />
            <ThemeMenu />
          </div>
        </div>
      </header>
      <main id="main" ref={main} tabIndex={-1} className="container page">
        <Page route={route} />
      </main>
      <footer className="site-footer">
        <div className="container">
          <p className="muted">No trackers. Verification runs in your browser. TLSNotary alpha (unaudited) · testnet.</p>
        </div>
      </footer>
    </ToastProvider>
  );
}
