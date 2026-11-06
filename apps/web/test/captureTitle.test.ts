import type { VerifiedFacts } from '@recall/evidence';
import { describe, expect, it } from 'vitest';
import { captureTitle } from '../src/verify/captureTitle';

const facts = { serverName: 'notice.recall.test' } as VerifiedFacts;

describe('captureTitle', () => {
  it('names the host only when a pinned witness signed the capture (check C passed)', () => {
    expect(captureTitle(facts, 'pass')).toBe('Capture of notice.recall.test');
  });

  it('says "Unverified capture" when the witness is not one you trust', () => {
    expect(captureTitle(facts, 'warn')).toBe('Unverified capture');
    expect(captureTitle(facts, 'unavailable')).toBe('Unverified capture');
    expect(captureTitle(facts, undefined)).toBe('Unverified capture');
  });

  it('is a plain title before there are facts', () => {
    expect(captureTitle(null, 'pass')).toBe('Capture');
    expect(captureTitle(null)).toBe('Capture');
  });
});
