import { Check, Circle, CircleX, LoaderCircle } from 'lucide-react';

export type StepState = 'waiting' | 'active' | 'done' | 'failed';

const WORD: Record<StepState, string> = {
  waiting: 'waiting',
  active: 'in progress',
  done: 'done',
  failed: 'failed',
};

/** Numbered steps with a "Step k of n" line (announced politely when it changes). */
export function Steps({ steps }: { steps: { label: string; state: StepState }[] }) {
  const current = Math.max(
    0,
    steps.findIndex((s) => s.state === 'active' || s.state === 'failed'),
  );
  return (
    <div className="steps">
      <p className="steps-count" aria-live="polite">
        Step {current + 1} of {steps.length}
      </p>
      <ol className="steps-list">
        {steps.map((s) => {
          const Icon =
            s.state === 'done'
              ? Check
              : s.state === 'failed'
                ? CircleX
                : s.state === 'active'
                  ? LoaderCircle
                  : Circle;
          return (
            <li
              key={s.label}
              className={`step step-${s.state}`}
              aria-current={s.state === 'active' ? 'step' : undefined}
            >
              <Icon
                size={16}
                strokeWidth={1.75}
                aria-hidden="true"
                className={s.state === 'active' ? 'spin step-icon' : 'step-icon'}
              />
              <span>{s.label}</span>
              <span className="visually-hidden"> ({WORD[s.state]})</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
