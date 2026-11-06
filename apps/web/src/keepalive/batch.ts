import { BUCKET_DEPTH, type BatchInfo } from '@recall/net';

/** Capture batches are depth 17 (depth 18 is for the app-hosting batch). */
export const RECALL_BATCH_DEPTHS: readonly number[] = [17, 18];

export type BatchVerdict =
  | { kind: 'ok'; depth: number }
  | { kind: 'missing' }
  /** `why`: the batch is mutable (its owner can change its size later), or its bucket depth or its depth is not Recall's. */
  | { kind: 'unsupported'; depth: number; why: 'mutable' | 'bucket' | 'depth' };

/**
 * A record names its batch id freely, so before a top-up is priced or paid the batch is read from
 * the postage contract: it must exist (non-zero owner), and be one Recall itself creates (`buyBatch`
 * always makes immutable batches with bucket depth 16 and depth 17 or 18). An immutable batch's size
 * can never change, so what is priced is what is paid; a mutable one could be made twice as big by
 * its owner between the preview and the payment. The price is then computed for that same depth.
 */
export function classifyBatch(batch: BatchInfo | null): BatchVerdict {
  if (batch === null) return { kind: 'missing' };
  if (!batch.immutable) return { kind: 'unsupported', depth: batch.depth, why: 'mutable' };
  if (batch.bucketDepth !== BUCKET_DEPTH) return { kind: 'unsupported', depth: batch.depth, why: 'bucket' };
  if (!RECALL_BATCH_DEPTHS.includes(batch.depth)) return { kind: 'unsupported', depth: batch.depth, why: 'depth' };
  return { kind: 'ok', depth: batch.depth };
}
