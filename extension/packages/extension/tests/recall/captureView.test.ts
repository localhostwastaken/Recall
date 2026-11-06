import { describe, expect, it } from 'vitest';
import type { EvidenceFile } from '@recall/evidence';
import {
  checkLines,
  errorCopy,
  formatElapsed,
  formatUtc,
  plainReason,
  verdict,
} from '../../src/recall/captureView';
import type { CheckSummary } from '../../src/recall/jobState';

const WITNESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const evidence = {
  signer: WITNESS,
  statement: { sentSha256: '0x' + '1'.repeat(64), recvSha256: '0x' + '2'.repeat(64) },
} as unknown as EvidenceFile;

const pass = (detail = 'ok') => ({ status: 'pass' as const, detail });
const facts = {
  canonicalUrl: 'https://notice.recall.test/notice',
  serverName: 'notice.recall.test',
  httpStatus: 200,
  signedAt: '1793800920', // 4 Nov 2026, 14:02 UTC
  witness: WITNESS,
  bodySha256: '0x' + '3'.repeat(64),
  bodySize: 900,
} as CheckSummary['facts'];

describe('capture view copy', () => {
  it('formats dates and elapsed time like the design brief', () => {
    expect(formatUtc(1793800920)).toBe('4 Nov 2026, 14:02 UTC');
    expect(formatElapsed(12_400)).toBe('0:12');
    expect(formatElapsed(75_000)).toBe('1:15');
  });

  it('all three passed: green verdict naming the host and the signed time', () => {
    const checks: CheckSummary = { A: pass(), B: pass(), C: pass(), facts };
    const lines = checkLines(checks, evidence);
    expect(lines.map((l) => l.status)).toEqual(['pass', 'pass', 'pass']);
    expect(lines[1].result).toBe(
      'GET https://notice.recall.test/notice to notice.recall.test, no cookies sent, complete response (HTTP 200).',
    );
    expect(lines[2].result).toBe('Signed by 0x3C44…93BC, which is in your trusted list.');
    expect(verdict(lines, checks)).toEqual({
      kind: 'success',
      title: 'Checks passed',
      body: 'The witness saw these exact bytes from notice.recall.test at 4 Nov 2026, 14:02 UTC.',
    });
  });

  it('unknown witness is a warning, never green', () => {
    const checks: CheckSummary = {
      A: pass(),
      B: pass(),
      C: { status: 'warn', detail: 'unknown' },
      facts,
    };
    const lines = checkLines(checks, evidence);
    expect(lines[2].result).toBe(
      'Signed by an unknown witness 0x3C44…93BC. Trust it only if you trust its operator.',
    );
    const v = verdict(lines, checks);
    expect(v.kind).toBe('warn');
    expect(v.title).toBe("Valid signature, but from a witness you haven't trusted.");
  });

  it('a failed check wins; a non-200 page is a warning', () => {
    const failed: CheckSummary = {
      A: { status: 'fail', detail: 'x' },
      B: pass(),
      C: pass(),
      facts,
    };
    expect(verdict(checkLines(failed, evidence), failed)).toEqual({
      kind: 'error',
      title: "A check failed. Don't rely on this capture.",
    });
    const notFound: CheckSummary = {
      A: pass(),
      B: pass(),
      C: pass(),
      facts: { ...facts!, httpStatus: 404 },
    };
    const lines = checkLines(notFound, evidence);
    expect(lines[1].status).toBe('warn');
    expect(verdict(lines, notFound)).toMatchObject({
      kind: 'warn',
      title: 'The witness saw HTTP 404, not a normal page.',
    });
  });

  it('errors end with "Nothing was published."', () => {
    expect(errorCopy('too_large', 'page too large', 'a.example', 100_574)).toEqual({
      kind: 'error',
      title: 'Page too large',
      body: 'This page is 98.2 KB. Recall can capture pages up to 64 KB for now. Nothing was published.',
      actions: ['ok'],
    });
    expect(errorCopy('failed', 'recall: cookies/auth not allowed', 'a.example').body).toBe(
      'The witness refused this capture: cookies/auth not allowed. Nothing was published.',
    );
    expect(errorCopy('tls', '', 'a.example').body).toBe(
      "a.example doesn't support TLS 1.2, which the witness needs. Nothing was published.",
    );
    expect(errorCopy('cancelled', '', 'a.example').title).toBe(
      'Capture cancelled. Nothing was published.',
    );
    expect(errorCopy('witness_offline', '', 'a.example').actions).toEqual([
      'retry',
      'witnessSettings',
    ]);
    expect(plainReason('the witness returned no signature')).toBe(
      'The witness returned no signature',
    );
  });
});
