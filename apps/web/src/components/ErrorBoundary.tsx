import { Component, type ReactNode } from 'react';
import { Notice } from '../ui/Notice';

/**
 * Last line of defence for a page. Evidence is made by strangers, so a value nobody
 * anticipated must not blank the app or, worse, leave a half-drawn page that looks checked:
 * the fallback shows no check result at all, so nothing in it can read as a pass.
 * Give it a `key` that changes with the route so the next page starts fresh.
 */
export class ErrorBoundary extends Component<{ title: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error('Recall: a page failed to render', error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <>
        <h1 tabIndex={-1}>{this.props.title}</h1>
        <Notice
          kind="error"
          title="Nothing here counts as checked."
          actions={
            <a className="btn btn-secondary" href="#/">
              Go to the home page
            </a>
          }
        >
          Something in this page could not be shown, so no check result is displayed for it. Reload the page, or go
          back to the home page.
        </Notice>
      </>
    );
  }
}
