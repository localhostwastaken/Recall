// Offscreen document: Arkiv and Swarm reads for the service worker (the SDKs live here, not
// in the service worker bundle): the checked history of an address, and the witness URL
// its pinned witness announced.
import type { Address, Hex } from 'viem';
import type { NetConfig } from '@recall/net/config';
import { arkivPublic, latestWitnessUrl, listByUrl } from '@recall/net/arkiv';
import { downloadBytes } from '@recall/net/swarm';
import { latestVerifiedCapture, summarizeHistory, type HistoryDeps } from './history';

/** One evidence download may take this long before the record counts as unavailable. */
export const DOWNLOAD_TIMEOUT_MS = 8_000;

/**
 * Service worker -> offscreen: the history of `urlHash`, checked against `pinned`.
 * - want 'latest': the newest verified capture (for the same-page check).
 * - want 'summary': counts of verified versions and confirmations (for the popup).
 */
export type OffscreenHistory = {
  type: 'recall.offscreen.history';
  net: NetConfig;
  urlHash: Hex;
  pinned: Address[];
  want: 'latest' | 'summary';
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
  incomplete: boolean;
};

/** Service worker -> offscreen: the newest URL announced by `witness` itself, or null. */
export type OffscreenWitnessUrl = {
  type: 'recall.offscreen.witnessUrl';
  net: NetConfig;
  witness: Address;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0];

export async function readHistory(
  req: OffscreenHistory,
): Promise<LatestAnswer | SummaryAnswer | { error: string }> {
  try {
    const { rows, truncated } = await listByUrl(arkivPublic(req.net), req.urlHash);
    const deps: HistoryDeps = {
      urlHash: req.urlHash,
      pinned: req.pinned,
      // Aborted (not just abandoned) when slow, so a stalling gateway costs nothing more.
      download: async (ref) =>
        (await downloadBytes(ref, req.net.swarm.downloadUrls, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }))
          .bytes,
    };
    if (req.want === 'latest') {
      const latest = await latestVerifiedCapture(rows, deps);
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
      incomplete: s.incomplete,
    };
  } catch (err) {
    return { error: message(err) };
  }
}

/** Only profiles OWNED by the witness key count (latestWitnessUrl filters on the owner). */
export async function readWitnessUrl(req: OffscreenWitnessUrl): Promise<{ url: string | null } | { error: string }> {
  try {
    return { url: await latestWitnessUrl(arkivPublic(req.net), req.witness) };
  } catch (err) {
    return { error: message(err) };
  }
}
