import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { looksLikeEvidence } from '../src/verify/CheckPanel';

// Check D compares a copy of the page; a Recall evidence file dropped there is turned away.
describe('looksLikeEvidence', () => {
  it('recognises a real evidence file (the live notice capture, from Swarm)', () => {
    const bytes = new Uint8Array(readFileSync(join(__dirname, 'fixtures/notice-evidence.json')));
    expect(looksLikeEvidence(bytes)).toBe(true);
  });

  it('does not treat a page copy, other JSON or binary as evidence', () => {
    const enc = new TextEncoder();
    expect(looksLikeEvidence(enc.encode('<h1>Mumbai Institute of Studies</h1>'))).toBe(false);
    expect(looksLikeEvidence(enc.encode('{"schema":"something.else"}'))).toBe(false);
    expect(looksLikeEvidence(new Uint8Array([0xff, 0xfe, 0x00, 0x01]))).toBe(false);
  });
});
