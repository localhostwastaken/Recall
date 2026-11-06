import {
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
  type NetConfig,
} from '@recall/net';
import { createPublicClient, custom, erc20Abi, http, type Account, type Hex, type PublicClient } from 'viem';
import { classifyBatch, type BatchVerdict } from './batch';
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
      /** xBZZ (16 decimals) the top-up costs, rounded up by the caller for display. */
      total: bigint;
      /** The Gnosis fee for step 1, in xDAI wei. */
      fee: bigint;
      /** Where the batch ends after the top-up; null when it has already run out (it cannot be topped up). */
      endsAt: Date | null;
      expired: boolean;
    }
  /** The record's batch id names no batch on Gnosis, or one of a size Recall never creates: step 1 is off. */
  | { kind: 'missing' }
  | { kind: 'unsupported'; depth: number };

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
        total: cost.total,
        fee: gasPrice * GAS_STEP_1,
        endsAt: ttl === null ? null : secondsFromNow(Number(ttl) + days * 86_400),
        expired: ttl === null,
      };
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

/**
 * Step 1, on Gnosis: connect, switch network, check the xBZZ balance, then approve (only when the
 * allowance is short) and top the batch up. `onApproved` tells the caller the approval is mined,
 * so a later rejection can say so. Throws a wallet rejection or any failure as it is.
 */
export async function stepTopUp(
  cfg: NetConfig,
  batchId: Hex,
  days: number,
  onApproved: () => void,
): Promise<StepOneResult> {
  const { address } = await connectWallet();
  await ensureChain(100);
  const gnosis = gnosisClient(cfg);
  // Read again right before paying: a record's batch id is only a claim.
  const verdict = await readBatchVerdict(gnosis, batchId);
  if (verdict.kind !== 'ok') return { kind: 'no-batch', unsupported: verdict.kind === 'unsupported' };
  const { total } = await topUpCost(gnosis, batchId, days);
  const have = await gnosis.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
  if (have < total) return { kind: 'short', need: total };
  await topUp(walletFor(address, 100), batchId, days, { onApproved: onApproved });
  return { kind: 'done' };
}

/**
 * Step 2, on Arkiv: connect, switch network, then extend every record by `days` on top of its own
 * expiry, in one transaction. `sent` is false when every record was already at the chain maximum.
 */
export async function stepExtend(cfg: NetConfig, entityKeys: Hex[], days: number): Promise<{ sent: boolean }> {
  const { address } = await connectWallet();
  await ensureChain(arkivChainId(cfg));
  const provider = getProvider();
  if (!provider) throw new WalletError('no-wallet', 'MetaMask not found. Install it, then reload this page.');
  const w = arkivWallet(cfg, custom(provider), { address, type: 'json-rpc' } as unknown as Account);
  const { txHash } = await extendEntities(w, arkivPublic(cfg), entityKeys, days);
  return { sent: txHash !== null };
}

export type Problem =
  | { kind: 'no-wallet' }
  | { kind: 'no-batch'; unsupported: boolean }
  | { kind: 'short'; need: bigint }
  | { kind: 'cancelled'; approved: boolean }
  | { kind: 'failed'; message: string; technical: string; approved: boolean };

const firstLine = (s: string) => s.split('\n')[0]!.trim();

/** Sorts a thrown error into what the dialog says about it. `approved`: step 1's approval was already mined. */
export function problemOf(err: unknown, approved: boolean): Problem {
  if (err instanceof WalletError && err.kind === 'no-wallet') return { kind: 'no-wallet' };
  if (isUserRejection(err)) return { kind: 'cancelled', approved };
  const e = err as { shortMessage?: string; message?: string };
  const technical = err instanceof Error ? err.message : String(err);
  return { kind: 'failed', message: firstLine(e.shortMessage ?? e.message ?? 'Something went wrong'), technical, approved };
}
