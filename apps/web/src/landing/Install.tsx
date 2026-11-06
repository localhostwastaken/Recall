import './landing.css';
import { Download } from 'lucide-react';
import { RELEASE_URL } from '../components/TryIt';
import { OutLink } from './Sponsors';

export const ARKIV_FAUCET_URL = 'https://hub.arkiv.network/faucet';

const STEPS = [
  { title: 'Download', text: 'Get the zip from the GitHub release and unzip it.' },
  { title: 'Load it', text: 'Open chrome://extensions, turn on Developer mode, choose Load unpacked.' },
  { title: 'Capture', text: 'Open any public page and press Capture in the Recall popup.' },
] as const;

/** Section 5, "Capture your own in two minutes": three steps and the download. */
export function Install() {
  return (
    <section id="install" className="lsec" aria-labelledby="install-title">
      <h2 className="lsec-title" id="install-title">
        Capture your own in two minutes
      </h2>
      <p className="lsec-intro">The extension isn't in the Chrome Web Store yet, so it loads in three steps.</p>
      <ol className="inst-grid">
        {STEPS.map((s, i) => (
          <li key={s.title} className="inst-step">
            <span className="inst-n" aria-hidden="true">
              {i + 1}
            </span>
            <h3 className="inst-title">{s.title}</h3>
            <p>{s.text}</p>
          </li>
        ))}
      </ol>
      <p className="inst-note">
        Saving a capture uses MetaMask and free test tokens (tGLM from the{' '}
        <OutLink href={ARKIV_FAUCET_URL}>Arkiv faucet</OutLink>); free storage needs no xBZZ.
      </p>
      <a className="btn btn-primary land-btn" href={RELEASE_URL} target="_blank" rel="noreferrer">
        <Download size={16} strokeWidth={1.75} aria-hidden="true" />
        Download the extension
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
    </section>
  );
}
