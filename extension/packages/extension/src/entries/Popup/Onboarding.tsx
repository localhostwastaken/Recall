import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRight,
  Camera,
  Check,
  CircleHelp,
  GitBranch,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import './onboarding.css';

// The first-run guide: three short steps, shown once (a flag in chrome.storage.local) and
// reopened any time from the "?" button of the popup header (or openOnboarding()). It is a
// modal dialog over the popup: the page behind it is inert, Esc and Skip close it, and focus
// goes back to where it was. Mount `<Onboarding />` once inside the popup.

/** chrome.storage.local flag: set the first time the guide is shown. */
export const ONBOARDING_KEY = 'recall.onboarded';

/** The repository the guide suggests for a first capture. */
export const EXAMPLE_REPO = 'https://github.com/permissionlesstech/bitchat';

const OPEN_EVENT = 'recall:open-onboarding';

export type OnboardingStep = { title: string; body: string; icon: LucideIcon };

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    title: 'Open a page or a GitHub repo',
    body: 'Go to the page you want to keep. A GitHub repository works too.',
    icon: GitBranch,
  },
  {
    title: 'Click Capture',
    body: 'The witness watches the site answer and signs what it saw. It takes about 30 seconds.',
    icon: Camera,
  },
  {
    title: 'Save it in the Recall tab',
    body: 'MetaMask: buy storage, then publish. Anyone can verify it after.',
    icon: Wallet,
  },
];

/**
 * Whether the guide opens by itself. `?onboarding=1` forces it. A popup opened with an
 * explicit `?tab=` (how the tests drive it) never opens it by itself. Otherwise it opens
 * until the stored flag says it has been shown.
 */
export function shouldAutoOpen(search: string, stored: unknown): boolean {
  const params = new URLSearchParams(search);
  if (params.get('onboarding') === '1') return true;
  if (params.has('tab')) return false;
  return stored !== true;
}

/** Opens the guide (at its first step) from anywhere in the popup. */
export function openOnboarding(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** The "?" icon button for the popup header. `<Onboarding />` places one there by itself. */
export function OnboardingHelpButton() {
  return (
    <button
      type="button"
      className="icon-btn ob-help"
      aria-label="How Recall works"
      data-onboarding-help=""
      onClick={openOnboarding}
    >
      <CircleHelp size={20} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

async function readFlag(): Promise<unknown> {
  try {
    return (await chrome.storage.local.get(ONBOARDING_KEY))[ONBOARDING_KEY];
  } catch {
    return true; // storage unavailable: never nag
  }
}

function writeFlag(): void {
  try {
    void chrome.storage.local.set({ [ONBOARDING_KEY]: true }).catch(() => undefined);
  } catch {
    /* nothing to remember it with */
  }
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Onboarding({ showHelpButton = true }: { showHelpButton?: boolean }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [tools, setTools] = useState<Element | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const show = useCallback(() => {
    const active = document.activeElement;
    returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setStep(0);
    setOpen(true);
    writeFlag();
  }, []);

  // First run: open once, then remember that it has been shown.
  useEffect(() => {
    let live = true;
    void readFlag().then((stored) => {
      if (live && shouldAutoOpen(window.location.search, stored)) show();
    });
    return () => {
      live = false;
    };
  }, [show]);

  useEffect(() => {
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, [show]);

  // The "?" button lives in the popup header next to Settings.
  useEffect(() => {
    if (showHelpButton) setTools(document.querySelector('.popup-header-tools'));
  }, [showHelpButton]);

  // While the guide is open the popup behind it is inert; closing gives the focus back.
  useEffect(() => {
    if (!open) return;
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    return () => {
      root?.removeAttribute('inert');
      const back = returnTo.current;
      returnTo.current = null;
      (back?.isConnected
        ? back
        : document.querySelector<HTMLElement>('[data-onboarding-help]')
      )?.focus();
    };
  }, [open]);

  // Each step puts the keyboard on its heading, so a screen reader reads the new step.
  useEffect(() => {
    if (open) title.current?.focus();
  }, [open, step]);

  const close = useCallback(() => setOpen(false), []);
  const last = step === ONBOARDING_STEPS.length - 1;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    // Keep Tab inside the guide.
    const items = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
      (el) => !el.closest('[hidden]'),
    );
    if (items.length === 0) return;
    const first = items[0];
    const end = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === title.current)) {
      e.preventDefault();
      end.focus();
    } else if (!e.shiftKey && active === end) {
      e.preventDefault();
      first.focus();
    }
  };

  const current = ONBOARDING_STEPS[step];
  const Icon = current.icon;

  return (
    <>
      {tools && showHelpButton ? createPortal(<OnboardingHelpButton />, tools) : null}
      {open
        ? createPortal(
            <div
              ref={dialog}
              className="ob"
              role="dialog"
              aria-modal="true"
              aria-label="How Recall works"
              onKeyDown={onKeyDown}
            >
              <div className="ob-top">
                <p className="ob-count" aria-live="polite">
                  Step {step + 1} of {ONBOARDING_STEPS.length}
                </p>
                <button
                  type="button"
                  className="btn btn-ghost ob-skip"
                  hidden={last}
                  onClick={close}
                >
                  Skip
                </button>
              </div>

              <ol className="ob-markers" aria-hidden="true">
                {ONBOARDING_STEPS.map((s, i) => (
                  <li
                    key={s.title}
                    className={`ob-marker${i < step ? ' ob-marker-done' : i === step ? ' ob-marker-active' : ''}`}
                  >
                    {i < step ? <Check size={18} strokeWidth={2.25} /> : i + 1}
                  </li>
                ))}
              </ol>

              <section className="ob-card">
                <span className="ob-icon" aria-hidden="true">
                  <Icon size={28} strokeWidth={1.75} />
                </span>
                <h2 className="ob-title" tabIndex={-1} ref={title}>
                  {current.title}
                </h2>
                <p className="ob-body">{current.body}</p>
                {step === 0 ? (
                  <p className="ob-tip">
                    <span>Try it on</span>
                    <a className="ob-link" href={EXAMPLE_REPO} target="_blank" rel="noreferrer">
                      github.com/permissionlesstech/bitchat
                    </a>
                  </p>
                ) : null}
              </section>

              <div className="ob-actions">
                {step > 0 ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setStep(step - 1)}
                  >
                    Back
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-primary ob-next"
                  onClick={() => (last ? close() : setStep(step + 1))}
                >
                  {last ? 'Got it' : 'Next'}
                  {last ? null : <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />}
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
