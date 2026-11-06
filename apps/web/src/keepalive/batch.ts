import type { BatchInfo } from '@recall/net';

/** Capture batches are depth 17 (depth 18 is for the app-hosting batch). */
export const RECALL_BATCH_DEPTHS: readonly number[] = [17, 18];

export type BatchVerdict =
  | { kind: 'ok'; depth: number }
  | { kind: 'missing' }
  | { kind: 'unsupported'; depth: number };

/**
 * A record names its batch id freely, so before a top-up is priced or paid the batch is read from
 * the postage contract: it must exist (non-zero owner), and its depth must be one Recall creates,
 * so a crafted record cannot point the person's xBZZ at some huge unrelated batch. The price is
 * then computed for that same on-chain depth.
 */
export function classifyBatch(batch: BatchInfo | null): BatchVerdict {
  if (batch === null) return { kind: 'missing' };
  if (!RECALL_BATCH_DEPTHS.includes(batch.depth)) return { kind: 'unsupported', depth: batch.depth };
  return { kind: 'ok', depth: batch.depth };
}
