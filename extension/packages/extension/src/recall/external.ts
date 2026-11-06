// The extension's API for the Recall web app (chrome.runtime.onMessageExternal). Only
// origins in the manifest's externally_connectable can call it (a release build: the GitHub
// Pages app; dev builds also localhost and *.bzz.link, gateways that serve anyone's content),
// and any page there may call it, so nothing here trusts the caller (ruling R27):
// - recall.getStampAddress  -> {address, version}        public, read-only (version: the extension's)
// - recall.addBatches       -> {pool} | {error, pool, rejected}  each batch checked on Gnosis
// - recall.getPending       -> PendingRecord | {error}   exact unguessable captureId only
// - recall.markPublished    -> {ok:true} | {error}       only after the Arkiv record matches
// - recall.discardPending   -> {ok:true} | {error}       exact unguessable captureId only
// Every answer is JSON-safe (strings, numbers, booleans; no bytes, no bigint).
import { createPublicClient, http, type Hex } from 'viem';
import { gnosis } from 'viem/chains';
import { loadSettings, netConfigFor } from './settings';
import { stampAddress } from './stamp';
import { addBatches, parseBatchIds } from './pool';
import { discardPending, markPublished, readPending, type EntitySummary } from './pending';
import { ensureOffscreen } from './offscreen';
import { clearDiscardedCapture } from './job';
import type { OffscreenReadEntity } from './arkivRead';

export type ExternalRequest =
  | { type: 'recall.getStampAddress' }
  | { type: 'recall.addBatches'; batchIds: Hex[] }
  | { type: 'recall.getPending'; captureId: string }
  | { type: 'recall.markPublished'; captureId: string; entityKey: Hex }
  | { type: 'recall.discardPending'; captureId: string };

type Answer = Record<string, unknown>;

/** Asks the offscreen document to read an Arkiv record (the SDK lives there, not here). */
async function readEntity(entityKey: Hex): Promise<EntitySummary | { error: string }> {
  const net = netConfigFor(await loadSettings());
  await ensureOffscreen();
  const msg: OffscreenReadEntity = { type: 'recall.offscreen.readEntity', entityKey, net };
  for (let attempt = 0; ; attempt++) {
    try {
      const res = (await chrome.runtime.sendMessage(msg)) as
        | EntitySummary
        | { error: string }
        | undefined;
      return res ?? { error: 'no answer from the reader' };
    } catch (err) {
      if (attempt >= 20 || !/receiving end does not exist/i.test(String(err)))
        return { error: String(err) };
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

export async function handleExternal(raw: unknown): Promise<Answer> {
  const msg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  switch (msg.type) {
    case 'recall.getStampAddress':
      return { address: await stampAddress(), version: chrome.runtime.getManifest().version };

    case 'recall.addBatches': {
      const ids = parseBatchIds(msg.batchIds);
      if ('error' in ids) return { error: ids.error };
      const net = netConfigFor(await loadSettings());
      const pub = createPublicClient({ chain: gnosis, transport: http(net.gnosis.rpcUrl) });
      const { pool, rejected } = await addBatches(ids, {
        pub: pub as unknown as Parameters<typeof addBatches>[1]['pub'],
        stampAddress: await stampAddress(),
      });
      if (rejected.length === 0) return { pool };
      const reasons = rejected.map((r) => `${r.batchId}: ${r.reason}`).join('; ');
      return {
        error: `${rejected.length} of ${ids.length} batches were refused: ${reasons}`,
        pool,
        rejected,
      };
    }

    case 'recall.getPending': {
      const rec = await readPending(msg.captureId);
      return rec ? { ...rec } : { error: 'no pending capture with this id' };
    }

    case 'recall.markPublished':
      return markPublished(msg.captureId, msg.entityKey, readEntity);

    case 'recall.discardPending': {
      const res = await discardPending(msg.captureId);
      // The popup must not keep offering a capture that is gone (best effort).
      if ('ok' in res) await clearDiscardedCapture(msg.captureId as string).catch(() => undefined);
      return res;
    }

    default:
      return { error: 'unknown request' };
  }
}

/** Registers the external API. Other extensions are never answered. */
export function initExternalApi(): void {
  chrome.runtime.onMessageExternal.addListener((raw: unknown, sender, sendResponse) => {
    if (sender.id && sender.id !== chrome.runtime.id) return;
    handleExternal(raw).then(sendResponse, (err) =>
      sendResponse({ error: err instanceof Error ? err.message : String(err) }),
    );
    return true; // async response
  });
}
