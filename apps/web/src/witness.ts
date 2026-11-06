import type { Address } from 'viem';
import { DEVNET_WITNESS, LIVE_WITNESS } from './defaults';
import { getSettings, type PinnedWitness } from './settings';

export { DEVNET_WITNESS, LIVE_WITNESS };

export type TrustedWitness = PinnedWitness;

/**
 * The pinned witnesses check C trusts: the person's list from Settings (by default the
 * network's Recall witness). It is read fresh on every call, so removing a witness turns
 * its captures into "Unknown witness" the next time any of them is viewed. A signer that is not
 * in the list is never "trusted": check C shows a warning for it.
 */
export function trustedWitnesses(): TrustedWitness[] {
  return getSettings().pinnedWitnesses;
}

/** The label of a trusted witness, or undefined when the address is not pinned. */
export function witnessLabel(address: Address, list: readonly TrustedWitness[] = trustedWitnesses()): string | undefined {
  return list.find((w) => w.address.toLowerCase() === address.toLowerCase())?.label;
}
