// Gas the fee previews multiply by the Gnosis gas price. Each must cover what mainnet Gnosis
// really used, with room to spare, so a preview errs on the high side. The devnet's Gnosis fork
// uses less (approve 51k, createBatch 357k, topUp 459k), so these come from mainnet receipts
// (test/gas.test.ts lists them).

/** Buying one batch: an xBZZ approval plus createBatch (mainnet: 51,456 + 473,507). */
export const GAS_PER_BATCH = 600_000n;

/** Keep-alive step 1: an xBZZ approval plus the top-up (mainnet: 51,444 + 624,097). */
export const GAS_STEP_1 = 760_000n;
