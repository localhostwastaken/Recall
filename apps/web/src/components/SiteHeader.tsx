import { Menu, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Wordmark } from '../brand/Logo';
import { routeId, type Route } from '../router';
import { goToSection } from '../sectionNav';
import { ThemeToggle } from './ThemeToggle';
import { WalletChip } from './WalletChip';

/** The menu button shows below this width (keep in step with shell.css: 1040 px and under). */
const COMPACT_QUERY = '(max-width: 1039px)';

/** A link to a section of the landing page: scrolls there, from any page. */
function SectionLink({
  id,
  className,
  onNavigate,
  children,
}: {
  id: string;
  className?: string;
  onNavigate?: () => void;
  children: ReactNode;
}) {
  return (
    <a
      className={className}
      href="#/"
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        // Let the browser handle modified clicks (new tab, new window).
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onNavigate?.();
        goToSection(id);
      }}
    >
      {children}
    </a>
  );
}

/**
 * The site header, on every route. Wide (1040 px and up): logo, Library, How it works, Sponsors,
 * theme toggle, "Get the extension" and the wallet chip. Narrower: the wallet chip moves into a
 * menu panel. Phone (760 px and under): logo, Library, theme toggle and a menu button that opens a
 * panel with the rest (Escape, an outside click or a link closes it).
 */
export function SiteHeader({ route }: { route: Route }) {
  const [open, setOpen] = useState(false);
  const header = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  // Closing from a link keeps focus in the header (the focused link unmounts with the panel).
  const close = () => {
    setOpen(false);
    menuButton.current?.focus();
  };

  // A new page always starts with the menu closed.
  const page = routeId(route);
  useEffect(() => setOpen(false), [page]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      menuButton.current?.focus();
    };
    const onPointerDown = (e: Event) => {
      if (!header.current?.contains(e.target as Node)) setOpen(false);
    };
    // Growing the window past the compact layout hides the menu button: reset the state.
    let compact: MediaQueryList | null = null;
    try {
      compact = window.matchMedia(COMPACT_QUERY);
    } catch {
      compact = null;
    }
    const onResize = () => {
      if (compact && !compact.matches) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    compact?.addEventListener?.('change', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
      compact?.removeEventListener?.('change', onResize);
    };
  }, [open]);

  return (
    <header
      className="site-header"
      ref={header}
      onBlur={(e) => {
        // Tabbing out of the open panel closes it.
        if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <div className="container header-row">
        {/* The accessible name keeps "Recall" (the visible text) and says where the link goes. */}
        <a className="brand" href="#/" aria-label="Recall home">
          <Wordmark />
        </a>
        <nav aria-label="Main" className="nav">
          <a href="#/library" aria-current={route.name === 'library' ? 'page' : undefined}>
            Library
          </a>
          <SectionLink id="how-it-works" className="nav-wide">
            How it works
          </SectionLink>
          <SectionLink id="sponsors" className="nav-wide">
            Sponsors
          </SectionLink>
        </nav>
        <div className="header-tools">
          <ThemeToggle />
          <SectionLink id="install" className="btn btn-primary header-cta header-wide">
            Get the extension
          </SectionLink>
          <div className="header-wallet">
            <WalletChip />
          </div>
          <button
            ref={menuButton}
            type="button"
            className="round-btn menu-btn"
            aria-label="Menu"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? (
              <X size={20} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
        </div>
        {open ? (
          <div id={panelId} className="header-menu">
            <SectionLink id="how-it-works" className="menu-link" onNavigate={close}>
              How it works
            </SectionLink>
            <SectionLink id="sponsors" className="menu-link" onNavigate={close}>
              Sponsors
            </SectionLink>
            <SectionLink id="install" className="btn btn-primary menu-cta" onNavigate={close}>
              Get the extension
            </SectionLink>
            <div className="menu-wallet">
              <WalletChip />
            </div>
          </div>
        ) : null}
      </div>
    </header>
  );
}
