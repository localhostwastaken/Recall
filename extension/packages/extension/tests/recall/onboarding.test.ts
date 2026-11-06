import { describe, expect, it, vi } from 'vitest';

// The stylesheet goes through the build's PostCSS pipeline, which a unit test does not need.
vi.mock('../../src/entries/Popup/onboarding.css', () => ({}));

import {
  EXAMPLE_REPO,
  ONBOARDING_KEY,
  ONBOARDING_STEPS,
  shouldAutoOpen,
} from '../../src/entries/Popup/Onboarding';

describe('first-run guide', () => {
  it('has the three short steps, in order', () => {
    expect(ONBOARDING_STEPS.map((s) => s.title)).toEqual([
      'Open a page or a GitHub repo',
      'Click Capture',
      'Save it in the Recall tab',
    ]);
    expect(EXAMPLE_REPO).toBe('https://github.com/permissionlesstech/bitchat');
    expect(ONBOARDING_KEY).toBe('recall.onboarded');
  });

  it('opens by itself until it has been shown once', () => {
    expect(shouldAutoOpen('', undefined)).toBe(true);
    expect(shouldAutoOpen('', false)).toBe(true);
    expect(shouldAutoOpen('', true)).toBe(false);
  });

  it('stays closed for a popup opened with an explicit tab, unless forced', () => {
    expect(shouldAutoOpen('?tab=12', undefined)).toBe(false);
    expect(shouldAutoOpen('?tab=12&onboarding=1', true)).toBe(true);
    expect(shouldAutoOpen('?onboarding=1', true)).toBe(true);
  });
});
