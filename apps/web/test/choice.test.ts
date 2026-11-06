import { describe, expect, it } from 'vitest';
import { choiceSettled, type ChoiceInputs } from '../src/storage/choice';

const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const base: ChoiceInputs = {
  price: 'ready',
  account: null,
  funds: { kind: 'unknown' },
  walletChecked: true,
  hasProvider: true,
};
const with_ = (o: Partial<ChoiceInputs>): ChoiceInputs => ({ ...base, ...o });

describe('choiceSettled (the storage choice waits for what decides its primary action)', () => {
  it('waits while the price is read', () => {
    expect(choiceSettled(with_({ price: 'loading' }))).toBe(false);
    expect(choiceSettled(with_({ price: 'loading', account: A, funds: { kind: 'ready', for: A } }))).toBe(false);
  });

  it('a price that failed is settled', () => {
    expect(choiceSettled(with_({ price: 'error' }))).toBe(true);
  });

  it('no account counts as "not connected" only once the wallet was asked', () => {
    expect(choiceSettled(with_({ walletChecked: false }))).toBe(false);
    expect(choiceSettled(with_({ walletChecked: true }))).toBe(true);
    expect(choiceSettled(with_({ walletChecked: false, hasProvider: false }))).toBe(true);
  });

  it('a connected wallet waits for its balance, read for that very account', () => {
    expect(choiceSettled(with_({ account: A, funds: { kind: 'loading' } }))).toBe(false);
    // The balance effect has not started yet: nothing read for this account.
    expect(choiceSettled(with_({ account: A, funds: { kind: 'unknown' } }))).toBe(false);
    expect(choiceSettled(with_({ account: A, funds: { kind: 'ready', for: B } }))).toBe(false);
    expect(choiceSettled(with_({ account: A, funds: { kind: 'ready', for: A } }))).toBe(true);
  });

  it('a balance read that failed is settled', () => {
    expect(choiceSettled(with_({ account: A, funds: { kind: 'unknown', for: A } }))).toBe(true);
  });
});
