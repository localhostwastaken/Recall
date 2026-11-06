/**
 * When the publish page may show its storage choice (buy, or free storage): only once everything
 * that decides the primary action has been read, so a button never changes its meaning under the
 * pointer. Pure, so it is unit-tested without a browser.
 */
export type ChoiceInputs = {
  /** The storage price read for the batch. */
  price: 'loading' | 'error' | 'ready';
  /** The account the wallet shares with this page; null: none (or not read yet). */
  account: string | null;
  /** The xBZZ balance read; `for` is the account it was read for. */
  funds: { kind: 'loading' | 'unknown' | 'ready'; for?: string };
  /** The wallet has been asked once which account it shares (no prompt). */
  walletChecked: boolean;
  hasProvider: boolean;
};

export function choiceSettled(i: ChoiceInputs): boolean {
  if (i.price === 'loading') return false;
  // A connected wallet: its balance must be read (or have failed) for this very account.
  if (i.account) return i.funds.kind !== 'loading' && i.funds.for === i.account;
  // No account: "not connected" only once the wallet has answered (or there is no wallet).
  return i.walletChecked || !i.hasProvider;
}
