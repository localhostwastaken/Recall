import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LogLevel, logLevelToName, logger } from '@tlsn/common';
import { getStoredLogLevel, setStoredLogLevel } from '../../utils/logLevelStorage';
import { SettingsPanel } from '../Popup/SettingsPanel';
import '../../recall/ui/tokens.css';
import '../../recall/ui/base.css';
import './options.css';

const LOG_LEVELS: { level: LogLevel; description: string }[] = [
  { level: LogLevel.DEBUG, description: 'All logs (verbose)' },
  { level: LogLevel.INFO, description: 'Informational and above' },
  { level: LogLevel.WARN, description: 'Warnings and errors only (default)' },
  { level: LogLevel.ERROR, description: 'Errors only' },
];

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
      <SettingsPanel heading={false} />
      <LoggingSettings />
    </main>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<Options />);
}
