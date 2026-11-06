import type { VerifiedFacts } from '@recall/evidence';

/** `Capture of <host>` once the verified facts name the host; a plain title until then. */
export const captureTitle = (facts: VerifiedFacts | null): string =>
  facts ? `Capture of ${facts.serverName}` : 'Capture';
