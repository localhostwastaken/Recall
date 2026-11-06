import { parseHash } from './router';

// Header and footer links that point at a section of the landing page (#how-it-works, #sponsors,
// #install). The app uses hash routes, so a real #anchor cannot be used: the link scrolls itself.
// From any other page it first goes to `#/`, and the scroll happens once that page has rendered
// (App calls `flushPendingSection` at the end of each route change).

let pending: string | null = null;

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function scrollToSection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

export function goToSection(id: string): void {
  if (parseHash(window.location.hash).name === 'home') {
    scrollToSection(id);
    return;
  }
  pending = id;
  window.location.hash = '#/';
}

/** Called after a route change has rendered: finishes a scroll that `goToSection` started. */
export function flushPendingSection(): void {
  const id = pending;
  pending = null;
  if (id) scrollToSection(id);
}
