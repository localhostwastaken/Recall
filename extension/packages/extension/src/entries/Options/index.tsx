import { useEffect, useId, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LogLevel, logLevelToName, logger } from '@tlsn/common';
import { getStoredLogLevel, setStoredLogLevel } from '../../utils/logLevelStorage';
import { isWitnessUrl, loadSettings, saveSettings } from '../../recall/settings';
import '../../recall/ui/tokens.css';
import '../../recall/ui/base.css';
import './options.css';

const LOG_LEVELS: { level: LogLevel; description: string }[] = [
  { level: LogLevel.DEBUG, description: 'All logs (verbose)' },
  { level: LogLevel.INFO, description: 'Informational and above' },
  { level: LogLevel.WARN, description: 'Warnings and errors only (default)' },
  { level: LogLevel.ERROR, description: 'Errors only' },
];

const URL_ERROR = 'Enter a full address starting with http:// or https://';

/**
 * Asks for access to a witness outside the built-in hosts (optional_host_permissions),
 * so the popup's online check can reach it. Called from the Save click (a user gesture).
 */
async function ensureHostPermission(url: string): Promise<boolean> {
  try {
    // Called first thing in the click, so the user gesture is still there. Chrome answers
    // true at once, without a prompt, when the origin is already allowed.
    return await chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] });
  } catch {
    return false; // e.g. a plain http:// host other than localhost cannot be requested
  }
}

function WitnessSettings() {
  const id = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    loadSettings()
      .then((s) => setValue(s.witnessUrl ?? ''))
      .catch(() => undefined);
  }, []);

  const validate = (v: string) => {
    const bad = !isWitnessUrl(v.trim());
    setError(bad ? URL_ERROR : null);
    return !bad;
  };

  const save = async () => {
    setStatus('');
    if (!validate(value)) return;
    const allowed = await ensureHostPermission(value.trim());
    await saveSettings({ witnessUrl: value.trim() });
    setStatus(
      allowed
        ? 'Settings saved'
        : 'Settings saved. Recall was not allowed to reach this address, so the witness may show as offline.',
    );
  };

  return (
    <section className="options-section" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Witness</h2>
      <div className="field">
        <label htmlFor={`${id}-url`}>Witness URL</label>
        <input
          id={`${id}-url`}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-help${error ? ` ${id}-err` : ''}`}
          onChange={(e) => setValue(e.target.value)}
          onBlur={(e) => validate(e.target.value)}
        />
        <p id={`${id}-help`} className="field-helper">
          The witness that checks and signs your captures, e.g. http://localhost:7047.
        </p>
        {error ? (
          <p id={`${id}-err`} className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="options-actions">
        <button type="button" className="btn btn-primary" onClick={() => void save()}>
          Save settings
        </button>
        <span className="options-status" role="status">
          {status}
        </span>
      </div>
    </section>
  );
}

function LoggingSettings() {
  const [level, setLevel] = useState<LogLevel | null>(null);

  useEffect(() => {
    getStoredLogLevel()
      .then((l) => {
        setLevel(l);
        logger.init(l);
      })
      .catch(() => setLevel(LogLevel.WARN));
  }, []);

  const choose = async (l: LogLevel) => {
    await setStoredLogLevel(l);
    logger.setLevel(l);
    setLevel(l);
  };

  return (
    <section className="options-section" aria-labelledby="logging-h">
      <h2 id="logging-h">Logging</h2>
      <p className="field-helper">Console log detail for debugging. Changes apply at once.</p>
      <fieldset className="radio-list">
        <legend className="visually-hidden">Log level</legend>
        {LOG_LEVELS.map((o) => (
          <label key={o.level}>
            <input
              type="radio"
              name="logLevel"
              checked={level === o.level}
              disabled={level === null}
              onChange={() => void choose(o.level)}
            />
            <span>
              <strong>{logLevelToName(o.level)}</strong> {o.description}
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}

function Options() {
  return (
    <main className="options">
      <h1>Recall settings</h1>
      <p className="options-lede">Saved in this browser only.</p>
      <WitnessSettings />
      <LoggingSettings />
    </main>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<Options />);
}
