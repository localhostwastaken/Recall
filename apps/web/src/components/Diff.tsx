import { useId, useMemo, useState, type ReactNode } from 'react';
import { formatShortDay } from '../format';
import { comparableText, hasChanges, withContext, wordDiff, type DiffPart } from '../timeline/content';
import type { Version } from '../timeline/model';
import { Notice } from '../ui/Notice';
import { Segmented } from '../ui/Segmented';

type Mode = 'inline' | 'side';

const label = (v: Version): string => `Version ${v.n} (${formatShortDay(v.facts.signedAt)})`;

/** One part of a diff: removed text is struck out and added text underlined, each with a hidden word for screen readers. */
function Part({ part }: { part: DiffPart }): ReactNode {
  if (part.kind === 'removed') {
    return (
      <del>
        <span className="visually-hidden">removed: </span>
        {part.text}
      </del>
    );
  }
  if (part.kind === 'added') {
    return (
      <ins>
        <span className="visually-hidden">added: </span>
        {part.text}
      </ins>
    );
  }
  return <>{part.text}</>;
}

function Pick({ name, value, versions, onChange }: { name: string; value: Version; versions: Version[]; onChange: (key: string) => void }) {
  const id = useId();
  return (
    <span className="diff-pick">
      <label htmlFor={id}>{name}</label>
      <select id={id} className="input input-compact" value={value.entityKey} onChange={(e) => onChange(e.target.value)}>
        {versions.map((v) => (
          <option key={v.entityKey} value={v.entityKey}>
            {label(v)}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * "It said X, now says Y": a word diff of the text of two verified versions (default: the two
 * newest). The text comes from the verified bodies, read with DOMParser (no script runs and
 * nothing is inserted into the page); HTML tags and whitespace-only changes are ignored.
 * Only HTML and text files can be compared.
 */
export function Diff({ versions }: { versions: Version[] }) {
  const [pick, setPick] = useState<{ from?: string; to?: string }>({});
  const [mode, setMode] = useState<Mode>('inline');
  const byKey = (key?: string) => versions.find((v) => v.entityKey === key);
  const from = byKey(pick.from) ?? versions[versions.length - 2];
  const to = byKey(pick.to) ?? versions[versions.length - 1];
  const same = from.entityKey === to.entityKey;

  const result = useMemo(() => {
    if (from.entityKey === to.entityKey) return null;
    const a = comparableText(from.facts.body, from.facts.contentType);
    const b = comparableText(to.facts.body, to.facts.contentType);
    if (a === null || b === null) return { kind: 'unsupported' as const };
    const parts = wordDiff(a, b);
    return parts === null ? { kind: 'toolarge' as const } : { kind: 'diff' as const, parts: withContext(parts) };
    // The facts objects are stable while later records are still being checked.
  }, [from.facts, to.facts, from.entityKey, to.entityKey]);

  return (
    <section aria-labelledby="diff-title" className="diff-block">
      <h2 className="section-title" id="diff-title">
        What changed: {label(from)} → {label(to)}
      </h2>
      <div className="diff-controls">
        <Pick name="Compare" value={from} versions={versions} onChange={(k) => setPick({ ...pick, from: k })} />
        <Pick name="with" value={to} versions={versions} onChange={(k) => setPick({ ...pick, to: k })} />
        <Segmented
          legend="View"
          value={mode}
          options={[
            { value: 'inline', label: 'Inline' },
            { value: 'side', label: 'Side by side' },
          ]}
          onChange={setMode}
        />
      </div>
      <p className="muted diff-caption">Text only. HTML tags and whitespace-only changes are ignored.</p>
      {same ? (
        <Notice kind="info" title="Choose two different versions to compare." />
      ) : result?.kind === 'toolarge' ? (
        <Notice kind="info" title="Too different or too large to compare here.">
          These versions are too different, or too long, to compare word by word in the browser. Open each version
          to read it.
        </Notice>
      ) : result?.kind === 'unsupported' ? (
        <Notice kind="info" title="No text comparison for this file type.">
          Only HTML and text pages can be compared word by word.
        </Notice>
      ) : result && !hasChanges(result.parts) ? (
        <Notice kind="info" title="No text changes between these versions.">
          Only HTML tags or whitespace differ.
        </Notice>
      ) : result ? (
        mode === 'inline' ? (
          <p className="diff-text" data-diff="inline">
            {result.parts.map((p, i) => (
              <Part key={i} part={p} />
            ))}
          </p>
        ) : (
          <div className="diff-sides" data-diff="side">
            <div>
              <h3 className="diff-side-title">Before · {label(from)}</h3>
              <p className="diff-text" data-side="old">
                {result.parts
                  .filter((p) => p.kind !== 'added')
                  .map((p, i) => (
                    <Part key={i} part={p} />
                  ))}
              </p>
            </div>
            <div>
              <h3 className="diff-side-title">After · {label(to)}</h3>
              <p className="diff-text" data-side="new">
                {result.parts
                  .filter((p) => p.kind !== 'removed')
                  .map((p, i) => (
                    <Part key={i} part={p} />
                  ))}
              </p>
            </div>
          </div>
        )
      ) : null}
    </section>
  );
}
