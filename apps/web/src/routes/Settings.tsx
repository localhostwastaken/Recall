import { checkAddress, checkUrl } from '@recall/net';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { hasBuiltInArkivKey } from '../defaults';
import { getExtensionInfo } from '../ext';
import {
  ADDRESS_ERROR,
  DUPLICATE_WITNESS_ERROR,
  MAX_LABEL,
  applyTheme,
  cleanLabel,
  defaultSettings,
  fieldError,
  gatewayLines,
  getSettings,
  isSharedOrigin,
  keyHelper,
  labelError,
  resetSettings,
  saveSettingsChecked,
  useSettings,
  type FieldKey,
  type PinnedWitness,
  type Settings as SettingsValues,
  type Theme,
} from '../settings';
import { Field } from '../ui/Field';
import { MonoValue } from '../ui/MonoValue';
import { Notice } from '../ui/Notice';
import { Segmented } from '../ui/Segmented';
import { useToast } from '../ui/Toast';
import { displayName } from '../witness';
import './settings.css';

// §4.8 Settings. Everything on the page is a draft until [Save settings]; "Saved in this browser
// only." Every value the rest of the app uses (pins for check C, gateways, RPCs, the extension
// ID) is read from the saved settings (net.ts, witness.ts, ext.ts), so a saved change applies on
// the next page view. The theme is the exception: it applies and is saved as soon as it is picked.

type Draft = {
  witnesses: PinnedWitness[];
  arkivRpcUrl: string;
  arkivAccessKey: string;
  /** One gateway per line. */
  downloadText: string;
  uploadUrl: string;
  gnosisRpcUrl: string;
  extensionId: string;
};
type Errors = Partial<Record<FieldKey | 'newAddress' | 'newLabel', string>>;

const draftFrom = (s: SettingsValues): Draft => ({
  witnesses: s.pinnedWitnesses.map((w) => ({ ...w })),
  arkivRpcUrl: s.arkivRpcUrl,
  arkivAccessKey: s.arkivAccessKey,
  downloadText: s.downloadUrls.join('\n'),
  uploadUrl: s.uploadUrl,
  gnosisRpcUrl: s.gnosisRpcUrl,
  extensionId: s.extensionId,
});

const FIELD_KEYS: FieldKey[] = ['arkivRpcUrl', 'arkivAccessKey', 'downloadText', 'uploadUrl', 'gnosisRpcUrl', 'extensionId'];

/** The settings a valid draft stands for. */
function settingsFrom(d: Draft): Partial<SettingsValues> {
  const url = (v: string) => {
    const c = checkUrl(v);
    return c.ok ? c.value : v.trim();
  };
  const download = [...new Set(gatewayLines(d.downloadText).map(url))];
  return {
    pinnedWitnesses: d.witnesses,
    arkivRpcUrl: url(d.arkivRpcUrl),
    arkivAccessKey: d.arkivAccessKey.trim(),
    downloadUrls: download,
    uploadUrl: url(d.uploadUrl),
    gnosisRpcUrl: url(d.gnosisRpcUrl),
    extensionId: d.extensionId.trim(),
  };
}

type ExtStatus = { kind: 'unknown' } | { kind: 'checking' } | { kind: 'connected'; version?: string } | { kind: 'not-connected' };

/** A multi-line input in the style of Field (label, helper, error below). */
function TextAreaField({
  label,
  helper,
  error,
  value,
  onChange,
  onBlur,
}: {
  label: string;
  helper?: ReactNode;
  error?: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
}) {
  const id = useId();
  const describedBy = [helper ? `${id}-helper` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="input"
        rows={2}
        data-settings-field=""
        spellCheck={false}
        autoComplete="off"
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      {helper ? (
        <p className="field-helper" id={`${id}-helper`}>
          {helper}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${id}-error`}>
          <span>{error}</span>
        </p>
      ) : (
        <div className="field-error-slot" aria-hidden="true" />
      )}
    </div>
  );
}

function ResetButton({ what, onClick }: { what: string; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-ghost btn-compact" onClick={onClick}>
      Reset to default<span className="visually-hidden"> for {what}</span>
    </button>
  );
}

/** A native <dialog> (focus trap, Esc, focus returned to the trigger) asking for confirmation. */
function ConfirmDialog({
  open,
  title,
  confirmLabel,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault(); // Esc: close through our state so the focus return runs once
        onCancel();
      }}
    >
      <h2 id={titleId} className="section-title">
        {title}
      </h2>
      {children}
      <div className="dialog-actions">
        {/* Cancel takes the first focus: the safe choice for a destructive question. */}
        <button type="button" className="btn btn-secondary" autoFocus onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

export function Settings() {
  const toast = useToast();
  const saved = useSettings();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(getSettings()));
  const [errors, setErrors] = useState<Errors>({});
  const [newAddress, setNewAddress] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [ext, setExt] = useState<ExtStatus>({ kind: 'unknown' });
  const [confirmReset, setConfirmReset] = useState(false);
  const [notStored, setNotStored] = useState(false);
  // Which invalid field to focus next: the add-witness form after a failed Add, else the settings fields.
  const [focusInvalid, setFocusInvalid] = useState<{ n: number; scope: string }>({ n: 0, scope: '' });
  const [witnessNote, setWitnessNote] = useState('');
  const form = useRef<HTMLDivElement>(null);
  const resetTrigger = useRef<HTMLButtonElement>(null);
  const defaults = defaultSettings();
  const builtInKey = hasBuiltInArkivKey();
  // R38: on a shared gateway address the saved settings are not used and cannot be changed.
  const shared = isSharedOrigin();

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFrom(saved));

  const setField = (key: FieldKey, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  };
  const validate = (key: FieldKey, value: string) => setErrors((e) => ({ ...e, [key]: fieldError(key, value) }));

  // Moves focus to the first invalid field after a failed save.
  useEffect(() => {
    if (focusInvalid.n > 0) form.current?.querySelector<HTMLElement>(`${focusInvalid.scope}[aria-invalid="true"]`)?.focus();
  }, [focusInvalid]);

  const checkExtension = async (id: string) => {
    if (!id) return setExt({ kind: 'unknown' });
    setExt({ kind: 'checking' });
    try {
      const info = await getExtensionInfo({ extensionId: id });
      setExt({ kind: 'connected', ...(info.version ? { version: info.version } : {}) });
    } catch {
      setExt({ kind: 'not-connected' });
    }
  };
  useEffect(() => {
    void checkExtension(getSettings().extensionId);
  }, []);

  const addWitness = () => {
    const a = checkAddress(newAddress);
    const label = cleanLabel(newLabel);
    const next: Errors = {};
    if (!a.ok) next.newAddress = ADDRESS_ERROR;
    else if (draft.witnesses.some((w) => w.address.toLowerCase() === a.value.toLowerCase())) {
      next.newAddress = DUPLICATE_WITNESS_ERROR;
    }
    next.newLabel = labelError(label);
    setErrors((e) => ({ ...e, newAddress: next.newAddress, newLabel: next.newLabel }));
    if (next.newAddress || next.newLabel || !a.ok) {
      setFocusInvalid((f) => ({ n: f.n + 1, scope: '.witness-form ' }));
      return;
    }
    setDraft((d) => ({ ...d, witnesses: [...d.witnesses, { address: a.value, label }] }));
    setNewAddress('');
    setNewLabel('');
    setWitnessNote(`${label} is on the list. Save settings to apply it.`);
  };

  const removeWitness = (w: PinnedWitness) => {
    setDraft((d) => ({ ...d, witnesses: d.witnesses.filter((x) => x.address !== w.address) }));
    setWitnessNote(`${w.label} is off the list. Save settings to apply it.`);
  };

  const save = () => {
    const found: Errors = {};
    for (const k of FIELD_KEYS) {
      const err = fieldError(k, draft[k]);
      if (err) found[k] = err;
    }
    setErrors((e) => ({ ...found, newAddress: e.newAddress, newLabel: e.newLabel }));
    if (Object.keys(found).length > 0) {
      setFocusInvalid((f) => ({ n: f.n + 1, scope: '[data-settings-field]' }));
      return;
    }
    const result = saveSettingsChecked(settingsFrom(draft));
    setNotStored(!result.saved);
    setDraft(draftFrom(result.settings));
    setWitnessNote('');
    toast('Settings saved');
    void checkExtension(result.settings.extensionId);
  };

  const doReset = () => {
    setConfirmReset(false);
    const s = resetSettings();
    applyTheme(s.theme);
    setDraft(draftFrom(s));
    setErrors({});
    setNewAddress('');
    setNewLabel('');
    setWitnessNote('');
    setNotStored(false);
    toast('Settings reset to the defaults');
    void checkExtension(s.extensionId);
  };

  const pickTheme = (theme: Theme) => {
    saveSettingsChecked({ theme });
    applyTheme(theme);
  };

  const label = displayName;

  return (
    <>
      <h1 tabIndex={-1}>Settings</h1>
      <p className="lede muted">Saved in this browser only.</p>

      {shared ? (
        <Notice kind="warn" title="Shared address">
          Settings can&apos;t be changed on a shared gateway address. Open the app from its own address (bzz.link or GitHub Pages) to
          change them.
        </Notice>
      ) : null}

      <div ref={form} className="stack settings-form">
        <fieldset className="settings-fieldset" disabled={shared}>
        <legend className="visually-hidden">Witnesses, endpoints and extension</legend>
        <section className="settings-section" aria-labelledby="witnesses-heading">
          <h2 id="witnesses-heading" className="section-title">
            Trusted witnesses
          </h2>
          <Notice kind="warn" title="Only add witnesses you trust">
            Check C passes only for witnesses in this list. Add a witness only if you trust whoever runs it.
          </Notice>
          {draft.witnesses.length === 0 ? (
            <p className="muted">No trusted witnesses. Every signature shows as an unknown witness until you add one.</p>
          ) : (
            <ul className="witness-list" aria-label="Trusted witnesses">
              {draft.witnesses.map((w) => (
                <li key={w.address} className="witness-row">
                  <div>
                    <span className="witness-name">{label(w)}</span>
                    <MonoValue value={w.address} />
                  </div>
                  <button type="button" className="btn btn-secondary btn-compact" onClick={() => removeWitness(w)}>
                    Remove<span className="visually-hidden"> {label(w)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="muted" role="status">
            {witnessNote}
          </p>
          <div className="witness-form">
            <Field
              label="Witness address (0x…)"
              value={newAddress}
              error={errors.newAddress}
              reserveError
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                setNewAddress(e.target.value);
                setErrors((x) => (x.newAddress ? { ...x, newAddress: undefined } : x));
              }}
              onBlur={() => {
                if (newAddress.trim()) setErrors((x) => ({ ...x, newAddress: checkAddress(newAddress).ok ? undefined : ADDRESS_ERROR }));
              }}
            />
            <Field
              label="Label"
              value={newLabel}
              error={errors.newLabel}
              reserveError
              maxLength={MAX_LABEL}
              autoComplete="off"
              helper="A name you will recognise, such as the operator. It is shown with “(added in this browser)”."
              onBlur={() => {
                if (newLabel.trim()) setErrors((x) => ({ ...x, newLabel: labelError(newLabel) }));
              }}
              onChange={(e) => {
                setNewLabel(e.target.value);
                setErrors((x) => (x.newLabel ? { ...x, newLabel: undefined } : x));
              }}
            />
            <div>
              <button type="button" className="btn btn-secondary" onClick={addWitness}>
                Add witness
              </button>
            </div>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="endpoints-heading">
          <h2 id="endpoints-heading" className="section-title">
            Endpoints
          </h2>

          <div className="settings-field">
            <Field
              label="Arkiv RPC URL"
              type="url"
              inputMode="url"
              data-settings-field=""
              value={draft.arkivRpcUrl}
              error={errors.arkivRpcUrl}
              reserveError
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setField('arkivRpcUrl', e.target.value)}
              onBlur={(e) => validate('arkivRpcUrl', e.target.value)}
            />
            <div className="field-actions">
              <ResetButton what="Arkiv RPC URL" onClick={() => setField('arkivRpcUrl', defaults.arkivRpcUrl)} />
            </div>
          </div>

          <div className="settings-field">
            <SecretField
              label="Arkiv access key"
              value={draft.arkivAccessKey}
              error={errors.arkivAccessKey}
              shown={showKey}
              onToggle={() => setShowKey((v) => !v)}
              placeholder={builtInKey ? 'Built-in key (default)' : 'Optional'}
              helper={keyHelper(builtInKey, draft.arkivAccessKey.trim() !== '')}
              onChange={(v) => setField('arkivAccessKey', v)}
              onBlur={(v) => validate('arkivAccessKey', v)}
            />
            <div className="field-actions">
              <ResetButton what="Arkiv access key" onClick={() => setField('arkivAccessKey', '')} />
            </div>
          </div>

          <div className="settings-field">
            <Field
              label="Swarm upload gateway"
              type="url"
              inputMode="url"
              data-settings-field=""
              value={draft.uploadUrl}
              error={errors.uploadUrl}
              reserveError
              spellCheck={false}
              autoComplete="off"
              helper="Used to check that new storage is ready."
              onChange={(e) => setField('uploadUrl', e.target.value)}
              onBlur={(e) => validate('uploadUrl', e.target.value)}
            />
            <div className="field-actions">
              <ResetButton what="Swarm upload gateway" onClick={() => setField('uploadUrl', defaults.uploadUrl)} />
            </div>
          </div>

          <div className="settings-field">
            <TextAreaField
              label="Swarm download gateway"
              value={draft.downloadText}
              error={errors.downloadText}
              helper="Use a different gateway from upload, so checks don't rely on one node. One address per line, tried in order."
              onChange={(v) => setField('downloadText', v)}
              onBlur={() => validate('downloadText', draft.downloadText)}
            />
            <div className="field-actions">
              <ResetButton what="Swarm download gateway" onClick={() => setField('downloadText', defaults.downloadUrls.join('\n'))} />
            </div>
          </div>

          <div className="settings-field">
            <Field
              label="Gnosis RPC URL"
              type="url"
              inputMode="url"
              data-settings-field=""
              value={draft.gnosisRpcUrl}
              error={errors.gnosisRpcUrl}
              reserveError
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setField('gnosisRpcUrl', e.target.value)}
              onBlur={(e) => validate('gnosisRpcUrl', e.target.value)}
            />
            <div className="field-actions">
              <ResetButton what="Gnosis RPC URL" onClick={() => setField('gnosisRpcUrl', defaults.gnosisRpcUrl)} />
            </div>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="extension-heading">
          <h2 id="extension-heading" className="section-title">
            Extension
          </h2>
          <Field
            label="Extension ID"
            data-settings-field=""
            value={draft.extensionId}
            error={errors.extensionId}
            reserveError
            spellCheck={false}
            autoComplete="off"
            helper="Find it on chrome://extensions."
            onChange={(e) => setField('extensionId', e.target.value)}
            onBlur={(e) => validate('extensionId', e.target.value)}
          />
          <p className="muted" role="status" data-testid="extension-status">
            {ext.kind === 'checking' ? 'Checking the extension…' : null}
            {ext.kind === 'connected' ? (
              <span className="inline-ok">
                <CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" />{' '}
                {ext.version ? `Connected · v${ext.version}` : 'Connected'}
              </span>
            ) : null}
            {ext.kind === 'not-connected' ? (
              <span className="inline-ok">
                <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" /> Not connected. Check the ID matches chrome://extensions.
              </span>
            ) : null}
          </p>
        </section>

        </fieldset>

        <section className="settings-section" aria-labelledby="appearance-heading">
          <h2 id="appearance-heading" className="section-title">
            Appearance
          </h2>
          <Segmented<Theme>
            legend="Theme"
            value={saved.theme}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            onChange={pickTheme}
          />
        </section>
      </div>

      {notStored ? (
        <Notice kind="warn" title="Applied for this visit only">
          This browser did not let Recall store the settings, so they are lost when you close this page.
        </Notice>
      ) : null}

      <div className="settings-actions">
        <button type="button" className="btn btn-primary" disabled={shared} onClick={save}>
          Save settings
        </button>
        <button type="button" className="btn btn-secondary" ref={resetTrigger} disabled={shared} onClick={() => setConfirmReset(true)}>
          Reset all
        </button>
        <p className="settings-dirty muted" role="status">
          {dirty ? 'You have changes that are not saved yet.' : ''}
        </p>
      </div>

      <ConfirmDialog
        open={confirmReset}
        title="Reset all settings?"
        confirmLabel="Reset all"
        onConfirm={doReset}
        onCancel={() => {
          setConfirmReset(false);
          resetTrigger.current?.focus();
        }}
      >
        <p>
          This restores the default witness and endpoints, and clears your own access key and extension ID. Captures you
          viewed before are checked again with the defaults.
        </p>
      </ConfirmDialog>
    </>
  );
}

/** A secret input (the Arkiv access key) with a Show toggle. It never displays the built-in key. */
function SecretField({
  label,
  value,
  error,
  shown,
  onToggle,
  placeholder,
  helper,
  onChange,
  onBlur,
}: {
  label: string;
  value: string;
  error?: string;
  shown: boolean;
  onToggle: () => void;
  placeholder: string;
  helper: string;
  onChange: (v: string) => void;
  onBlur: (v: string) => void;
}) {
  const id = useId();
  const describedBy = [`${id}-helper`, error ? `${id}-error` : ''].filter(Boolean).join(' ');
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="secret-row">
        <input
          id={id}
          className="input mono"
          type={shown ? 'text' : 'password'}
          data-settings-field=""
          value={value}
          placeholder={placeholder}
          // Not a login: keep password managers and the browser from offering to save or fill it.
          autoComplete="new-password"
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => onBlur(e.target.value)}
        />
        <button type="button" className="btn btn-secondary btn-compact" aria-pressed={shown} aria-controls={id} onClick={onToggle}>
          {shown ? 'Hide' : 'Show'}
          <span className="visually-hidden"> {label}</span>
        </button>
      </div>
      <p className="field-helper" id={`${id}-helper`}>
        {helper}
      </p>
      {error ? (
        <p className="field-error" id={`${id}-error`}>
          <span>{error}</span>
        </p>
      ) : (
        <div className="field-error-slot" aria-hidden="true" />
      )}
    </div>
  );
}
