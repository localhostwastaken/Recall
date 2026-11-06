import { describe, expect, it } from 'vitest';
import { GAS_PER_BATCH, GAS_STEP_1 } from '../src/gas';

// gasUsed of real mainnet Gnosis receipts from the live checks (docs/evidence-log.md). The
// devnet's Gnosis fork used less (approve 51k, createBatch 357k, topUp 459k), so the fork alone
// cannot tell whether a preview errs on the high side.
const MAINNET = {
  /** P2: approve 0x57969134d16aff5883a3f163e6f45fa7813889adca1a60e7e50811ab9093325f */
  approveForBatch: 51_456n,
  /** P2: createBatch 0x603c269cf0fbe031e1a58a91bdb1e2a9281209fb6fb16e25d41cfb1b81a44cd4 (depth 17) */
  createBatch: 473_507n,
  /** P4: approve 0x1517515019a1807c9bfecf7360c6a08af0cf7d8c5a9f2a2cc858b924fc2013bb */
  approveForTopUp: 51_444n,
  /** P4: topUp 0x3a27fb9a6d9a2d02fe271131e582783fdbba7bfd0fddd7d9b86f35a4358e6954 (depth 17) */
  topUp: 624_097n,
};
/** At least 10% above what was measured. */
const withRoom = (gas: bigint) => (gas * 11n) / 10n;

describe('fee previews', () => {
  it('cover what buying a batch used on mainnet Gnosis, with room to spare', () => {
    expect(GAS_PER_BATCH).toBeGreaterThanOrEqual(withRoom(MAINNET.approveForBatch + MAINNET.createBatch));
  });
  it('cover what a keep-alive top-up used on mainnet Gnosis, with room to spare', () => {
    expect(GAS_STEP_1).toBeGreaterThanOrEqual(withRoom(MAINNET.approveForTopUp + MAINNET.topUp));
  });
});
