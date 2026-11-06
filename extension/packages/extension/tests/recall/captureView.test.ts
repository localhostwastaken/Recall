import { describe, expect, it } from 'vitest';
import type { EvidenceFile } from '@recall/evidence';
import {
  approveUrl,
  storageUrl,
  checkLines,
  jobSteps,
  earlierCopy,
  errorCopy,
  formatElapsed,
  formatUtc,
  pageBlockedReason,
  plainReason,
  uploadCopy,
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

  it('busy witness: retry, not a failure', () => {
    expect(errorCopy('busy', 'recall: witness busy, try again shortly', 'a.example')).toEqual({
      kind: 'warn',
      title: 'Witness busy',
      body: 'The witness is busy. Try again in a minute. Nothing was published.',
      actions: ['retry'],
    });
  });

  it('explains why a page cannot be captured, with the capture rules', () => {
    expect(pageBlockedReason('https://a.example/x')).toBeNull();
    expect(pageBlockedReason('https://a.example./x')).toBeNull();
    expect(pageBlockedReason('http://a.example/')).toBe('Only https:// pages can be captured.');
    expect(pageBlockedReason('https://a.example:8443/')).toBe(
      'Only pages on the standard https port (443) can be captured.',
    );
    expect(pageBlockedReason('https://u:p@a.example/')).toBe(
      'Addresses with a user name or password cannot be captured.',
    );
    expect(pageBlockedReason('chrome://extensions')).toBe('Only https:// pages can be captured.');
  });

  it('opens the approval tab of the web app with the capture id and this extension', () => {
    const id = 'a'.repeat(32);
    const ext = 'b'.repeat(32);
    expect(approveUrl('http://localhost:5173', id, ext)).toBe(`http://localhost:5173/#/approve/${id}?ext=${ext}`);
    expect(approveUrl('https://localhostwastaken.github.io/Recall/app/', id, ext)).toBe(
      `https://localhostwastaken.github.io/Recall/app/#/approve/${id}?ext=${ext}`,
    );
    // Buy storage names the extension too, so the page finds the stamp key without Settings.
    expect(storageUrl('https://localhostwastaken.github.io/Recall/app/', ext)).toBe(
      `https://localhostwastaken.github.io/Recall/app/#/storage?ext=${ext}`,
    );
  });

  it('a kept capture points to the Recall tab, where storage is chosen (R44)', () => {
    expect(uploadCopy({ status: 'pending', captureId: 'x' })).toEqual({
      kind: 'success',
      title: 'Continue in the Recall tab',
      body: 'Choose how to save and publish this capture there. Nothing is uploaded until you do.',
      actions: ['openApprove'],
    });
  });

  it('an unchanged page is confirmed in the Recall tab, with no new upload', () => {
    const k = ('0x' + '1'.repeat(64)) as `0x${string}`;
    expect(uploadCopy({ status: 'confirmation', captureId: 'x', captureKey: k, since: '1793800920' })).toEqual({
      kind: 'info',
      title: 'Continue in the Recall tab',
      body: 'Unchanged since 4 Nov 2026, 14:02 UTC. Confirm it there; no upload is needed.',
      actions: ['openApprove'],
    });
    expect(uploadCopy({ status: 'failed', error: 'storage full.' })).toEqual({
      kind: 'error',
      title: 'Capture not kept',
      body: 'Storage full. Nothing was published.',
      actions: ['copy'],
    });
  });

  it('earlier captures: counts of verified records only, never green', () => {
    const base = {
      urlHash: ('0x' + '2'.repeat(64)) as `0x${string}`,
      timelineUrl: 'http://app/#/u/x',
      records: 0,
      unavailable: 0,
    };
    expect(earlierCopy(undefined)).toEqual({ kind: 'loading', text: 'Checking earlier captures…' });
    expect(earlierCopy({ error: 'rpc down' })).toEqual({
      kind: 'error',
      text: "Couldn't load earlier captures. You can still capture this page.",
    });
    // "None" only for an empty, complete listing.
    expect(earlierCopy({ ...base, trusted: true, versions: 0, confirmations: 0, incomplete: false })).toEqual({
      kind: 'none',
      text: 'No captures of this page yet.',
    });
    expect(earlierCopy({ ...base, trusted: true, versions: 0, confirmations: 0, incomplete: true, records: 2001 })).toEqual({
      kind: 'unchecked',
      text: 'No verified captures among the records checked here. The timeline checks them all.',
      timelineUrl: base.timelineUrl,
    });
    // Records exist but none verified (junk): not "no captures".
    expect(earlierCopy({ ...base, trusted: true, versions: 0, confirmations: 0, incomplete: false, records: 2 }).kind).toBe(
      'unchecked',
    );
    // Evidence unreachable: Not checked (design brief 5), never "none".
    expect(
      earlierCopy({ ...base, trusted: true, versions: 0, confirmations: 0, incomplete: false, records: 1, unavailable: 1 }),
    ).toEqual({
      kind: 'unavailable',
      text: "Earlier captures couldn't be checked right now (their evidence couldn't be downloaded). You can still capture this page.",
      timelineUrl: base.timelineUrl,
    });
    expect(earlierCopy({ ...base, trusted: false, versions: 0, confirmations: 0, incomplete: false })).toEqual({
      kind: 'unchecked',
      text: "No trusted witness is set, so earlier captures can't be checked here.",
      timelineUrl: base.timelineUrl,
    });
    expect(
      earlierCopy({ ...base, trusted: true, versions: 1, confirmations: 1, latest: '1793800920', incomplete: false, records: 2 }),
    ).toEqual({
      kind: 'some',
      counts: '1 version · 1 confirmation',
      latest: 'Latest: 4 Nov 2026, 14:02 UTC',
      timelineUrl: base.timelineUrl,
    });
    expect(
      earlierCopy({ ...base, trusted: true, versions: 2, confirmations: 0, latest: '1793800920', incomplete: true, records: 9 }),
    ).toMatchObject({
      counts: '2 versions · 0 confirmations',
      note: 'Some records were not checked here. The timeline checks them all.',
    });
    expect(
      earlierCopy({ ...base, trusted: true, versions: 1, confirmations: 0, latest: '1', incomplete: false, records: 3, unavailable: 2 }),
    ).toMatchObject({ kind: 'some', note: "2 records couldn't be checked right now. The timeline checks them all." });
  });

  it('steps: the capture, then the same-page check when witnesses are pinned; no upload step (R44)', () => {
    const pinned = jobSteps({ step: 2, lookupPlanned: true });
    expect(pinned.labels).toEqual([
      'Connecting to the witness',
      'Recording the page (~30 s)',
      'Checking the witness signature',
      'Looking for earlier captures',
    ]);
    expect(pinned.current).toBe(1);
    // During the same-page check the current step is the lookup, not the signature check.
    expect(jobSteps({ step: 3, lookupPlanned: true, lookup: true }).current).toBe(3);
    expect(jobSteps({ step: 3, lookupPlanned: true }).current).toBe(2);
    // Nothing pinned: just the capture's three steps.
    expect(jobSteps({ step: 1 })).toEqual({ labels: expect.any(Array), current: 0 });
    expect(jobSteps({ step: 1 }).labels).toHaveLength(3);
  });
});
