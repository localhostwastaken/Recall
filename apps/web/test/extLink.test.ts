import { describe, expect, it } from 'vitest';
import { extensionIdFromLink } from '../src/ext';

// The extension opens the app with `?ext=<its id>` (Approve and, from the popup, Buy storage). The
// id only names which extension to ask on that page; anything that is not a Chrome extension id
// is ignored.

const ID = 'abcdefghijklmnopabcdefghijklmnop';

describe('extensionIdFromLink', () => {
  it('reads a well-formed id after the hash route', () => {
    expect(extensionIdFromLink(`#/storage?ext=${ID}`)).toBe(ID);
    expect(extensionIdFromLink(`#/approve/${'a'.repeat(32)}?ext=${ID}`)).toBe(ID);
  });

  it('ignores a missing or malformed id', () => {
    for (const hash of [
      '#/storage',
      '#/storage?ext=',
      `#/storage?ext=${ID.toUpperCase()}`,
      `#/storage?ext=${ID}q`,
      `#/storage?ext=${'z'.repeat(32)}`,
      `#/storage?ext=${ID.slice(1)}`,
      '',
    ]) {
      expect(extensionIdFromLink(hash), hash).toBeUndefined();
    }
  });
});
