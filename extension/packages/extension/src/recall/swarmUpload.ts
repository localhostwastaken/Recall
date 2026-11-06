// Offscreen document: stamps the evidence file with the stamp key (client-side postage,
// bee-js Stamper) and uploads it chunk by chunk to the Swarm upload URL. Kept out of the
// service worker, so bee-js never lands in the worker bundle.
import { createPublicClient, http, type Hex } from 'viem';
import { encodeEvidence } from '@recall/evidence';
import { Stamper, uploadStamped } from '@recall/net/swarm';
import { withTimeout } from './captureParts';
import { decodeStamperState, encodeStamperState } from './poolState';
import {
  UPLOAD_TIMEOUT_MS,
  type OffscreenUpload,
  type UploadCandidate,
  type UploadOutcome,
} from './uploadParts';

/** Bee accepts stamps about this many blocks after the batch was created (bee 2.8: ~11). */
const USABLE_AFTER_BLOCKS = 12;
const POLL_MS = 2_000;

export type UploadDeps = {
  fetch: typeof fetch;
  /** Current Gnosis block, for the chain fallback when Bee hides /batches. */
  blockNumber: () => Promise<bigint>;
  upload: typeof uploadStamped;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

type BeeView = { starts: Map<string, number>; block: number };

/** Bee's own view of the chain (`/batches` + `/chainstate`), or null when it does not share it. */
async function beeView(uploadUrl: string, f: typeof fetch): Promise<BeeView | null> {
  try {
    const base = uploadUrl.replace(/\/+$/, '');
    const opts = {
      signal: AbortSignal.timeout(5_000),
      credentials: 'omit' as const,
      cache: 'no-store' as const,
    };
    const [b, c] = await Promise.all([f(`${base}/batches`, opts), f(`${base}/chainstate`, opts)]);
    if (!b.ok || !c.ok) return null;
    const list = ((await b.json()) as { batches?: { batchID?: unknown; start?: unknown }[] })
      .batches;
    const { block } = (await c.json()) as { block?: unknown };
    if (!Array.isArray(list) || typeof block !== 'number') return null;
    const starts = new Map<string, number>();
    for (const x of list) {
      if (typeof x.batchID === 'string' && typeof x.start === 'number') {
        starts.set(x.batchID.replace(/^0x/, '').toLowerCase(), x.start);
      }
    }
    return { starts, block };
  } catch {
    return null;
  }
}

/**
 * The first candidate the upload node accepts stamps for now. Bee's view decides when it
 * shares one; otherwise (public gateways) the chain does: 12 blocks after the batch's start.
 */
export async function pickUsable(
  candidates: UploadCandidate[],
  uploadUrl: string,
  d: Pick<UploadDeps, 'fetch' | 'blockNumber'>,
): Promise<UploadCandidate | null> {
  const view = await beeView(uploadUrl, d.fetch);
  let block: bigint | null = null;
  for (const c of candidates) {
    if (view) {
      const start = view.starts.get(c.batchId.replace(/^0x/, '').toLowerCase());
      if (start !== undefined && view.block >= start + USABLE_AFTER_BLOCKS) return c;
      continue;
    }
    try {
      block ??= await d.blockNumber();
    } catch {
      return null;
    }
    if (block >= BigInt(c.startBlock) + BigInt(USABLE_AFTER_BLOCKS)) return c;
  }
  return null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0];

/**
 * Picks a usable batch (waiting up to `req.waitMs` for fresh ones), stamps and uploads
 * `encodeEvidence(req.evidence)`. Returns the Swarm reference and the batch's new bucket
 * heights; on failure, the heights too (stamped slots must not be reused). Never throws.
 */
export async function uploadEvidence(
  req: OffscreenUpload,
  deps: Partial<UploadDeps> = {},
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  const d: UploadDeps = {
    fetch: deps.fetch ?? ((...a) => fetch(...a)),
    blockNumber:
      deps.blockNumber ??
      (() => createPublicClient({ transport: http(req.gnosisRpcUrl) }).getBlockNumber()),
    upload: deps.upload ?? uploadStamped,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now ?? Date.now,
  };
  let bytes: Uint8Array;
  try {
    bytes = encodeEvidence(req.evidence);
  } catch (err) {
    return {
      ok: false,
      code: 'failed',
      error: `the evidence could not be encoded: ${message(err)}`,
    };
  }

  const deadline = d.now() + req.waitMs;
  let chosen: UploadCandidate | null = null;
  for (;;) {
    chosen = await pickUsable(req.candidates, req.uploadUrl, d);
    if (chosen || signal?.aborted || d.now() >= deadline) break;
    await d.sleep(POLL_MS);
  }
  if (signal?.aborted) return { ok: false, code: 'failed', error: 'upload cancelled' };
  if (!chosen) {
    return {
      ok: false,
      code: 'not_ready',
      error: 'the storage batches are not usable yet (new storage takes about 1-2 minutes)',
    };
  }

  const stamper = chosen.stamper?.length
    ? Stamper.fromState(
        req.stampKey,
        chosen.batchId,
        decodeStamperState(chosen.stamper),
        chosen.depth,
      )
    : Stamper.fromBlank(req.stampKey, chosen.batchId, chosen.depth);
  try {
    const evidenceRef: Hex = await withTimeout(
      d.upload(bytes, { uploadUrl: req.uploadUrl, stamper }),
      UPLOAD_TIMEOUT_MS,
      `the upload did not finish within ${UPLOAD_TIMEOUT_MS / 1000} s`,
    );
    return {
      ok: true,
      batchId: chosen.batchId,
      evidenceRef: evidenceRef.toLowerCase() as Hex,
      stamper: encodeStamperState(stamper.getState()),
    };
  } catch (err) {
    return {
      ok: false,
      code: 'failed',
      error: `the upload to Swarm failed: ${message(err)}`,
      batchId: chosen.batchId,
      stamper: encodeStamperState(stamper.getState()),
    };
  }
}
