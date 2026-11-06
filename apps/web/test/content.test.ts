import { describe, expect, it } from 'vitest';
import { MAX_DIFF_CHARS, contentKind, hasChanges, withContext, wordDiff, type DiffPart } from '../src/timeline/content';

describe('contentKind', () => {
  it('reads the media type, ignoring parameters and case', () => {
    expect(contentKind('text/html; charset=utf-8')).toBe('html');
    expect(contentKind('TEXT/HTML')).toBe('html');
    expect(contentKind('application/pdf')).toBe('pdf');
    expect(contentKind('text/plain')).toBe('text');
    expect(contentKind('application/json')).toBe('text');
    expect(contentKind('application/ld+json')).toBe('text');
    expect(contentKind('image/png')).toBe('other');
    expect(contentKind(undefined)).toBe('other');
  });
});

describe('wordDiff', () => {
  it('marks the changed word and nothing else', () => {
    const parts = wordDiff('Deadline: 15 December', 'Deadline: 12 December')!;
    expect(parts.filter((p) => p.kind === 'removed').map((p) => p.text.trim())).toEqual(['15']);
    expect(parts.filter((p) => p.kind === 'added').map((p) => p.text.trim())).toEqual(['12']);
    expect(hasChanges(parts)).toBe(true);
  });

  it('ignores whitespace-only changes', () => {
    expect(hasChanges(wordDiff('a  b\nc', 'a b c')!)).toBe(false);
  });

  const words = (n: number, seed: number) => {
    let x = seed;
    return Array.from({ length: n }, () => {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      return x.toString(36).slice(0, 5);
    }).join(' ');
  };

  it('gives up (null) on two very different texts, quickly, instead of freezing', () => {
    const started = Date.now();
    expect(wordDiff(words(8000, 1), words(8000, 2))).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('gives up on a text over the length limit without looking at it', () => {
    const big = 'a '.repeat(MAX_DIFF_CHARS / 2 + 1);
    expect(big.length).toBeGreaterThan(MAX_DIFF_CHARS);
    expect(wordDiff(big, 'a')).toBeNull();
    expect(wordDiff('a', big)).toBeNull();
  });

  it('still diffs a long text with a few edits', () => {
    const a = words(5000, 3);
    const b = a.replace(/^(\S+) /, 'changed ');
    const parts = wordDiff(a, b)!;
    expect(parts).not.toBeNull();
    expect(hasChanges(parts)).toBe(true);
  });
});

describe('withContext', () => {
  const same = (n: number): DiffPart => ({ kind: 'same', text: Array.from({ length: n }, (_, i) => `w${i}`).join(' ') });
  it('shortens a long unchanged run around a change and keeps short ones whole', () => {
    const parts: DiffPart[] = [same(200), { kind: 'removed', text: ' old ' }, { kind: 'added', text: ' new ' }, same(10)];
    const out = withContext(parts);
    expect(out[0].text.startsWith('…')).toBe(true); // nothing before the first change to show
    expect(out[0].text.split(/\s+/).length).toBeLessThan(40);
    expect(out[3]).toEqual(parts[3]);
  });
});
