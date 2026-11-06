import type { CheckResult, VerifiedFacts } from '@recall/evidence';

/**
 * The page title of a capture. `Capture of <host>` only when the facts are verified and check C
 * passed (a witness you trust signed them); `Unverified capture` when the facts come from a
 * witness you have not pinned, so the host in them is a claim; a plain title until then.
 */
export const captureTitle = (facts: VerifiedFacts | null, witnessCheck?: CheckResult['status']): string =>
  !facts ? 'Capture' : witnessCheck === 'pass' ? `Capture of ${facts.serverName}` : 'Unverified capture';
