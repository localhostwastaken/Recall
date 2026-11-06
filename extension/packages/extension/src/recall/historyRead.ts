// Offscreen document: Arkiv and Swarm reads for the service worker (the SDKs live here, not
// in the service worker bundle): the checked history of an address, and the witness URL
// its pinned witness announced.
import type { Address, Hex } from 'viem';
import type { NetConfig } from '@recall/net/config';
import { arkivPublic, latestWitnessUrl, listByUrl } from '@recall/net/arkiv';
import { isFreeBatch } from '@recall/net/postage';
import { redactKey } from '@recall/net/redact';
import { downloadBytes } from '@recall/net/swarm';
import { latestVerifiedCapture, summarizeHistory, type HistoryDeps } from './history';

/** One evidence download may take this long before the record counts as unavailable. */
export const DOWNLOAD_TIMEOUT_MS = 8_000;

/**
 * Service worker -> offscreen: the history of `urlHash`, checked against `pinned`.
 * - want 'latest': the newest verified capture signed before `before` (for the same-page
 *   check; `before` is the new capture's signed time, a decimal string).
 * - want 'summary': counts of verified versions and confirmations (for the popup).
 */
export type OffscreenHistory = {
  type: 'recall.offscreen.history';
  net: NetConfig;
  urlHash: Hex;
  pinned: Address[];
  want: 'latest' | 'summary';
  before?: string;
};

/** JSON-safe answers (bigints as decimal strings). */
export type LatestAnswer = {
  latest: { entityKey: Hex; bodySha256: Hex; signedAt: string } | null;
  truncated: boolean;
};
export type SummaryAnswer = {
  versions: number;
  confirmations: number;
  latest?: string;
  records: number;
  unavailable: number;
  incomplete: boolean;
};

/** Service worker -> offscreen: the newest URL announced by `witness` itself, or null. */
export type OffscreenWitnessUrl = {
  type: 'recall.offscreen.witnessUrl';
  net: NetConfig;
  witness: Address;
};

/** The first line of an error, with the Arkiv access key removed (it is part of the request URL). */
const message = (e: unknown, key?: string) => redactKey(e instanceof Error ? e.message : String(e), key).split('\n')[0];

export async function readHistory(
  req: OffscreenHistory,
): Promise<LatestAnswer | SummaryAnswer | { error: string }> {
  try {
    const { rows, truncated } = await listByUrl(arkivPublic(req.net), req.urlHash);
    const deps: HistoryDeps = {
      urlHash: req.urlHash,
      pinned: req.pinned,
      // Aborted (not just abandoned) when slow, so a stalling gateway costs nothing more. The
      // Swarm root is checked except for free-mode records (all-zero batch id, as in the web
      // app): a gateway's free-storage reference differs from the local root over 4 KB; those
      // bytes are bound by checks A-C and the R13 facts cross-check in verifiedFacts.
      download: async (ref, batchId) =>
        (
          await downloadBytes(ref, req.net.swarm.downloadUrls, {
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
            verifyRoot: !isFreeBatch(batchId),
          })
        ).bytes,
    };
    if (req.want === 'latest') {
      const before = req.before !== undefined && /^\d+$/.test(req.before) ? BigInt(req.before) : undefined;
      const latest = await latestVerifiedCapture(rows, deps, undefined, before);
      return {
        latest: latest ? { ...latest, signedAt: latest.signedAt.toString(10) } : null,
        truncated,
      };
    }
    const s = await summarizeHistory(rows, truncated, deps);
    return {
      versions: s.versions,
      confirmations: s.confirmations,
      ...(s.latest !== undefined ? { latest: s.latest.toString(10) } : {}),
      records: s.records,
      unavailable: s.unavailable,
      incomplete: s.incomplete,
    };
  } catch (err) {
    return { error: message(err, req.net.arkiv.accessKey) };
  }
}

/** Only profiles CREATED by the witness key count (latestWitnessUrl filters on `$creator`, R41). */
export async function readWitnessUrl(req: OffscreenWitnessUrl): Promise<{ url: string | null } | { error: string }> {
  try {
    return { url: await latestWitnessUrl(arkivPublic(req.net), req.witness) };
  } catch (err) {
    return { error: message(err, req.net.arkiv.accessKey) };
  }
}
