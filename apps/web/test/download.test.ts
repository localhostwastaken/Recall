import { describe, expect, it } from 'vitest';
import { evidenceDownloadOptions } from '../src/download';

describe('evidenceDownloadOptions (R13)', () => {
  it('skips the Swarm root check only for the all-zero batch id', () => {
    expect(evidenceDownloadOptions(`0x${'0'.repeat(64)}`)).toEqual({ verifyRoot: false });
    expect(evidenceDownloadOptions(`0x${'0'.repeat(64)}`.toUpperCase().replace('0X', '0x'))).toEqual({ verifyRoot: false });
  });

  it('keeps the root check for every real batch id and anything that is not exactly zero', () => {
    for (const id of [
      `0x${'1'.repeat(64)}`,
      `0x${'0'.repeat(63)}1`,
      `0x${'0'.repeat(63)}`,
      `0x${'0'.repeat(65)}`,
      `${'0'.repeat(64)}`,
      '0x',
      '',
    ]) {
      expect(evidenceDownloadOptions(id), id).toEqual({ verifyRoot: true });
    }
  });
});
