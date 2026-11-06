import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Address } from 'viem';
import { MonoValue } from '../../recall/ui/MonoValue';
import {
  ADDRESS_ERROR,
  FREE_MODE_NOTE,
  defaultSettings,
  loadSettings,
  saveSettings,
  settingsErrors,
  validAddress,
  type Settings,
  type SettingsInput,
  type UploadMode,
} from '../../recall/settings';
import '../../recall/ui/settings.css';

// The extension's settings form: upload mode, trusted witnesses and endpoints. It lives in the
// popup (a panel behind the header's Settings button) and on the options page, so both agree.
// "Saved in this browser only." Validation is the web app's (https only, plus http for localhost
// and 127.0.0.1; 0x addresses), run on blur and again on Save; the copy is the design brief's.

export const DUPLICATE_ERROR = 'That witness is already in the list.';

type Draft = SettingsInput & { uploadMode: UploadMode; pinned: Address[] };
type Errors = Partial<Record<keyof SettingsInput | 'newAddress', string>>;

const draftFrom = (s: Settings): Draft => ({
  uploadMode: s.uploadMode,
  pinned: [...s.pinnedWitnesses],
  witnessUrl: s.witnessUrl ?? '',
  appUrl: s.appUrl,
  arkivRpcUrl: s.arkivRpcUrl,
  arkivAccessKey: s.arkivAccessKey,
  uploadUrl: s.uploadUrl,
});

/** `https://host/*` origins that need the person's permission (localhost is allowed already). */
function originsToAsk(urls: string[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    try {
      const url = new URL(u);
      if (url.protocol === 'https:') out.add(`${url.origin}/*`);
    } catch {
      /* validation has refused it already */
    }
  }
  return [...out];
}

/** Asks for access to endpoints outside the built-in hosts; answers true when allowed (or not needed). */
async function ensureHostPermission(urls: string[]): Promise<boolean> {
  const origins = originsToAsk(urls);
  if (origins.length === 0) return true;
  try {
    // Called first thing in the click, so the user gesture is still there. Chrome answers
    // true at once, without a prompt, for origins that are already allowed.
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

function Field({
  label,
  value,
  error,
  helper,
  type = 'url',
  invalidFocus = true,
  onChange,
  onBlur,
  right,
  placeholder,
  mono = false,
}: {
  label: string;
  value: string;
  error?: string;
  helper?: string;
  type?: string;
  invalidFocus?: boolean;
  onChange: (v: string) => void;
  onBlur?: (v: string) => void;
  right?: ReactNode;
  placeholder?: string;
  mono?: boolean;
}) {
  const id = useId();
  const described =
    [helper ? `${id}-h` : '', error ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="sp-field">
      <label className="sp-label" htmlFor={id}>
        {label}
      </label>
      <div className={right ? 'sp-secret' : undefined}>
        <input
          id={id}
          className={`sp-input${mono ? ' mono' : ''}`}
          type={type}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          data-sp-field={invalidFocus ? '' : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => onBlur?.(e.target.value)}
        />
        {right}
      </div>
      {helper ? (
        <p className="sp-helper" id={`${id}-h`}>
          {helper}
        </p>
      ) : null}
      {error ? (
        <p className="sp-error" id={`${id}-e`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SettingsPanel({
  onSaved,
  onBack,
  heading = true,
}: {
  /** Show the "Settings" heading (the options page has its own). */
  heading?: boolean;
  /** Called after a save; `witnessChanged` is true when the pins or the witness URL changed. */
  onSaved?: (s: Settings, info: { witnessChanged: boolean }) => void;
  onBack?: () => void;
}) {
  const [loaded, setLoaded] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [newAddress, setNewAddress] = useState('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [focusFirst, setFocusFirst] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const uploadModeName = useId();

  useEffect(() => {
    loadSettings()
      .then((s) => {
        setLoaded(s);
        setDraft(draftFrom(s));
      })
      .catch(() => setStatus("Couldn't read the saved settings. The defaults are shown."));
  }, []);

  useEffect(() => {
    if (focusFirst > 0)
      root.current?.querySelector<HTMLElement>('[data-sp-field][aria-invalid="true"]')?.focus();
  }, [focusFirst]);

  if (!draft || !loaded) {
    return (
      <div className="sp" ref={root} aria-busy="true">
        <p className="muted">Reading your settings…</p>
      </div>
    );
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setStatus('');
  };
  const validate = (key: keyof SettingsInput, value: string) =>
    setErrors((e) => ({ ...e, [key]: settingsErrors({ [key]: value })[key] }));

  const addWitness = () => {
    const a = validAddress(newAddress);
    let error: string | undefined;
    if (!a) error = ADDRESS_ERROR;
    else if (draft.pinned.some((p) => p.toLowerCase() === a.toLowerCase())) error = DUPLICATE_ERROR;
    setErrors((e) => ({ ...e, newAddress: error }));
    if (error || !a) return;
    set('pinned', [...draft.pinned, a]);
    setNewAddress('');
    setNote('Witness added to the list. Save settings to apply it.');
  };

  const save = async () => {
    const found = settingsErrors({
      witnessUrl: draft.witnessUrl,
      appUrl: draft.appUrl,
      arkivRpcUrl: draft.arkivRpcUrl,
      arkivAccessKey: draft.arkivAccessKey,
      uploadUrl: draft.uploadUrl,
    });
    setErrors((e) => ({ ...found, newAddress: e.newAddress }));
    if (Object.keys(found).length > 0) {
      setStatus('');
      setFocusFirst((n) => n + 1);
      return;
    }
    // Asking for access comes first, while the click's user gesture is still there.
    const allowed = await ensureHostPermission(
      [draft.witnessUrl, draft.arkivRpcUrl, draft.uploadUrl].map((u) => u.trim()).filter(Boolean),
    );
    const patch: Partial<Settings> = {
      uploadMode: draft.uploadMode,
      pinnedWitnesses: draft.pinned,
      witnessUrl: draft.witnessUrl.trim() || undefined,
      appUrl: draft.appUrl.trim(),
      arkivRpcUrl: draft.arkivRpcUrl.trim(),
      arkivAccessKey: draft.arkivAccessKey.trim(),
      uploadUrl: draft.uploadUrl.trim(),
    };
    try {
      const next = await saveSettings(patch);
      const witnessChanged =
        JSON.stringify(next.pinnedWitnesses) !== JSON.stringify(loaded.pinnedWitnesses) ||
        next.witnessUrl !== loaded.witnessUrl;
      setLoaded(next);
      setDraft(draftFrom(next));
      setNote('');
      setStatus(
        allowed
          ? 'Settings saved'
          : 'Settings saved. Recall was not allowed to reach one of the addresses, so it may not work until it is.',
      );
      onSaved?.(next, { witnessChanged });
    } catch {
      setStatus("Couldn't save the settings. Try again.");
    }
  };

  const resetEndpoints = () => {
    const d = defaultSettings(loaded.net);
    setDraft({
      ...draft,
      witnessUrl: d.witnessUrl ?? '',
      appUrl: d.appUrl,
      arkivRpcUrl: d.arkivRpcUrl,
      arkivAccessKey: '',
      uploadUrl: d.uploadUrl,
    });
    setErrors((e) => ({ newAddress: e.newAddress }));
    setStatus('');
  };

  return (
    <div className="sp" ref={root}>
      <div className="sp-head">
        {heading ? (
          <h2 className="sp-title" tabIndex={-1} id="settings-title">
            Settings
          </h2>
        ) : (
          <span />
        )}
        {onBack ? (
          <button type="button" className="btn btn-secondary" onClick={onBack}>
            Back
          </button>
        ) : null}
      </div>
      <p className="muted">Saved in this browser only.</p>

      <section className="sp-section" aria-labelledby="sp-upload">
        <h3 id="sp-upload" className="section-label">
          Upload mode
        </h3>
        <fieldset className="sp-radios">
          <legend className="visually-hidden">Upload mode</legend>
          <label className="sp-radio">
            <input
              type="radio"
              name={uploadModeName}
              checked={draft.uploadMode === 'stamped'}
              onChange={() => set('uploadMode', 'stamped')}
            />
            <span className="sp-radio-name">Prepaid storage (default)</span>
            <span className="sp-radio-desc">
              Each capture uses one batch from your pool. Keep-alive works.
            </span>
          </label>
          <label className="sp-radio">
            <input
              type="radio"
              name={uploadModeName}
              checked={draft.uploadMode === 'free'}
              onChange={() => set('uploadMode', 'free')}
            />
            <span className="sp-radio-name">Gateway free storage</span>
            <span className="sp-radio-desc">{FREE_MODE_NOTE}</span>
          </label>
        </fieldset>
      </section>

      <section className="sp-section" aria-labelledby="sp-witnesses">
        <h3 id="sp-witnesses" className="section-label">
          Trusted witnesses
        </h3>
        <p className="sp-helper">
          Check C passes only for witnesses in this list. Add a witness only if you trust whoever
          runs it.
        </p>
        {draft.pinned.length === 0 ? (
          <p className="muted">
            No trusted witnesses. Every signature shows as an unknown witness until you add one.
          </p>
        ) : (
          <ul className="sp-witnesses" aria-label="Trusted witnesses">
            {draft.pinned.map((address, i) => (
              <li key={address} className="sp-witness">
                <span>
                  <MonoValue value={address} />
                  {i === 0 ? (
                    <span className="sp-helper"> First: used to find the witness</span>
                  ) : null}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    set(
                      'pinned',
                      draft.pinned.filter((p) => p !== address),
                    );
                    setNote('Witness taken off the list. Save settings to apply it.');
                  }}
                >
                  Remove<span className="visually-hidden"> {address}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="sp-helper" role="status">
          {note}
        </p>
        <div className="sp-add">
          <Field
            label="Witness address (0x…)"
            type="text"
            value={newAddress}
            error={errors.newAddress}
            invalidFocus={false}
            mono
            onChange={(v) => {
              setNewAddress(v);
              setErrors((e) => (e.newAddress ? { ...e, newAddress: undefined } : e));
            }}
            onBlur={(v) => {
              if (v.trim())
                setErrors((e) => ({
                  ...e,
                  newAddress: validAddress(v) ? undefined : ADDRESS_ERROR,
                }));
            }}
          />
          <div className="sp-add-button">
            <button type="button" className="btn btn-secondary" onClick={addWitness}>
              Add witness
            </button>
          </div>
        </div>
      </section>

      <section className="sp-section" aria-labelledby="sp-endpoints">
        <h3 id="sp-endpoints" className="section-label">
          Endpoints
        </h3>
        <Field
          label="Witness URL"
          value={draft.witnessUrl}
          error={errors.witnessUrl}
          helper="Used when no announced address is found. Leave empty for the default."
          onChange={(v) => set('witnessUrl', v)}
          onBlur={(v) => validate('witnessUrl', v)}
        />
        <Field
          label="App URL"
          value={draft.appUrl}
          error={errors.appUrl}
          helper="The Recall web app, where you approve and browse captures."
          onChange={(v) => set('appUrl', v)}
          onBlur={(v) => validate('appUrl', v)}
        />
        <Field
          label="Arkiv RPC URL"
          value={draft.arkivRpcUrl}
          error={errors.arkivRpcUrl}
          onChange={(v) => set('arkivRpcUrl', v)}
          onBlur={(v) => validate('arkivRpcUrl', v)}
        />
        <Field
          label="Arkiv access key"
          type={showKey ? 'text' : 'password'}
          mono
          value={draft.arkivAccessKey}
          error={errors.arkivAccessKey}
          placeholder="Optional"
          helper="Optional. A key can raise the limits of the Arkiv RPC."
          onChange={(v) => set('arkivAccessKey', v)}
          onBlur={(v) => validate('arkivAccessKey', v)}
          right={
            <button
              type="button"
              className="btn btn-secondary"
              aria-pressed={showKey}
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? 'Hide' : 'Show'}
              <span className="visually-hidden"> Arkiv access key</span>
            </button>
          }
        />
        <Field
          label="Swarm upload gateway"
          value={draft.uploadUrl}
          error={errors.uploadUrl}
          helper="Where evidence is uploaded."
          onChange={(v) => set('uploadUrl', v)}
          onBlur={(v) => validate('uploadUrl', v)}
        />
        <div>
          <button type="button" className="btn btn-ghost" onClick={resetEndpoints}>
            Reset endpoints to default
          </button>
        </div>
      </section>

      <div className="sp-actions">
        <button type="button" className="btn btn-primary" onClick={() => void save()}>
          Save settings
        </button>
        <p className="sp-status" role="status">
          {status}
        </p>
      </div>
    </div>
  );
}
