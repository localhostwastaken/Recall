import type { Address } from 'viem';
import { getNetConfig } from './net';

/** The witness of the local devnet (Hardhat account #2: a public, test-only key). */
export const DEVNET_WITNESS: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
/** The live Recall witness (its key stays on the operator's machine). */
export const LIVE_WITNESS: Address = '0xC9319e18e86cd7EB653c0Ed0693c0cf5B63db37D';

export type TrustedWitness = { address: Address; label: string };

/**
 * The pinned witnesses check C trusts: the network's default Recall witness plus any extra
 * addresses the config pins. (Settings will let the person edit this list.) A signer that is
 * not in the list is never "trusted": check C shows a warning for it.
 */
export function trustedWitnesses(): TrustedWitness[] {
  const cfg = getNetConfig();
  const own = cfg.arkiv.chain === 'local' ? DEVNET_WITNESS : LIVE_WITNESS;
  const list: TrustedWitness[] = [{ address: own, label: 'Recall Witness' }];
  for (const address of cfg.witness.pinned) {
    if (!list.some((w) => w.address.toLowerCase() === address.toLowerCase())) list.push({ address, label: 'Pinned witness' });
  }
  return list;
}

/** The label of a trusted witness, or undefined when the address is not pinned. */
export function witnessLabel(address: Address, list: readonly TrustedWitness[] = trustedWitnesses()): string | undefined {
  return list.find((w) => w.address.toLowerCase() === address.toLowerCase())?.label;
}
