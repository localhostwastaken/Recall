import {
  BatchChangedError,
  XBZZ,
  arkivPublic,
  arkivWallet,
  batchTtlSeconds,
  extendEntities,
  isFreeBatch,
  planExtension,
  readArkivExpiry,
  readBatch,
  topUp,
  topUpCost,
  type ArkivExpiry,
  type BatchChange,
  type NetConfig,
} from '@recall/net';
import { createPublicClient, custom, erc20Abi, http, type Account, type Hex, type PublicClient } from 'viem';
import { classifyBatch, type BatchVerdict } from './batch';
import { settle, type Settled } from './settle';
import {
  connectWallet,
  chainFor,
  ensureChain,
  getProvider,
  isUserRejection,
  walletFor,
  WalletError,
  type ChainId,
} from '../wallet';

// The money paths of the keep-alive dialog, kept out of the component so each can be read (and
// tested) on its own. Nothing here claims success from what it meant to do: callers re-read the
// batch and the record from their chains afterwards (`readEnds`).

/** What a keep-alive acts on. */
export type KeepAliveTarget = {
  /**
   * Arkiv records to extend: the one being viewed first, then (for a confirmation) the capture it
   * confirms. All go in one transaction, so there is one wallet prompt for any number of them.
   */
  entityKeys: Hex[];
  /**
   * The Swarm batch to top up: the capture's own, or its parent capture's for a confirmation.
   * null (or the all-zero id) means the evidence is on a gateway's free storage, which cannot be extended.
   */
  batchId: Hex | null;
};

/** The chain the Arkiv records live on, for the wallet's network switch. */
export const arkivChainId = (cfg: NetConfig): ChainId => (cfg.arkiv.chain === 'local' ? 1337 : 7794095);

export const isFree = (t: KeepAliveTarget): boolean => t.batchId === null || isFreeBatch(t.batchId);

/**
 * Gas for step 1: an xBZZ approval (51k) plus the top-up (459k), both measured on the Gnosis fork
 * for a depth-17 batch and rounded up so the fee preview errs on the high side.
 */
const GAS_STEP_1 = 540_000n;

const gnosisClient = (cfg: NetConfig): PublicClient =>
  createPublicClient({ chain: chainFor(100), transport: http(cfg.gnosis.rpcUrl) }) as PublicClient;

const secondsFromNow = (seconds: number): Date | null => {
  const d = new Date(Date.now() + seconds * 1000);
  return Number.isFinite(seconds) && !Number.isNaN(d.getTime()) ? d : null;
};

export type SwarmQuote =
  | {
      kind: 'ok';
      depth: number;
      /** xBZZ (16 decimals) per chunk of the top-up; `total` is this times 2^depth. */
      perChunk: bigint;
      /** xBZZ (16 decimals) the top-up costs, rounded up by the caller for display. It is also the most a payment may cost. */
      total: bigint;
      /** The Gnosis fee for step 1, in xDAI wei. */
      fee: bigint;
      /** Where the batch ends after the top-up; null when it has already run out (it cannot be topped up). */
      endsAt: Date | null;
      expired: boolean;
    }
  /** The record's batch id names no batch on Gnosis, or one of a size Recall never creates: step 1 is off. */
  | { kind: 'missing' }
  | Extract<BatchVerdict, { kind: 'unsupported' }>
  /** Gnosis could not be read (rate limit, no network): storage can't be priced now, but the record can still be extended. */
  | { kind: 'unreadable' };

export type Quote = {
  /** null for a capture on free storage. */
  swarm: SwarmQuote | null;
  arkiv: {
    /** Where the viewed record ends after the extension (null if its end cannot be worked out). */
    endsAt: Date | null;
    /** True when the chain maximum, not the chosen days, sets the end date. */
    capped: boolean;
    /** True when every record is already at the maximum, so step 2 would send nothing. */
    nothingToAdd: boolean;
  };
};

/** Reads the batch the record names and decides whether it may be topped up (see `classifyBatch`). */
async function readBatchVerdict(gnosis: PublicClient, batchId: Hex): Promise<BatchVerdict> {
  return classifyBatch(await readBatch(gnosis, batchId));
}

/** Reads what a keep-alive of `days` would cost and where it would end. Public reads only: no wallet needed. */
export async function readQuote(cfg: NetConfig, target: KeepAliveTarget, days: number): Promise<Quote> {
  const arkivReads = readArkivExpiry(arkivPublic(cfg), target.entityKeys);
  let swarm: SwarmQuote | null = null;
  if (!isFree(target)) {
    // A Gnosis failure must not take the Arkiv step down with it: it only switches the storage step off.
    try {
      const gnosis = gnosisClient(cfg);
      const verdict = await readBatchVerdict(gnosis, target.batchId!);
      if (verdict.kind !== 'ok') {
        swarm = verdict;
      } else {
        const [cost, ttl, gasPrice] = await Promise.all([
          topUpCost(gnosis, target.batchId!, days),
          batchTtlSeconds(gnosis, target.batchId!),
          gnosis.getGasPrice(),
        ]);
        swarm = {
          kind: 'ok',
          depth: verdict.depth,
          perChunk: cost.perChunk,
          total: cost.total,
          fee: gasPrice * GAS_STEP_1,
          endsAt: ttl === null ? null : secondsFromNow(Number(ttl) + days * 86_400),
          expired: ttl === null,
        };
      }
    } catch {
      swarm = { kind: 'unreadable' };
    }
  }
  const expiries = await arkivReads;
  const plans = expiries.map((e) => planExtension({ ...e, days }));
  const mine = expiries[0]!;
  return {
    swarm,
    arkiv: {
      endsAt: secondsFromNow(Number(plans[0]!.toBlock - mine.currentBlock) * mine.blockSeconds),
      capped: plans.some((p) => p.capped),
      nothingToAdd: plans.every((p) => !p.extends),
    },
  };
}

export type Ends = { swarm: Date | null; arkiv: Date | null };

const endsOf = (e: ArkivExpiry): Date | null => secondsFromNow(Number(e.expiresAtBlock - e.currentBlock) * e.blockSeconds);

/**
 * The live end dates, read from the chains right now. A read that fails gives null for that date
 * (never a guess). For free storage `swarm` is always null.
 */
export async function readEnds(cfg: NetConfig, target: KeepAliveTarget): Promise<Ends> {
  const [swarm, arkiv] = await Promise.all([
    isFree(target)
      ? null
      : batchTtlSeconds(gnosisClient(cfg), target.batchId!).then(
          (ttl) => (ttl === null ? null : secondsFromNow(Number(ttl))),
          () => null,
        ),
    readArkivExpiry(arkivPublic(cfg), target.entityKeys.slice(0, 1)).then(
      (e) => endsOf(e[0]!),
      () => null,
    ),
  ]);
  return { swarm, arkiv };
}

/** The date everything stays available until: the earlier end, once every needed end is known. */
export function keptUntil(ends: Ends, free: boolean): Date | null {
  if (ends.arkiv === null || (!free && ends.swarm === null)) return null;
  return !free && ends.swarm !== null && ends.swarm < ends.arkiv ? ends.swarm : ends.arkiv;
}

export type StepOneResult = { kind: 'done' } | { kind: 'short'; need: bigint } | { kind: 'no-batch'; unsupported: boolean };

/** What step 1 was shown and agreed to: the payment may not exceed it. */
export type TopUpPlan = { batchId: Hex; days: number; depth: number; maxTotal: bigint };

/**
 * Step 1, on Gnosis: connect, switch network, check the batch and the xBZZ balance, then approve
 * (only when the allowance is short) and top the batch up. The payment is tied to the preview
 * (`plan`): `topUp` reads the batch again before the approval and after it, and throws
 * `BatchChangedError` if the batch, its depth or the price is no longer what was shown. `onApproved`
 * and `onSent` report progress (see `topUp`). A wallet rejection or any failure is thrown as it is.
 */
export async function stepTopUp(
  cfg: NetConfig,
  plan: TopUpPlan,
  hooks: { onApproved: () => void; onSent: (hash: Hex) => void },
): Promise<StepOneResult> {
  const { address } = await connectWallet();
  await ensureChain(100);
  const gnosis = gnosisClient(cfg);
  // Read again right before paying: a record's batch id is only a claim.
  const verdict = await readBatchVerdict(gnosis, plan.batchId);
  if (verdict.kind !== 'ok') return { kind: 'no-batch', unsupported: verdict.kind === 'unsupported' };
  const have = await gnosis.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
  if (have < plan.maxTotal) return { kind: 'short', need: plan.maxTotal };
  await topUp(walletFor(address, 100), plan.batchId, plan.days, {
    expectDepth: plan.depth,
    maxTotal: plan.maxTotal,
    onApproved: hooks.onApproved,
    onSent: hooks.onSent,
  });
  return { kind: 'done' };
}

/**
 * Step 2, on Arkiv: connect, switch network, then extend every record by `days` on top of its own
 * expiry, in one transaction. `sent` is false when every record was already at the chain maximum.
 * `onSent` gets the transaction hash as soon as the wallet has sent it, before the receipt is
 * awaited, so a failed wait can be settled by a retry (see `settleExtend`).
 */
export async function stepExtend(
  cfg: NetConfig,
  entityKeys: Hex[],
  days: number,
  hooks: { onSent: (hash: Hex) => void },
): Promise<{ sent: boolean }> {
  const { address } = await connectWallet();
  await ensureChain(arkivChainId(cfg));
  const provider = getProvider();
  if (!provider) throw new WalletError('no-wallet', 'MetaMask not found. Install it, then reload this page.');
  const watched = custom({
    async request(args: { method: string; params?: unknown }) {
      const res = await provider.request(args);
      if (args.method === 'eth_sendTransaction' && typeof res === 'string') hooks.onSent(res as Hex);
      return res;
    },
  });
  const w = arkivWallet(cfg, watched, { address, type: 'json-rpc' } as unknown as Account);
  const { txHash } = await extendEntities(w, arkivPublic(cfg), entityKeys, days);
  return { sent: txHash !== null };
}

// ---- Readings taken before a step, so a retry can tell whether the first try landed -------------

export type SwarmBaseline = { normalisedBalance: bigint; endsAt: Date | null };

/** The batch's balance and end date now, before step 1 is sent. Throws if the batch cannot be read. */
export async function readSwarmBaseline(cfg: NetConfig, batchId: Hex): Promise<SwarmBaseline> {
  const gnosis = gnosisClient(cfg);
  const [batch, ttl] = await Promise.all([readBatch(gnosis, batchId), batchTtlSeconds(gnosis, batchId).catch(() => null)]);
  if (!batch) throw new BatchChangedError(batchId, 'gone', 'no such batch');
  return { normalisedBalance: batch.normalisedBalance, endsAt: ttl === null ? null : secondsFromNow(Number(ttl)) };
}

export type ArkivBaseline = { before: ArkivExpiry[]; endsAt: Date | null };

/** The records' expiry blocks now, before step 2 is sent. Throws if they cannot be read. */
export async function readArkivBaseline(cfg: NetConfig, entityKeys: Hex[]): Promise<ArkivBaseline> {
  const before = await readArkivExpiry(arkivPublic(cfg), entityKeys);
  return { before, endsAt: endsOf(before[0]!) };
}

// ---- Did the first try land? ---------------------------------------------------------------------

type ReceiptReader = {
  getTransactionReceipt(a: { hash: Hex }): Promise<{ status: 'success' | 'reverted' }>;
  waitForTransactionReceipt(a: { hash: Hex; timeout: number }): Promise<{ status: 'success' | 'reverted' }>;
};

const receiptIo = (pub: ReceiptReader) => ({
  receipt: async (hash: Hex) => {
    try {
      return (await pub.getTransactionReceipt({ hash })).status;
    } catch (e) {
      if ((e as { name?: string }).name === 'TransactionReceiptNotFoundError') return 'absent' as const;
      throw e;
    }
  },
  wait: async (hash: Hex, ms: number) => {
    try {
      return (await pub.waitForTransactionReceipt({ hash, timeout: ms })).status;
    } catch (e) {
      if ((e as { name?: string }).name === 'WaitForTransactionReceiptTimeoutError') return 'timeout' as const;
      throw e;
    }
  },
});

/**
 * Whether an earlier step-1 try went through: its receipt on Gnosis if there is a hash, else (or
 * on top of it) whether the batch's balance is above the reading taken before the step. Anyone's
 * top-up raises it, which is harmless: the storage was extended either way.
 */
export function settleTopUp(cfg: NetConfig, batchId: Hex, a: { hash?: Hex; baseNormalised: bigint }): Promise<Settled> {
  const gnosis = gnosisClient(cfg);
  return settle({
    hash: a.hash,
    ...receiptIo(gnosis as unknown as ReceiptReader),
    moved: async () => {
      const batch = await readBatch(gnosis, batchId);
      if (!batch) throw new Error('the batch is gone');
      return batch.normalisedBalance > a.baseNormalised;
    },
  });
}

/** Whether an earlier step-2 try went through: its receipt on Arkiv, or any record's expiry above the reading before the step. */
export function settleExtend(cfg: NetConfig, a: { hash?: Hex; before: ArkivExpiry[] }): Promise<Settled> {
  const pub = arkivPublic(cfg);
  return settle({
    hash: a.hash,
    ...receiptIo(pub as unknown as ReceiptReader),
    moved: async () => {
      const now = await readArkivExpiry(pub, a.before.map((b) => b.entityKey));
      return now.some((n, i) => n.expiresAtBlock > a.before[i]!.expiresAtBlock);
    },
  });
}

export type Problem =
  | { kind: 'no-wallet' }
  | { kind: 'no-batch'; unsupported: boolean }
  | { kind: 'short'; need: bigint }
  /** The batch, its depth or its price is no longer what the preview showed; nothing was sent. */
  | { kind: 'changed'; reason: BatchChange }
  /** An earlier try was sent and the chain could not say whether it landed, so it was not sent again. */
  | { kind: 'unsettled' }
  | { kind: 'cancelled'; approved: boolean }
  /** `sent`: the transaction left the wallet, so it may have gone through despite the error. */
  | { kind: 'failed'; message: string; technical: string; approved: boolean; sent: boolean };

const firstLine = (s: string) => s.split('\n')[0]!.trim();

/**
 * Sorts a thrown error into what the dialog says about it. `approved`: step 1's approval was
 * already mined. `sent`: the paid transaction of the step was sent (so a failure is not proof it
 * did not happen).
 */
export function problemOf(err: unknown, flags: { approved: boolean; sent: boolean }): Problem {
  if (err instanceof WalletError && err.kind === 'no-wallet') return { kind: 'no-wallet' };
  if (err instanceof BatchChangedError) return { kind: 'changed', reason: err.reason };
  if (isUserRejection(err)) return { kind: 'cancelled', approved: flags.approved };
  const e = err as { shortMessage?: string; message?: string };
  const technical = err instanceof Error ? err.message : String(err);
  return {
    kind: 'failed',
    message: firstLine(e.shortMessage ?? e.message ?? 'Something went wrong'),
    technical,
    approved: flags.approved,
    sent: flags.sent,
  };
}
