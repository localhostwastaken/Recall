import { describe, expect, it } from 'vitest';
import { compareGatewayCopy } from '../src/verify/gatewayCopy';

const bytes = (...n: number[]) => new Uint8Array(n);

describe('compareGatewayCopy', () => {
  it('same bytes -> same', () => {
    expect(compareGatewayCopy(bytes(1, 2, 3), bytes(1, 2, 3))).toBe('same');
    expect(compareGatewayCopy(bytes(), bytes())).toBe('same');
  });
  it('anything else that came back -> different, however small the change', () => {
    expect(compareGatewayCopy(bytes(1, 2, 4), bytes(1, 2, 3))).toBe('different');
    expect(compareGatewayCopy(bytes(1, 2), bytes(1, 2, 3))).toBe('different');
    expect(compareGatewayCopy(bytes(1, 2, 3, 0), bytes(1, 2, 3))).toBe('different');
    expect(compareGatewayCopy(bytes(), bytes(0))).toBe('different');
  });
  it('nothing came back -> unavailable (a soft warning, not a block)', () => {
    expect(compareGatewayCopy(null, bytes(1))).toBe('unavailable');
  });
});
