import { useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { getStampAddress } from '../ext';
import { getSettings, saveSettings } from '../settings';
import { Field } from '../ui/Field';
import { useToast } from '../ui/Toast';

type ExtStatus = { kind: 'unknown' } | { kind: 'checking' } | { kind: 'connected' } | { kind: 'not-connected' };

// A first cut: the extension ID, which the Buy storage page needs. Witnesses, endpoints and
// appearance arrive with the full Settings page.
export function Settings() {
  const toast = useToast();
  const [extensionId, setExtensionId] = useState(() => getSettings().extensionId);
  const [status, setStatus] = useState<ExtStatus>({ kind: 'unknown' });

  const save = async () => {
    const id = extensionId.trim();
    saveSettings({ extensionId: id });
    toast('Settings saved');
    if (!id) return setStatus({ kind: 'unknown' });
    setStatus({ kind: 'checking' });
    try {
      await getStampAddress({ extensionId: id });
      setStatus({ kind: 'connected' });
    } catch {
      setStatus({ kind: 'not-connected' });
    }
  };

  return (
    <>
      <h1 tabIndex={-1}>Settings</h1>
      <p className="lede muted">Saved in this browser only.</p>
      <section className="stack" aria-labelledby="ext-heading">
        <h2 id="ext-heading" className="section-title">
          Extension
        </h2>
        <Field
          label="Extension ID"
          value={extensionId}
          onChange={(e) => setExtensionId(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          helper="Find it on chrome://extensions."
        />
        <p className="muted" role="status">
          {status.kind === 'checking' ? 'Checking the extension…' : null}
          {status.kind === 'connected' ? (
            <span className="inline-ok">
              <CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" /> Connected
            </span>
          ) : null}
          {status.kind === 'not-connected' ? 'Not connected. Check the ID matches chrome://extensions.' : null}
        </p>
        <div>
          <button type="button" className="btn btn-primary" onClick={save}>
            Save settings
          </button>
        </div>
      </section>
    </>
  );
}
