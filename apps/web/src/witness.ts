import type { Address } from 'viem';
import { DEFAULT_WITNESS_LABEL, DEVNET_WITNESS, LIVE_WITNESS, defaultWitnessAddress } from './defaults';
import { getSettings, type PinnedWitness } from './settings';

export { DEVNET_WITNESS, LIVE_WITNESS };

export type TrustedWitness = PinnedWitness;

/** What every place that names the built-in witness says (the word "default" is only ever ours, R38). */
export const DEFAULT_WITNESS_NAME = `${DEFAULT_WITNESS_LABEL} (default)`;
/** What follows the name of every witness the person added. */
export const ADDED_SUFFIX = '(added in this browser)';

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The built-in witness of the network: the one witness this app ships with. */
export const isDefaultWitness = (address: Address): boolean => same(address, defaultWitnessAddress());

/**
 * How a trusted witness is named wherever it appears. The built-in witness is named by code,
 * whatever label is stored for it; every other one carries "(added in this browser)", so a
 * witness somebody added can never pass for the built-in one.
 */
export function displayName(w: TrustedWitness): string {
  return isDefaultWitness(w.address) ? DEFAULT_WITNESS_NAME : `${w.label} ${ADDED_SUFFIX}`;
}

/**
 * The pinned witnesses check C trusts: the person's list from Settings (by default the
 * network's Recall witness). It is read fresh on every call, so removing a witness turns
 * its captures into "Unknown witness" the next time any of them is viewed. A signer that is not
 * in the list is never "trusted": check C shows a warning for it. On a shared gateway origin the
 * stored list is ignored and this is the built-in default (R38, see `isSharedOrigin`).
 */
export function trustedWitnesses(): TrustedWitness[] {
  return getSettings().pinnedWitnesses;
}

/** The trusted witness with this address, or undefined when it is not pinned. */
export function trustedWitness(address: Address, list: readonly TrustedWitness[] = trustedWitnesses()): TrustedWitness | undefined {
  return list.find((w) => same(w.address, address));
}

/** The display name of a trusted witness, or undefined when the address is not pinned. */
export function witnessLabel(address: Address, list: readonly TrustedWitness[] = trustedWitnesses()): string | undefined {
  const w = trustedWitness(address, list);
  return w ? displayName(w) : undefined;
}
