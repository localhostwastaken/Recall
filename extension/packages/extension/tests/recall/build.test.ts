import { describe, expect, it } from 'vitest';
import { rootCertsFromBase64 } from '../../src/recall/build';

describe('rootCertsFromBase64', () => {
  it('is undefined when no dev CA was given (Mozilla roots stay in use)', () => {
    expect(rootCertsFromBase64(undefined)).toBeUndefined();
    expect(rootCertsFromBase64('')).toBeUndefined();
  });

  it('decodes one DER certificate into a byte array, ignoring line breaks', () => {
    // 0x30 0x82 0x01 0x02 0xff: the start of a DER SEQUENCE plus one high byte.
    expect(rootCertsFromBase64('MIIB\nAv8=')).toEqual([[0x30, 0x82, 0x01, 0x02, 0xff]]);
  });
});
