import { describe, expect, it } from 'vitest';
import { EXAMPLE_CAPTURE_HREF, EXAMPLE_CAPTURE_KEY, METAMASK_URL, RELEASE_URL } from '../src/components/TryIt';
import { parseHash } from '../src/router';

describe('Try it in 2 minutes', () => {
  it('"Verify an example" opens the live capture\'s record page', () => {
    expect(parseHash(EXAMPLE_CAPTURE_HREF)).toEqual({ name: 'capture', key: EXAMPLE_CAPTURE_KEY });
  });

  it('links to the release and to MetaMask over https', () => {
    expect(RELEASE_URL).toBe('https://github.com/localhostwastaken/Recall/releases/tag/v0.1.0-mumbai');
    expect(new URL(METAMASK_URL).protocol).toBe('https:');
  });
});
