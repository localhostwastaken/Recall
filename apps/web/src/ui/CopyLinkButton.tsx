import { Copy } from 'lucide-react';
import { useToast } from './Toast';

/** Copies this page's address and says so in a toast (one look and one message on every page). */
export function CopyLinkButton() {
  const toast = useToast();
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast('Copied');
    } catch {
      toast('Copy is blocked in this browser. Select the address bar instead.');
    }
  };
  return (
    <button type="button" className="btn btn-secondary" onClick={copyLink}>
      <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
      Copy link
    </button>
  );
}
