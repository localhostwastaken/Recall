// Service worker side of the reads that need Arkiv or Swarm (done by the offscreen
// document, which holds those SDKs): which witness URL to use, the checked history of a
// page, and the approval tab that follows a capture.
import type { Hex } from 'viem';
import { canonicalUrl, urlHash } from '@recall/evidence';
import { ensureOffscreen } from './offscreen';
import { isWitnessUrl, loadSettings, netConfigFor } from './settings';
import { probeWitness, witnessOnline, type WitnessWhy } from './witness';
import { captureTarget, withTimeout } from './captureParts';
import { approveUrl, timelineUrl, type EarlierCaptures } from './captureView';
import { focusOrOpenApproveTab } from './appTabs';
import type {
  LatestAnswer,
  OffscreenHistory,
  OffscreenWitnessUrl,
  SummaryAnswer,
} from './historyRead';

/** The Arkiv read for the witness's announced URL may take this long. */
const ANNOUNCE_TIMEOUT_MS = 5_000;
/** The popup's "Earlier captures" (listing + downloads + checks) may take this long. */
const SUMMARY_TIMEOUT_MS = 30_000;
/** The same-page check may take this long; after that the capture is uploaded (fail-safe). */
const LATEST_TIMEOUT_MS = 30_000;
/** An online witness found by the popup is reused by a capture started this soon after. */
const WITNESS_CACHE_MS = 30_000;

type Ask = OffscreenHistory | OffscreenWitnessUrl;

/** Sends to the offscreen document, retrying briefly while a new document is still loading. */
async function askOffscreen<T>(msg: Ask): Promise<T> {
  await ensureOffscreen();
  for (let attempt = 0; ; attempt++) {
    try {
      const res = (await chrome.runtime.sendMessage(msg)) as T | undefined;
      if (res === undefined) throw new Error('no answer from the offscreen document');
      return res;
    } catch (err) {
      if (attempt >= 20 || !/receiving end does not exist/i.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

/** `why`: for a witness that is not online, the reason the popup words its hint by. */
export type WitnessStatus = { url?: string; online: boolean; why?: WitnessWhy };

/**
 * Whether an announced witness URL may be used: https, or plain http only for this machine
 * (localhost, 127.0.0.1: the devnet and a local witness). A profile on Arkiv is public and
 * signed only by the witness key, but a plain-http URL elsewhere could be read or changed on
 * the way, so it is never followed.
 */
export function announcedUrlAllowed(url: unknown): url is string {
  if (!isWitnessUrl(url)) return false;
  const u = new URL(url);
  return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1';
}

let cached: { key: string; at: number; status: WitnessStatus } | null = null;

/**
 * The witness to use. Candidates, in order: the URL the first pinned witness announced on
 * Arkiv (a `recall.v1.witness` profile CREATED by that key; anyone else's profile is ignored,
 * even one handed to the witness later),
 * then the URL in settings. The first that answers `/info` in time with a pinned signer
 * wins. None online: offline, with the first candidate as the URL to try. An online answer
 * is cached briefly so a capture started from the popup uses the witness the popup showed.
 */
export async function resolveWitness(opts: { fresh?: boolean } = {}): Promise<WitnessStatus> {
  const s = await loadSettings();
  const key = JSON.stringify([s.net, s.witnessUrl, s.pinnedWitnesses]);
  if (!opts.fresh && cached && cached.key === key && Date.now() - cached.at < WITNESS_CACHE_MS) {
    return cached.status;
  }
  const candidates: string[] = [];
  const pinned = s.pinnedWitnesses[0];
  if (pinned) {
    const msg: OffscreenWitnessUrl = {
      type: 'recall.offscreen.witnessUrl',
      net: netConfigFor(s),
      witness: pinned,
    };
    const res = await withTimeout(
      askOffscreen<{ url: string | null } | { error: string }>(msg),
      ANNOUNCE_TIMEOUT_MS,
      'the witness profile read timed out',
    ).catch(() => null);
    if (res && 'url' in res && announcedUrlAllowed(res.url)) candidates.push(res.url);
  }
  if (s.witnessUrl && !candidates.includes(s.witnessUrl)) candidates.push(s.witnessUrl);
  const whys: WitnessWhy[] = [];
  for (const url of candidates) {
    const probe = await probeWitness(url, undefined, s.pinnedWitnesses);
    if (probe.ok) {
      const status = { url, online: true };
      cached = { key, at: Date.now(), status };
      return status;
    }
    whys.push(probe.why);
  }
  cached = null;
  // A wrong signer is a security matter and wins over a timeout, which only hints at the network.
  const why: WitnessWhy = whys.includes('wrong_signer')
    ? 'wrong_signer'
    : whys.includes('timeout')
      ? 'timeout'
      : 'unreachable';
  return { ...(candidates[0] ? { url: candidates[0] } : {}), online: false, why };
}

/**
 * The witness for a new capture: online only after `/info` answered as a pinned witness.
 * If the lookup itself fails, the settings URL is still put through the same signer check
 * (never used blind); anything else is offline.
 */
export async function witnessForCapture(): Promise<WitnessStatus> {
  try {
    return await resolveWitness();
  } catch {
    try {
      const s = await loadSettings();
      const online = await witnessOnline(s.witnessUrl, undefined, s.pinnedWitnesses);
      return { ...(s.witnessUrl ? { url: s.witnessUrl } : {}), online };
    } catch {
      return { online: false };
    }
  }
}

/** The urlHash of a page the extension can capture, or an error in plain words. */
export function pageUrlHash(pageUrl: string): Hex | { error: string } {
  const t = captureTarget(pageUrl);
  if (!(t instanceof URL)) return { error: t.error };
  try {
    return urlHash(canonicalUrl(t.href));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The popup's "Earlier captures": counts of verified versions and confirmations of a page.
 * With no pinned witness nothing can verify, which `trusted: false` says.
 */
export async function earlierCaptures(pageUrl: string): Promise<EarlierCaptures> {
  const h = pageUrlHash(pageUrl);
  if (typeof h !== 'string') return h;
  const s = await loadSettings();
  const where = { urlHash: h, timelineUrl: timelineUrl(s.appUrl, h) };
  if (s.pinnedWitnesses.length === 0) {
    return { ...where, trusted: false, versions: 0, confirmations: 0, records: 0, unavailable: 0, incomplete: false };
  }
  const msg: OffscreenHistory = {
    type: 'recall.offscreen.history',
    net: netConfigFor(s),
    urlHash: h,
    pinned: s.pinnedWitnesses,
    want: 'summary',
  };
  try {
    const res = await withTimeout(
      askOffscreen<SummaryAnswer | { error: string }>(msg),
      SUMMARY_TIMEOUT_MS,
      'checking earlier captures took too long',
    );
    return 'error' in res ? res : { ...res, ...where, trusted: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export type LatestCapture = NonNullable<LatestAnswer['latest']>;

/**
 * The newest verified capture of `h`, or null when there is none, the listing was cut short
 * (spam can hide records: R10), or it could not be read in time. Null means "upload".
 * `before` (the new capture's signed time, Unix seconds) leaves out records claiming that
 * time or later, so they cost no download.
 */
export async function latestVerifiedCapture(h: Hex, before?: bigint): Promise<LatestCapture | null> {
  const s = await loadSettings();
  if (s.pinnedWitnesses.length === 0) return null;
  const msg: OffscreenHistory = {
    type: 'recall.offscreen.history',
    net: netConfigFor(s),
    urlHash: h,
    pinned: s.pinnedWitnesses,
    want: 'latest',
    ...(before !== undefined ? { before: before.toString(10) } : {}),
  };
  try {
    const res = await withTimeout(
      askOffscreen<LatestAnswer | { error: string }>(msg),
      LATEST_TIMEOUT_MS,
      'the same-page check took too long',
    );
    if ('error' in res || res.truncated) return null;
    return res.latest;
  } catch {
    return null;
  }
}

/** Opens the web app's approval tab for a pending capture. Never throws. */
export async function openApproveTab(captureId: string): Promise<void> {
  try {
    const { appUrl } = await loadSettings();
    await focusOrOpenApproveTab(approveUrl(appUrl, captureId, chrome.runtime.id), captureId);
  } catch (err) {
    console.error('[recall] could not open the approval tab', err instanceof Error ? err.message : String(err));
  }
}
