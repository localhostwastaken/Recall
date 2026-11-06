import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import {
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { installMockWallet } from '../fixtures/mockWallet';
import { canonicalUrl, decodeEvidence, runChecks, urlHash, type EvidenceFile } from '../../packages/evidence/src/index';
import {
  arkivPublic,
  batchTtlSeconds,
  buyBatch,
  costFor,
  downloadBytes,
  latestWitnessUrl,
  listByUrl,
  liveConfig,
  normalizeKey,
  readBatch,
  waitBatchUsable,
  XBZZ,
  type Listed,
} from '../../packages/net/src/index';

// P2 live check, on the real networks only: a postage batch bought on Gnosis for the RELEASE
// extension's stamp key; a capture of the Pages notice through the tunnel witness, which the
// extension finds from the witness's Arkiv profile; the evidence stamped client side and pushed
// through the public gateway's /chunks; the record written on Arkiv Rabdi from the approval tab
// with a treasury-backed mock wallet (MetaMask is the only stand-in); the evidence read back from
// two public gateways and verified.
//
// - The Chromium profile is kept between runs (RECALL_P2_PROFILE, default <tmp>/recall-live/
//   p2-profile), so the stamp key and the batch pool survive: a batch is bought only when the pool
//   has no unused one (each run's capture uses one, D11). Spend caps are enforced before buying,
//   across runs (<profile>-batches.json); when the cap leaves no room, the run reuses the batch it
//   bought (marked unused again, stamper state kept).
// - Captures go through the tunnel first. If MPC setup times out twice (a slow link: the ~77 MB
//   of setup traffic leaves this machine and comes back through Cloudflare), the run captures with
//   the same live witness on 127.0.0.1:7048 and says so in its summary. RECALL_P2_TUNNEL_ONLY=1
//   turns that fallback off.
// - Each run captures notice/?run=<random> (GitHub Pages ignores the query; the canonical URL keeps
//   it), so no earlier record turns the capture into a same-page confirmation.
// - The approval tab opens at the release build's app URL, https://localhostwastaken.github.io/
//   Recall/app/. Requests there are answered from this checkout's live build (apps/web/dist,
//   `VITE_RECALL_NET=live pnpm --filter web build`) so the run tests this code at the real origin
//   (the extension's externally_connectable allows it). A tab the extension itself opens escapes
//   the routes on its first load, so the approval tab is reloaded (with the wallet) before use.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RELEASE_BUILD_DIR = join(ROOT, 'extension/packages/extension/build-release');
const APP_DIST = join(ROOT, 'apps/web/dist');
const PROFILE_DIR = process.env.RECALL_P2_PROFILE || join(tmpdir(), 'recall-live', 'p2-profile');
/** Batches this check bought (ids, owners, tx hashes, xBZZ spent): never a secret. */
const LEDGER_FILE = `${PROFILE_DIR}-batches.json`;

const APP_URL = 'https://localhostwastaken.github.io/Recall/app/';
const NOTICE_URL = 'https://localhostwastaken.github.io/Recall/notice/';
const NOTICE_HOST = 'localhostwastaken.github.io';
const RUN = Math.random().toString(36).slice(2, 10);
const PAGE = `${NOTICE_URL}?run=${RUN}`;

const LIVE_WITNESS: Address = '0xC9319e18e86cd7EB653c0Ed0693c0cf5B63db37D';
const GNOSIS_RPC = 'https://rpc.gnosischain.com';
/** The public Rabdi endpoint (no access key in any URL this test could print). */
const RABDI_RPC = 'https://rpc.rabdi.db-chain.testnet.arkiv.network';
const RABDI_ID = 7794095;
const UPLOAD_URL = 'https://api.gateway.ethswarm.org';
const DOWNLOAD_GATEWAYS = ['https://download.gateway.ethswarm.org', 'https://bzz.link'];

/** One batch: depth 17, 3 days (the extension refuses batches with under 2 days left). */
const DEPTH = 17;
const DAYS = 3;
/** Spend caps for the whole check (ruling R37). */
const CAP_XBZZ = parseUnits('0.2', 16);
const CAP_XDAI = parseUnits('0.002', 18);
const CAP_TGLM = parseUnits('1', 18);

/** Capture attempts through the tunnel, then (see the capture step) on this machine. */
const TUNNEL_ATTEMPTS = 2;
const LOCAL_ATTEMPTS = 2;
/** The live witness container on this machine (scripts/tunnel.sh: 127.0.0.1:7048). */
const LOCAL_WITNESS_URL = 'http://127.0.0.1:7048';
/** A pinned address with no Arkiv profile (nobody holds its key); used only by the local fallback. */
const NO_PROFILE_WITNESS: Address = '0x000000000000000000000000000000000000dEaD';

type PoolEntry = { batchId: Hex; used: boolean; usable?: boolean; dead?: string; startBlock?: string };
type Upload =
  | { status: 'pending'; captureId: string }
  | { status: string; captureId?: string; error?: string; reason?: string };
type CaptureState = {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  error?: string;
  evidence?: EvidenceFile;
  checks?: Record<'A' | 'B' | 'C', { status: string; detail: string }>;
  upload?: Upload;
};

let context: BrowserContext;
let extensionId: string;
let app: Page;

const gnosisPub = createPublicClient({ chain: gnosis, transport: http(GNOSIS_RPC, { retryCount: 3 }) }) as PublicClient;
const rabdiCfg = { ...liveConfig({}), arkiv: { chain: 'rabdi' as const, rpcUrl: RABDI_RPC } };
const rabdiPub = arkivPublic(rabdiCfg);

function treasuryKey(): Hex {
  const k = process.env.TREASURY_PRIVATE_KEY;
  if (!k) throw new Error('TREASURY_PRIVATE_KEY is not set (.env.local)');
  return normalizeKey(k);
}

/** The extension's live service worker (Chrome may replace the first one right after launch). */
function sw(): Worker {
  const live = context.serviceWorkers().filter((w) => w.url().includes(extensionId));
  if (!live.length) throw new Error('the extension service worker is gone');
  return live[live.length - 1];
}

async function settleServiceWorker(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const w = sw();
    let closed = false;
    w.once('close', () => (closed = true));
    await new Promise((r) => setTimeout(r, 1_500));
    if (!closed && sw() === w) return;
  }
  throw new Error('the extension service worker keeps restarting');
}

async function storage(area: 'local' | 'session', key: string, value?: unknown): Promise<unknown> {
  return sw().evaluate(
    async ([a, k, v, write]) => {
      type Area = { get(k: string): Promise<Record<string, unknown>>; set(i: object): Promise<void> };
      const s = (globalThis as unknown as { chrome: { storage: Record<string, Area> } }).chrome.storage[a];
      if (write) await s.set({ [k]: v });
      return (await s.get(k))[k];
    },
    [area, key, value, value !== undefined] as const,
  );
}

/** One message from the app page to the extension (externally_connectable). */
async function api<T = Record<string, unknown>>(msg: object): Promise<T> {
  return app.evaluate(
    ([id, m]) =>
      new Promise<unknown>((done) => {
        const rt = (window as unknown as { chrome?: { runtime?: { sendMessage?: Function; lastError?: { message?: string } } } })
          .chrome?.runtime;
        if (!rt?.sendMessage) return done({ lastError: 'chrome.runtime is not exposed to this page' });
        rt.sendMessage(id, m, (res: unknown) => done(res ?? { lastError: rt.lastError?.message ?? 'no answer' }));
      }),
    [extensionId, msg] as const,
  ) as Promise<T>;
}

/** Serves this checkout's live web build at the release extension's app URL. */
async function serveApp(ctx: BrowserContext): Promise<void> {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json',
  };
  await ctx.route(/^https:\/\/localhostwastaken\.github\.io\/Recall\/app\//, async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/Recall\/app\/?/, ''));
    const file = resolve(APP_DIST, path || 'index.html');
    if (!file.startsWith(APP_DIST + sep) || !existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    await route.fulfill({ status: 200, contentType: types[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
}

/** Waits for a capture other than `previousId` to end, and returns its final state. */
async function finished(previousId?: string): Promise<CaptureState> {
  let last: CaptureState | undefined;
  await expect
    .poll(
      async () => {
        last = (await storage('session', 'recall.capture')) as CaptureState | undefined;
        return last && last.id !== previousId ? last.status : undefined;
      },
      { timeout: 420_000, intervals: [1_000] },
    )
    .toMatch(/^(done|error|cancelled)$/);
  return last!;
}

/** Native and token balances of the treasury (spend accounting). */
async function balances(treasury: Address) {
  const [xdai, xbzz, tglm] = await Promise.all([
    gnosisPub.getBalance({ address: treasury }),
    gnosisPub.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'balanceOf', args: [treasury] }),
    rabdiPub.getBalance({ address: treasury }),
  ]);
  return { xdai, xbzz, tglm };
}

/** Transactions sent by `from` in Rabdi blocks [fromBlock, toBlock]. */
async function rabdiTxsFrom(from: Address, fromBlock: bigint, toBlock: bigint): Promise<Hex[]> {
  const out: Hex[] = [];
  for (let b = fromBlock; b <= toBlock; b++) {
    const block = await rabdiPub.getBlock({ blockNumber: b, includeTransactions: true });
    for (const tx of block.transactions) if (tx.from.toLowerCase() === from.toLowerCase()) out.push(tx.hash);
  }
  return out;
}

/** The bzz.link subdomain form of a reference: CIDv1, swarm-manifest codec, keccak-256, base32. */
function swarmManifestCid(ref: Hex): string {
  const bytes = [0x01, 0xfa, 0x01, 0x1b, 0x20, ...Buffer.from(ref.slice(2), 'hex')];
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = 'b';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + alphabet[(value << (5 - bits)) & 31] : out;
}

test.describe('@live p2', () => {
  test.beforeAll(async () => {
    for (const [what, path, fix] of [
      ['release build', join(RELEASE_BUILD_DIR, 'manifest.json'), 'pnpm extension:release'],
      ['live web build', join(APP_DIST, 'index.html'), 'VITE_RECALL_NET=live pnpm --filter web build'],
    ] as const) {
      if (!existsSync(path)) throw new Error(`No ${what} at ${path}. Run: ${fix}`);
    }
    mkdirSync(PROFILE_DIR, { recursive: true });
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chromium',
      headless: !process.env.HEADED,
      // --disable-quic: on this network UDP to Cloudflare is throttled (the reason scripts/tunnel.sh
      // runs cloudflared over http2); Chromium's QUIC attempts made the tunnel's /info take 6 s+.
      args: [`--disable-extensions-except=${RELEASE_BUILD_DIR}`, `--load-extension=${RELEASE_BUILD_DIR}`, '--disable-quic'],
    });
    await serveApp(context);
    const first = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'))
      ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
    extensionId = new URL(first.url()).host;
    await settleServiceWorker();
    app = await context.newPage();
    await app.goto(APP_URL);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('p2 real batch, stamped gateway upload, Rabdi record, two-gateway download', async () => {
    test.setTimeout(1_200_000);
    const t0 = Date.now();
    const timings: Record<string, number> = {};
    const mark = (name: string, since: number) => (timings[name] = Math.round((Date.now() - since) / 100) / 10);
    const treasury = privateKeyToAccount(treasuryKey());
    const before = await balances(treasury.address);

    // 0. The release build, the tunnel witness and its announced profile.
    const build = await sw().evaluate(() => {
      const g = globalThis as unknown as { chrome: { runtime: { getManifest(): { name: string } } }; recall?: unknown };
      return { name: g.chrome.runtime.getManifest().name, hook: typeof g.recall };
    });
    expect(build).toEqual({ name: 'Recall', hook: 'undefined' });
    const witnessUrl = (process.env.WITNESS_PUBLIC_URL ?? '').replace(/\/$/, '');
    expect(witnessUrl, 'WITNESS_PUBLIC_URL (.env.local) must be the tunnel URL').toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
    const info = (await (await fetch(`${witnessUrl}/info`, { signal: AbortSignal.timeout(15_000) })).json()) as { signer?: string };
    expect(info.signer).toBe(LIVE_WITNESS);
    expect(await latestWitnessUrl(rabdiPub, LIVE_WITNESS), 'run pnpm witness:announce --net live').toBe(witnessUrl);
    // Discovery, not settings: the extension must find the witness from its Arkiv profile.
    const settings = ((await storage('local', 'recall.settings')) ?? {}) as Record<string, unknown>;
    const { witnessUrl: _drop, ...rest } = settings;
    await storage('local', 'recall.settings', { ...rest, pinnedWitnesses: [LIVE_WITNESS] });

    // 1. Storage: the stamp address, the Storage page (read-only), one batch in the pool.
    const stamp = (await api<{ address?: Address }>({ type: 'recall.getStampAddress' })).address;
    expect(stamp, 'getStampAddress').toMatch(/^0x[0-9a-fA-F]{40}$/);
    await app.evaluate((id) => localStorage.setItem('recall.web.settings.v1', JSON.stringify({ extensionId: id })), extensionId);
    await app.goto(`${APP_URL}#/storage`);
    await app.reload();
    await expect(app.locator('.owner-row .mono-value')).toHaveAttribute('title', stamp!, { timeout: 15_000 });
    await expect(app.locator('.price')).toContainText('xBZZ =', { timeout: 30_000 });

    // Batches bought by earlier runs are noted next to the profile, so a run that failed between
    // the purchase and the hand-off never buys again, and the caps hold across runs.
    type Ledger = { spentXbzz: string; batches: { batchId: Hex; owner: Address; approve?: Hex; createBatch?: Hex; at: string }[] };
    const readLedger = (): Ledger => {
      try {
        return JSON.parse(readFileSync(LEDGER_FILE, 'utf8')) as Ledger;
      } catch {
        return { spentXbzz: '0', batches: [] };
      }
    };
    const ledger = readLedger();
    const readPool = async () => ((await storage('local', 'recall.pool')) as PoolEntry[] | undefined) ?? [];
    const addToPool = async (ids: Hex[]) => {
      const added = await api<{ pool?: unknown; error?: string }>({ type: 'recall.addBatches', batchIds: ids });
      expect(added.error, JSON.stringify(added)).toBeUndefined();
    };
    let pool = await readPool();
    const known = new Set(pool.map((b) => b.batchId.toLowerCase()));
    const orphans = ledger.batches.filter((b) => getAddress(b.owner) === getAddress(stamp!) && !known.has(b.batchId.toLowerCase()));
    if (orphans.length) {
      await addToPool(orphans.map((b) => b.batchId));
      pool = await readPool();
    }
    let batch = pool.find((b) => !b.used && !b.dead);
    let batchTx: { approve?: Hex; createBatch?: Hex } = {};
    let bought = false;
    let reusedUsedBatch = false;
    if (!batch && BigInt(ledger.spentXbzz) + (await costFor(gnosisPub, DEPTH, DAYS)) > CAP_XBZZ) {
      // The spend cap allows one batch for this check. A rerun after a capture already used it
      // marks that batch unused again (test-only; its stamper state is kept, so no stamp slot is
      // ever reused: the new evidence takes a fresh slot in the same real batch).
      const raw = ((await storage('local', 'recall.pool')) as Record<string, unknown>[] | undefined) ?? [];
      const ours = new Set(ledger.batches.map((b) => b.batchId.toLowerCase()));
      const i = raw.findIndex((b) => typeof b.batchId === 'string' && ours.has(b.batchId.toLowerCase()) && !b.dead);
      if (i >= 0 && Number(await batchTtlSeconds(gnosisPub, raw[i].batchId as Hex)) >= 2 * 86_400) {
        raw[i] = { ...raw[i], used: false };
        await storage('local', 'recall.pool', raw);
        reusedUsedBatch = true;
        pool = await readPool();
        batch = pool.find((b) => !b.used && !b.dead);
        console.log('P2 LIVE reusing the bought batch under the spend cap', JSON.stringify({ batchId: batch?.batchId }));
      }
    }
    if (batch) {
      const mine = ledger.batches.find((b) => b.batchId.toLowerCase() === batch!.batchId.toLowerCase());
      batchTx = { approve: mine?.approve, createBatch: mine?.createBatch };
      test.info().annotations.push({ type: 'reused batch', description: batch.batchId });
    } else {
      const cost = await costFor(gnosisPub, DEPTH, DAYS);
      const already = BigInt(ledger.spentXbzz);
      expect(already + cost, `a ${DAYS}-day depth-${DEPTH} batch costs ${formatUnits(cost, 16)} xBZZ; ${formatUnits(already, 16)} already spent`).toBeLessThanOrEqual(CAP_XBZZ);
      expect(before.xbzz, 'treasury xBZZ').toBeGreaterThanOrEqual(cost);
      expect(before.xdai, 'treasury xDAI for fees').toBeGreaterThan(parseUnits('0.0005', 18));
      const sent: Hex[] = [];
      const inner = http(GNOSIS_RPC, { retryCount: 3 })({ chain: gnosis });
      const wallet = createWalletClient({
        account: treasury,
        chain: gnosis,
        transport: custom({
          async request(args: { method: string; params?: unknown }) {
            const res = await inner.request(args as never);
            if (args.method === 'eth_sendRawTransaction') sent.push(res as Hex);
            return res;
          },
        }),
      });
      const tb = Date.now();
      const { batchId, txHash } = await buyBatch(wallet, { owner: stamp!, depth: DEPTH, days: DAYS });
      mark('buyBatchS', tb);
      batchTx = { approve: sent.find((h) => h !== txHash), createBatch: txHash };
      bought = true;
      ledger.spentXbzz = String(already + cost);
      ledger.batches.push({ batchId, owner: stamp!, ...batchTx, at: new Date().toISOString() });
      writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2));
      console.log('P2 LIVE batch bought', JSON.stringify({ batchId, owner: stamp, ...batchTx, xbzz: formatUnits(cost, 16) }));
      const ta = Date.now();
      await addToPool([batchId]);
      mark('addBatchesS', ta);
      pool = await readPool();
      batch = pool.find((b) => b.batchId.toLowerCase() === batchId.toLowerCase());
    }
    expect(batch, 'an unused batch in the extension pool').toBeTruthy();
    const batchId = batch!.batchId;
    const onChain = await readBatch(gnosisPub, batchId);
    expect(onChain && getAddress(onChain.owner)).toBe(getAddress(stamp!));
    expect(onChain?.depth).toBe(DEPTH);
    const ttl = await batchTtlSeconds(gnosisPub, batchId);
    expect(Number(ttl), 'the batch must have at least 2 days left').toBeGreaterThanOrEqual(2 * 86_400);

    // Usable: the gateway has no /chainstate, so the chain decides (12 blocks after the batch's
    // block), the rule waitBatchUsable and the extension share. Whether the gateway's /batches
    // lists the batch is only recorded (it did not, minutes after the purchase).
    const tu = Date.now();
    await waitBatchUsable(UPLOAD_URL, batchId, 300_000, { chain: gnosisPub, pollMs: 5_000 });
    mark('usableByChainS', tu);
    const tg = Date.now();
    let gatewayLists = false;
    while (!gatewayLists && Date.now() - tg < 60_000) {
      const list = (await fetch(`${UPLOAD_URL}/batches`, { signal: AbortSignal.timeout(30_000) })
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])) as { batchID?: string }[] | { batches?: { batchID?: string }[] };
      const rows = Array.isArray(list) ? list : (list.batches ?? []);
      gatewayLists = rows.some((b) => b.batchID?.replace(/^0x/, '').toLowerCase() === batchId.slice(2).toLowerCase());
      if (!gatewayLists) await new Promise((r) => setTimeout(r, 10_000));
    }
    mark('gatewayListsS', tg);
    test.info().annotations.push({ type: 'gateway /batches lists the batch', description: String(gatewayLists) });

    // 2. Capture through the popup; the witness comes from the Arkiv profile.
    const tab = await context.newPage();
    await tab.goto(PAGE);
    const tabId = await sw().evaluate(async (u) => {
      const tabs = (globalThis as unknown as { chrome: { tabs: { query(q: object): Promise<{ id?: number; url?: string }[]> } } })
        .chrome.tabs;
      return (await tabs.query({})).find((t) => t.url === u)?.id ?? null;
    }, PAGE);
    expect(tabId, `a tab showing ${PAGE}`).not.toBeNull();
    let popup = await context.newPage();
    const openPopup = async () => {
      for (let i = 0; ; i++) {
        await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
        try {
          await expect(popup.getByText('Witness online')).toBeVisible({ timeout: 25_000 });
          return;
        } catch (err) {
          const t = Date.now();
          const status = await popup
            .evaluate(() => (globalThis as unknown as { chrome: { runtime: { sendMessage(m: object): Promise<unknown> } } }).chrome.runtime.sendMessage({ type: 'recall.witnessStatus' }))
            .catch((e: Error) => e.message);
          const shown = (await popup.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
          console.log('P2 LIVE popup not online', JSON.stringify({ attempt: i + 1, shown, statusNow: status, statusMs: Date.now() - t }));
          if (i === 2) throw err;
        }
      }
    };
    await openPopup();
    const tw = Date.now();
    let attempts = 0;
    let state: CaptureState | undefined;
    const errors: string[] = [];
    let transport: 'tunnel' | 'local' = 'tunnel';
    let tries = 0;
    for (;;) {
      attempts++;
      tries++;
      const button =
        attempts === 1 ? popup.getByRole('button', { name: 'Capture this page' }) : popup.getByRole('button', { name: 'Try again' });
      await expect(button).toBeEnabled({ timeout: 30_000 });
      await button.click();
      state = await finished(state?.id);
      if (state.status !== 'error') break;
      // A failed capture ends before any upload (no batch is used), so it is retried.
      errors.push(`${transport}: ${state.error ?? ''}`);
      test.info().annotations.push({ type: `retried capture (${transport})`, description: state.error ?? '' });
      const setupTimedOut = /setupProver timed out|did not connect in time/i.test(state.error ?? '');
      if (transport === 'tunnel' && tries >= TUNNEL_ATTEMPTS && setupTimedOut && !process.env.RECALL_P2_TUNNEL_ONLY) {
        // MPC setup moves ~77 MB from the browser to the witness. Through the quick tunnel that
        // traffic leaves this machine and comes back (browser -> Cloudflare -> cloudflared), so a
        // slow venue uplink cannot finish it within the extension's 90 s setup limit. Fall back
        // to the same live witness on this machine: a pinned witness without a profile comes
        // first, so the announced (tunnel) URL is not tried and the settings URL is used; check C
        // still requires the live signer. Everything else stays on the live networks.
        transport = 'local';
        tries = 0;
        console.log('P2 LIVE witness transport: local fallback', JSON.stringify({ errors }));
        await storage('local', 'recall.settings', {
          ...rest,
          witnessUrl: LOCAL_WITNESS_URL,
          pinnedWitnesses: [NO_PROFILE_WITNESS, LIVE_WITNESS],
        });
      } else if (tries >= (transport === 'tunnel' ? TUNNEL_ATTEMPTS : LOCAL_ATTEMPTS)) {
        break;
      }
      if (popup.isClosed()) popup = await context.newPage();
      await openPopup();
    }
    mark('captureS', tw);
    expect(state.status, state.error).toBe('done');
    const own = state.checks!;
    expect([own.A.status, own.B.status, own.C.status], JSON.stringify(own)).toEqual(['pass', 'pass', 'pass']);

    // 3. Capture first (R44): kept in the extension, nothing uploaded yet; the popup sends the
    // person to the Recall tab.
    expect(state.upload?.status, JSON.stringify(state.upload)).toBe('pending');
    const up = state.upload as Extract<Upload, { status: 'pending' }>;
    pool = ((await storage('local', 'recall.pool')) as PoolEntry[]) ?? [];
    expect(pool.find((b) => b.batchId.toLowerCase() === batchId.toLowerCase())?.used).toBe(false);
    await expect(popup.getByRole('heading', { name: 'Continue in the Recall tab' })).toBeVisible({ timeout: 15_000 });

    // 4. The publish tab (opened by the extension): Upload and publish. The extension stamps with
    // the pool batch and uploads through the public gateway, then the treasury wallet publishes on
    // Rabdi.
    let approve: Page | undefined;
    await expect
      .poll(() => (approve = context.pages().find((p) => p.url().includes(`#/approve/${up.captureId}`))), {
        timeout: 30_000,
        message: 'the extension opens the publish tab',
      })
      .toBeTruthy();
    expect(approve!.url()).toBe(`${APP_URL}#/approve/${up.captureId}?ext=${extensionId}`);
    await installMockWallet(approve!, {
      privateKey: treasuryKey(),
      rpcByChainId: { 100: GNOSIS_RPC, [RABDI_ID]: RABDI_RPC },
      chainId: 100,
    });
    // A tab the extension creates loads before Playwright's routes apply to it (its first load is
    // the deployed Pages app); this reload, needed anyway for the wallet, comes from apps/web/dist.
    await approve!.reload();
    const ourBundle = /src="\.\/(assets\/index-[^"]+\.js)"/.exec(readFileSync(join(APP_DIST, 'index.html'), 'utf8'))![1];
    expect(await approve!.evaluate(() => [...document.scripts].map((x) => x.src))).toContain(`${APP_URL}${ourBundle}`);
    await expect(approve!.getByRole('heading', { level: 1 })).toHaveText('Save this capture', { timeout: 60_000 });
    for (const k of ['A', 'B', 'C']) {
      await expect(approve!.locator(`.approve-check-list [data-check="${k}"] .badge`)).toHaveAttribute('data-status', 'pass');
    }
    const tp = Date.now();
    const fromBlock = await rabdiPub.getBlockNumber();
    await approve!.getByRole('button', { name: 'Upload and publish' }).click();
    // A passing upload failure (network, 5xx, timeout) keeps the capture and the batch: try again.
    const published = approve!.getByRole('heading', { name: 'Published', exact: true });
    const failedUpload = approve!.getByRole('heading', { name: 'Upload failed' });
    for (let retry = 0; ; retry++) {
      await expect(published.or(failedUpload)).toBeVisible({ timeout: 420_000 });
      if (await published.isVisible()) break;
      const why = (await approve!.locator('.notice').filter({ has: failedUpload }).textContent()) ?? '';
      errors.push(`upload: ${why}`);
      test.info().annotations.push({ type: 'retried upload', description: why });
      expect(retry, why).toBeLessThan(2);
      await approve!.getByRole('button', { name: 'Try upload again' }).click();
    }
    mark('uploadAndPublishS', tp);
    await expect(approve!.getByText(/Record on Arkiv until /)).toBeVisible({ timeout: 30_000 });
    const entityKey = (await approve!.locator('.approve-record .mono-value').first().getAttribute('title')) as Hex;
    expect(entityKey).toMatch(/^0x[0-9a-f]{64}$/i);
    const toBlock = await rabdiPub.getBlockNumber();
    const arkivTxs = await rabdiTxsFrom(treasury.address, fromBlock, toBlock).catch(() => [] as Hex[]);

    // The record on Rabdi, built from the verified facts.
    const hash = urlHash(canonicalUrl(PAGE));
    let row: Extract<Listed, { kind: 'capture' }> | undefined;
    await expect
      .poll(
        async () => {
          const r = await listByUrl(rabdiPub, hash);
          row = r.rows.find((x) => x.entityKey.toLowerCase() === entityKey.toLowerCase()) as typeof row;
          return row?.kind;
        },
        { timeout: 60_000, intervals: [2_000] },
      )
      .toBe('capture');
    expect(getAddress(row!.owner)).toBe(treasury.address);
    expect(row!.evidenceRef).toMatch(/^0x[0-9a-f]{64}$/);
    const evidenceRef = row!.evidenceRef;
    expect(row!.batchId.toLowerCase()).toBe(batchId.toLowerCase());
    pool = ((await storage('local', 'recall.pool')) as PoolEntry[]) ?? [];
    expect(pool.find((b) => b.batchId.toLowerCase() === batchId.toLowerCase())?.used).toBe(true);
    expect(row!.canonicalUrl).toBe(canonicalUrl(PAGE));
    expect(row!.serverName).toBe(NOTICE_HOST);
    expect(row!.httpStatus).toBe(200);
    expect(getAddress(row!.witness)).toBe(LIVE_WITNESS);
    // The extension was told: its hand-over copy is gone.
    expect(await api({ type: 'recall.getPending', captureId: up.captureId })).toHaveProperty('error');

    // 5. Download from each public gateway on its own; root-checked, then checks A-C and R13.
    const downloads: Record<string, { ms: number; bytes: number }> = {};
    let firstBytes: Uint8Array | undefined;
    for (const gw of DOWNLOAD_GATEWAYS) {
      const td = Date.now();
      let got: Awaited<ReturnType<typeof downloadBytes>> | undefined;
      await expect
        .poll(
          async () => {
            got = await downloadBytes(evidenceRef, [gw], { signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
            return got?.rootVerified;
          },
          { timeout: 180_000, intervals: [5_000], message: `download ${evidenceRef} from ${gw}` },
        )
        .toBe(true);
      downloads[gw] = { ms: Date.now() - td, bytes: got!.bytes.length };
      if (firstBytes) expect(Buffer.from(got!.bytes).equals(Buffer.from(firstBytes))).toBe(true);
      firstBytes ??= got!.bytes;
      const report = await runChecks(decodeEvidence(got!.bytes), { pinnedWitnesses: [LIVE_WITNESS] });
      const detail = (['A', 'B', 'C'] as const).map((k) => `${k} ${report[k].status}: ${report[k].detail}`).join('; ');
      expect([report.A.status, report.B.status, report.C.status], `${gw}: ${detail}`).toEqual(['pass', 'pass', 'pass']);
      const f = report.facts!;
      expect(f.urlHash).toBe(row!.urlHash);
      expect(f.bodySha256).toBe(row!.bodySha256);
      expect(getAddress(f.witness)).toBe(getAddress(row!.witness));
      expect(f.signedAt).toBe(row!.signedAt);
      expect(f.canonicalUrl).toBe(canonicalUrl(PAGE));
      expect(new TextDecoder().decode(f.body)).toContain('15 December');
    }
    // bzz.link's CID subdomain form serves manifests (/bzz), not raw /bytes: recorded, not required.
    const cidUrl = `https://${swarmManifestCid(evidenceRef)}.bzz.link/`;
    const cidStatus = await fetch(cidUrl, { signal: AbortSignal.timeout(30_000) }).then((r) => r.status, () => 0);

    const after = await balances(treasury.address);
    const spent = { xbzz: before.xbzz - after.xbzz, xdai: before.xdai - after.xdai, tglm: before.tglm - after.tglm };
    expect(spent.xbzz).toBeLessThanOrEqual(CAP_XBZZ);
    expect(spent.xdai).toBeLessThanOrEqual(CAP_XDAI);
    expect(spent.tglm).toBeLessThanOrEqual(CAP_TGLM);
    mark('totalS', t0);

    const summary = {
      at: new Date().toISOString(),
      page: PAGE,
      witness: {
        announcedUrl: witnessUrl,
        signer: LIVE_WITNESS,
        // The popup showed "Witness online" with no witness URL in settings: found from Arkiv.
        popupFoundAnnouncedWitness: true,
        captureTransport: transport === 'tunnel' ? 'tunnel (announced URL)' : `local ${LOCAL_WITNESS_URL} (tunnel setup timed out)`,
      },
      stampAddress: stamp,
      batch: { batchId, owner: onChain!.owner, depth: onChain!.depth, ttlSeconds: String(ttl), bought, reusedUsedBatch, ...batchTx },
      gatewayListedBatch: gatewayLists,
      captureAttempts: attempts,
      retriedErrors: errors,
      captureJobMs: state.finishedAt! - state.startedAt,
      evidenceRef: evidenceRef,
      evidenceBytes: firstBytes!.length,
      uploadUrl: UPLOAD_URL,
      arkiv: { entityKey, txHashes: arkivTxs, owner: treasury.address, chainId: RABDI_ID },
      record: { urlHash: row!.urlHash, bodySha256: row!.bodySha256, signedAt: String(row!.signedAt) },
      downloads,
      bzzLinkBytesUrl: `https://bzz.link/bytes/${evidenceRef.slice(2)}`,
      bzzLinkCid: { url: cidUrl, status: cidStatus },
      spent: { xbzz: formatUnits(spent.xbzz, 16), xdai: formatEther(spent.xdai), tglm: formatEther(spent.tglm) },
      timings,
    };
    console.log('P2 LIVE', JSON.stringify(summary));
    writeFileSync(test.info().outputPath('p2-live-summary.json'), JSON.stringify(summary, null, 2));
    test.info().annotations.push({ type: 'p2 live', description: JSON.stringify(summary) });
    await storage('local', 'recall.settings', { ...rest, pinnedWitnesses: [LIVE_WITNESS] });
    await popup.close();
    await tab.close();
  });
});
