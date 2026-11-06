// Records the submission video: the real release extension and the live app, driven by Playwright
// at a slow, readable pace, with captions, a pointer and title cards drawn over the pages, then cut
// and encoded with ffmpeg (post.ts). Run it with:
//
//   pnpm demo:record            the live take: capture a GitHub repository, buy storage, publish,
//                               verify, tamper, open the app on Swarm (spends real xBZZ/xDAI/tGLM)
//   pnpm demo:record --dry      the same story without the paid capture and publish (spends nothing):
//                               it shows the P2 live capture's record page instead
//   pnpm demo:record --rehearse the live take up to the storage price (a real capture, nothing is
//                               paid), then the P2 record page: checks the live path before the take
//
// Flags: --local-app (serve apps/web/dist at the Pages origin, for when Pages is not redeployed
// yet), --repo <github url> (default bitchat), --out <file.mp4>, --headed, --keep-frames,
// --drop-frames, --budget <seconds> (default 178), --profile <dir>, --no-edit.
//
// - MetaMask is the only stand-in: the treasury-backed mock wallet (e2e/fixtures/mockWallet.ts)
//   signs in the publish tab. TREASURY_PRIVATE_KEY comes from .env.local and is never printed.
// - Spend caps: 0.8 xBZZ, 0.002 xDAI, 0.5 tGLM. The storage price is printed and checked against
//   the cap before Buy is pressed, and the wallet itself refuses any xBZZ approval or batch above
//   the cap (it answers as if the user rejected it).
// - The timeline (frames, shots, beats) is written to JSON next to the frames, so the edit can be
//   redone with post.ts without recording again.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Locator, type Page, type Worker } from '@playwright/test';
import {
  createPublicClient,
  decodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { installMockWallet, type MockWallet } from '../fixtures/mockWallet';
import { canonicalUrl, decodeEvidence, encodeEvidence, urlHash } from '../../packages/evidence/src/index';
import { POSTAGE_STAMP, XBZZ, arkivPublic, costFor, listByUrl, liveConfig, normalizeKey } from '../../packages/net/src/index';
import { CARD_ORIGIN, CARD_PAGE, FONT_FILES, OVERLAY_SCRIPT, type CardSpec } from './overlay';
import { assemble } from './post';
import { Stage, sleep } from './stage';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RELEASE_BUILD_DIR = join(ROOT, 'extension/packages/extension/build-release');
const APP_DIST = join(ROOT, 'apps/web/dist');
const FONTS_DIR = join(ROOT, 'apps/web/src/ui/fonts');
/** Videos go next to the repo, never inside it. */
const OUT_DIR = resolve(ROOT, '..');

const EXT_ID = 'mgpclfpdgpinofgpgfeodcbmlfaglmnp';
const APP_URL = 'https://localhostwastaken.github.io/Recall/app/';
const SWARM_APP_URL = 'https://recallapp.bzz.link/';
const REPO_URL = 'https://github.com/permissionlesstech/bitchat';
const CODE_URL = 'https://github.com/localhostwastaken/Recall';
const RELEASE_URL = 'https://github.com/localhostwastaken/Recall/releases';
/** The P2 live capture (docs/evidence-log.md): the dry run's record page. */
const P2_ENTITY: Hex = '0xc50021a907dbd1d511d2e4a1482614647cbbb4a0dd2d4bf26ad70065b3611244';

const GNOSIS_RPC = 'https://rpc.gnosischain.com';
const RABDI_RPC = 'https://rpc.rabdi.db-chain.testnet.arkiv.network';
const RABDI_ID = 7794095;
const BUY_DAYS = 7;
const CAPS = { xbzz: parseUnits('0.8', 16), xdai: parseUnits('0.002', 18), tglm: parseUnits('0.5', 18) };

const VIEWPORT = { width: 1280, height: 720 };
const SCALE = 1.5; // frames are 1920x1080
const CHECK = '\u2713';

type Opts = {
  dry: boolean;
  /** The live take up to the storage price, then the P2 record (nothing is paid). */
  rehearse: boolean;
  localApp: boolean;
  headed: boolean;
  repo: string;
  out: string;
  profile: string;
  keepFrames: boolean;
  budget: number;
  edit: boolean;
};

function parseArgs(argv: string[]): Opts {
  const has = (f: string) => argv.includes(f);
  const val = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const known = ['--dry', '--rehearse', '--local-app', '--headed', '--repo', '--out', '--profile', '--keep-frames', '--drop-frames', '--budget', '--no-edit'];
  for (const a of argv) if (a.startsWith('--') && !known.includes(a)) throw new Error(`unknown flag ${a} (known: ${known.join(' ')})`);
  const dry = has('--dry');
  const rehearse = !dry && has('--rehearse');
  const kind = dry ? 'dry' : rehearse ? 'rehearse' : 'live';
  return {
    dry,
    rehearse,
    localApp: has('--local-app'),
    headed: has('--headed') || !!process.env.HEADED,
    repo: (val('--repo') ?? REPO_URL).replace(/\/$/, ''),
    out: resolve(val('--out') ?? join(OUT_DIR, kind === 'live' ? 'recall-demo.mp4' : `recall-demo-${kind === 'dry' ? 'dry' : 'rehearsal'}.mp4`)),
    profile: resolve(val('--profile') ?? join(tmpdir(), 'recall-demo', `profile-${kind}`)),
    keepFrames: has('--keep-frames') || (kind === 'live' && !has('--drop-frames')),
    budget: Number(val('--budget') ?? 178),
    edit: !has('--no-edit'),
  };
}

/** The repo-root .env.local (gitignored), as the live Playwright project reads it. */
function loadEnvLocal(): void {
  try {
    const text = readFileSync(join(ROOT, '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    /* no .env.local: the live take fails loudly on the missing key */
  }
}

function treasuryKey(): Hex {
  const k = process.env.TREASURY_PRIVATE_KEY;
  if (!k) throw new Error('TREASURY_PRIVATE_KEY is not set (.env.local)');
  return normalizeKey(k);
}

/** Anything printed from a page goes through here (the app's Rabdi URL may carry an access key). */
function redact(text: string, max = 600): string {
  const key = (process.env.ARKIV_ACCESS_KEY ?? '').trim();
  let out = text;
  if (key) out = out.split(key).join('<access key>').split(encodeURIComponent(key)).join('<access key>');
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

const gnosisPub = createPublicClient({ chain: gnosis, transport: http(GNOSIS_RPC, { retryCount: 3 }) }) as PublicClient;
const rabdiPub = arkivPublic({ ...liveConfig({}), arkiv: { chain: 'rabdi', rpcUrl: RABDI_RPC } });

async function balances(who: Address) {
  const [xdai, xbzz, tglm] = await Promise.all([
    gnosisPub.getBalance({ address: who }),
    gnosisPub.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
    rabdiPub.getBalance({ address: who }),
  ]);
  return { xdai, xbzz, tglm };
}

/** owner/repo[/tree/branch] of a GitHub repository URL, with the branch resolved. */
async function repoTarget(url: string): Promise<{ owner: string; repo: string; branch: string; api: string }> {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/tree\/(.+))?$/.exec(url);
  if (!m) throw new Error(`not a GitHub repository URL: ${url}`);
  const [, owner, repo] = m as unknown as [string, string, string];
  let branch = m[3];
  if (!branch) {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { signal: AbortSignal.timeout(15_000) });
    branch = ((await r.json()) as { default_branch?: string }).default_branch ?? 'main';
  }
  return { owner, repo, branch, api: `https://api.github.com/repos/${owner}/${repo}/branches/${branch}` };
}

/** Serves this checkout's web build at the Pages origin (as the live specs do). */
async function serveApp(ctx: BrowserContext): Promise<void> {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
  };
  await ctx.route(/^https:\/\/localhostwastaken\.github\.io\/Recall\/app\//, async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/Recall\/app\/?/, ''));
    const file = resolve(APP_DIST, path || 'index.html');
    if (!file.startsWith(APP_DIST + sep) || !existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    await route.fulfill({ status: 200, contentType: types[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
}

/**
 * The Pages app's HTML is always fetched fresh. Pages lets browsers cache it for 10 minutes, and
 * tonight's deploys replace the hashed bundles, so a cached page can point at a bundle that is
 * gone (a blank page: seen in a rehearsal). The bundles themselves are immutable and may be cached.
 */
async function freshAppHtml(ctx: BrowserContext): Promise<void> {
  await ctx.route(/^https:\/\/localhostwastaken\.github\.io\/Recall\/app\/(index\.html)?(\?[^#]*)?$/, async (route) => {
    try {
      const res = await route.fetch({ headers: { ...route.request().headers(), 'cache-control': 'no-cache', pragma: 'no-cache' } });
      await route.fulfill({ response: res, headers: { ...res.headers(), 'cache-control': 'no-store' } });
    } catch {
      await route.continue();
    }
  });
}

/** Waits until the app has rendered on `page`; reloads it (up to twice) if it stays blank. */
async function appRendered(stage: Stage, page: Page, timeoutMs = 45_000): Promise<void> {
  for (let i = 0; ; i++) {
    const ok = await page
      .locator('#root h1')
      .first()
      .waitFor({ timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
    if (i >= 2) throw new Error(`the app did not render at ${redact(page.url()).slice(0, 100)}`);
    stage.log('the app stayed blank; loading it again');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 }).catch(() => undefined);
  }
}

/** The JS of the app at `appUrl` (deployed) contains `needle`. */
async function deployedAppHas(appUrl: string, needle: string): Promise<boolean> {
  const html = await (await fetch(appUrl, { signal: AbortSignal.timeout(20_000) })).text();
  const src = /src="\.?\/?(assets\/index-[^"]+\.js)"/.exec(html)?.[1];
  if (!src) return false;
  const js = await (await fetch(new URL(src, appUrl), { signal: AbortSignal.timeout(30_000) })).text();
  return js.includes(needle);
}

/** The extension's service worker once its chrome APIs answer (Chrome may replace the first one). */
async function extensionWorker(context: BrowserContext): Promise<Worker> {
  const deadline = Date.now() + 20_000;
  if (!context.serviceWorkers().some((w) => w.url().startsWith('chrome-extension://'))) {
    await context.waitForEvent('serviceworker', { timeout: 20_000 }).catch(() => undefined);
  }
  while (Date.now() < deadline) {
    const w = context.serviceWorkers().filter((x) => x.url().startsWith('chrome-extension://')).at(-1);
    if (w) {
      const ok = await w
        .evaluate(() => typeof (globalThis as unknown as { chrome?: { tabs?: { query?: unknown } } }).chrome?.tabs?.query === 'function')
        .catch(() => false);
      if (ok) return w;
    }
    await sleep(200);
  }
  throw new Error('the extension service worker never became ready (is build-release a valid extension?)');
}

async function tabIdOf(context: BrowserContext, prefix: string): Promise<number> {
  const w = await extensionWorker(context);
  const id = await w.evaluate(async (u) => {
    const tabs = (globalThis as unknown as { chrome: { tabs: { query(q: object): Promise<{ id?: number; url?: string }[]> } } }).chrome.tabs;
    return (await tabs.query({})).find((t) => t.url?.startsWith(u))?.id ?? null;
  }, prefix);
  if (id === null) throw new Error(`no tab shows ${prefix}`);
  return id;
}

/** Waits (up to 5 s) until the overlay's fonts are loaded on `page`. */
async function fontsReady(page: Page): Promise<void> {
  await page.evaluate(OVERLAY_SCRIPT).catch(() => undefined);
  await page
    .evaluate(() =>
      Promise.race([
        Promise.all([
          document.fonts.load("600 28px 'Recall Demo Sans'"),
          document.fonts.load("800 62px 'Recall Demo Display'"),
        ]).then(() => true),
        new Promise((r) => setTimeout(() => r(false), 5000)),
      ]),
    )
    .catch(() => undefined);
}

async function until<T>(what: string, fn: () => Promise<T | false | null | undefined>, timeoutMs: number, pollMs = 400): Promise<T> {
  const end = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(pollMs);
  }
  throw new Error(`timed out (${Math.round(timeoutMs / 1000)} s) waiting for ${what}${lastErr ? `: ${String(lastErr)}` : ''}`);
}

const visible = (l: Locator) => l.first().isVisible().catch(() => false);

/**
 * Runs a part of the story that must not end the take once money is spent: a failure is logged,
 * noted in the timeline, and the recording goes on (the edit shows what was recorded).
 */
async function soft(stage: Stage, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const why = redact(e instanceof Error ? e.message : String(e));
    stage.log(`WARNING: ${name} did not complete: ${why}`);
    ((stage.notes.warnings ??= []) as string[]).push(`${name}: ${why}`);
    await stage.cut();
  }
}

type Phase = { caption: string; when?: () => Promise<boolean> };

/**
 * Captions a long wait. Each caption plays at normal speed for at least `minMs`, then the rest
 * of its stretch is marked fast. A later caption starts when its `when` turns true; `done`
 * ends the wait with a value. Captions never reached are shown, in order, at the end.
 */
async function narrate<T>(
  stage: Stage,
  phases: Phase[],
  done: () => Promise<T | false>,
  { minMs = 4200, timeoutMs = 300_000, pollMs = 350 } = {},
): Promise<T> {
  let i = 0;
  await stage.roll();
  await stage.say(phases[0]!.caption);
  let shownAt = Date.now();
  const end = Date.now() + timeoutMs;
  const holdRest = async () => {
    const left = minMs - (Date.now() - shownAt);
    if (stage.speed === 'normal' && left > 0) await sleep(left);
  };
  for (;;) {
    const r = await done().catch(() => false as const);
    if (r !== false) {
      await holdRest();
      await stage.roll();
      for (const p of phases.slice(i + 1)) await stage.say(p.caption, minMs);
      return r;
    }
    const next = phases[i + 1];
    if (next?.when && (await next.when().catch(() => false))) {
      await holdRest();
      await stage.roll();
      i++;
      await stage.say(next.caption);
      shownAt = Date.now();
      continue;
    }
    if (Date.now() - shownAt >= minMs) await stage.fast();
    if (Date.now() > end) throw new Error(`timed out during "${phases[i]!.caption}"`);
    await sleep(pollMs);
  }
}

/** A copy of an evidence file with exactly one byte of the server's response changed. */
function tamper(bytes: Uint8Array): Uint8Array {
  const e = decodeEvidence(bytes);
  const recv = Buffer.from(e.transcript.recv, 'base64');
  const at = Math.floor(recv.length / 2);
  const b = recv[at]!;
  recv[at] = b >= 0x30 && b <= 0x38 ? b + 1 : b === 0x39 ? 0x30 : b ^ 0x01;
  return encodeEvidence({ ...e, transcript: { ...e.transcript, recv: recv.toString('base64') } });
}

/** Drags a file chip onto the page's first drop zone and drops `bytes` there. */
async function dropFile(stage: Stage, page: Page, name: string, bytes: Uint8Array): Promise<void> {
  const zone = page.locator('.dropzone').first();
  await stage.point(zone, 500);
  const box = await zone.boundingBox();
  if (!box) throw new Error('the drop zone is not on screen');
  await page.evaluate(
    ([n, from, to]) => (window as unknown as { __chip(n: string, f: unknown, t: unknown): Promise<void> }).__chip(n, from, to),
    [name, { x: VIEWPORT.width - 470, y: 70 }, { x: box.x + box.width / 2 - 170, y: box.y + box.height / 2 - 22 }] as const,
  );
  await page.evaluate(
    async ([b64, n]) => {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([u8], n, { type: 'application/json' }));
      const el = document.querySelector('.dropzone');
      if (!el) return;
      for (const type of ['dragenter', 'dragover']) {
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
      await new Promise((r) => setTimeout(r, 900));
      (window as unknown as { __chipOff(): void }).__chipOff();
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    [Buffer.from(bytes).toString('base64'), name] as const,
  );
  await sleep(1500);
  if (!/#\/file/.test(page.url())) {
    stage.log('the synthetic drop did not open the file page; using the file input');
    await page.getByLabel('Evidence file', { exact: true }).setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(bytes) });
  }
}

/** The popup, drawn as it looks in Chrome: at the top right, over the page it was opened on. */
async function stagePopup(popup: Page, backdrop: Buffer | null): Promise<void> {
  await popup.evaluate((b64) => {
    const html = document.documentElement;
    const body = document.body;
    const dim = 'linear-gradient(rgba(22, 39, 67, 0.32), rgba(22, 39, 67, 0.32))';
    html.style.setProperty('min-height', '100vh');
    html.style.setProperty(
      'background',
      b64 ? `${dim}, url(data:image/jpeg;base64,${b64}) top left / 100% auto no-repeat, #e9efff` : '#e9efff',
    );
    body.style.setProperty('margin', '10px 26px 0 auto');
    body.style.setProperty('border-radius', '10px');
    body.style.setProperty('box-shadow', '0 22px 60px rgba(22, 39, 67, 0.45), 0 0 0 1px rgba(22, 39, 67, 0.18)');
    // The guide is position: fixed; this keeps it inside the popup, as in Chrome.
    body.style.setProperty('transform', 'translateZ(0)');
    body.style.setProperty('background', 'var(--bg, #fffdf5)');
  }, backdrop ? backdrop.toString('base64') : null);
}

/** The wallet (MetaMask's stand-in) for every page, refusing anything above the spend caps. */
async function installGuardedWallet(context: BrowserContext, stage: Stage) {
  const postageAbi = parseAbi([
    'function createBatch(address _owner, uint256 _initialBalancePerChunk, uint8 _depth, uint8 _bucketDepth, bytes32 _nonce, bool _immutable)',
    'function topUp(bytes32 _batchId, uint256 _topupAmountPerChunk)',
  ]);
  let wallet: MockWallet | undefined;
  let committed = 0n;
  const sent: { chainId: number; hash: Hex; to?: Address }[] = [];
  const refused: string[] = [];
  const veto = (tx: { to?: Address; data?: Hex; value?: Hex }): string | null => {
    if (tx.value && BigInt(tx.value) > 0n) return 'the transaction sends native value';
    if (wallet?.chainId() !== 100) return null; // Arkiv: gas only (checked after the run)
    const to = tx.to ? getAddress(tx.to) : undefined;
    if (to === getAddress(XBZZ)) {
      const c = decodeFunctionData({ abi: erc20Abi, data: tx.data ?? '0x' });
      if (c.functionName !== 'approve') return `an xBZZ ${c.functionName}`;
      const amount = c.args[1] as bigint;
      if (committed + amount > CAPS.xbzz) return `an xBZZ approval of ${formatUnits(amount, 16)} is above the ${formatUnits(CAPS.xbzz, 16)} cap`;
      return null;
    }
    if (to === getAddress(POSTAGE_STAMP)) {
      const c = decodeFunctionData({ abi: postageAbi, data: tx.data ?? '0x' });
      if (c.functionName !== 'createBatch') return `a postage ${c.functionName}`;
      const [, perChunk, depth] = c.args as unknown as [Address, bigint, number];
      const cost = perChunk * 2n ** BigInt(depth);
      if (committed + cost > CAPS.xbzz) return `a batch for ${formatUnits(cost, 16)} xBZZ is above the ${formatUnits(CAPS.xbzz, 16)} cap`;
      committed += cost;
      stage.log(`wallet: createBatch depth ${depth} for ${formatUnits(cost, 16)} xBZZ (cap ${formatUnits(CAPS.xbzz, 16)})`);
      return null;
    }
    return `a call to an unexpected Gnosis contract ${to}`;
  };
  const shim = {
    exposeFunction: (name: string, fn: (method: string, params: unknown[]) => Promise<unknown>) =>
      context.exposeFunction(name, async (method: string, params: unknown[]) => {
        if (method === 'eth_sendTransaction') {
          let why: string | null;
          try {
            why = veto(((params ?? [])[0] ?? {}) as { to?: Address; data?: Hex; value?: Hex });
          } catch (e) {
            why = `an undecodable transaction (${(e as Error).message.split('\n')[0]})`;
          }
          if (why) {
            refused.push(why);
            stage.log(`WALLET REFUSED: ${why}`);
            return { error: { code: 4001, message: `Refused by the demo spend cap: ${why}` } };
          }
        }
        return fn(method, params);
      }),
    addInitScript: (s: { content: string }) => context.addInitScript(s),
  };
  wallet = await installMockWallet(shim as unknown as Page, {
    privateKey: treasuryKey(),
    rpcByChainId: { 100: GNOSIS_RPC, [RABDI_ID]: RABDI_RPC },
    chainId: 100,
    onSent: (chainId, hash, to) => {
      sent.push({ chainId, hash, ...(to ? { to } : {}) });
      stage.log('wallet sent', { chainId, hash, to });
    },
  });
  return { wallet, sent, refused };
}

const INTRO: CardSpec = {
  kicker: 'Recall',
  title: 'Prove what a website or a GitHub repo said at a moment in time.',
  sub: 'A witness signs what the site answered. The evidence goes to Swarm, an index record to Arkiv, and anyone can verify it in a browser.',
  foot: 'ETHGlobal Mumbai 2026',
};
const sectionCard = (step: string, title: string, sub: string): CardSpec => ({ step, title, sub });
const END: CardSpec = {
  kicker: 'Recall',
  title: 'Proof that outlives the page.',
  rows: [
    ['App', 'localhostwastaken.github.io/Recall/app'],
    ['App on Swarm', 'recallapp.bzz.link'],
    ['Code', 'github.com/localhostwastaken/Recall'],
    ['Extension', 'github.com/localhostwastaken/Recall/releases'],
  ],
  foot: 'Built at ETHGlobal Mumbai 2026',
};

async function run(context: BrowserContext, stage: Stage, o: Opts): Promise<void> {
  const notes = stage.notes;
  const w = await extensionWorker(context);
  const extId = new URL(w.url()).host;
  notes.extensionId = extId;
  if (extId !== EXT_ID) stage.log(`warning: the extension ID is ${extId}, not the release ID ${EXT_ID}`);

  await context.route(`${CARD_ORIGIN}**`, (r) => {
    const font = /\/fonts\/([a-z-]+\.woff2)$/.exec(new URL(r.request().url()).pathname)?.[1];
    if (font && FONT_FILES.includes(font)) {
      return r.fulfill({
        status: 200,
        contentType: 'font/woff2',
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'max-age=3600' },
        body: readFileSync(join(FONTS_DIR, font)),
      });
    }
    return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: CARD_PAGE });
  });
  if (o.localApp) await serveApp(context);
  else await freshAppHtml(context);
  await context.addInitScript({ content: OVERLAY_SCRIPT });
  const money = o.dry ? null : await installGuardedWallet(context, stage);
  const treasury = o.dry ? null : privateKeyToAccount(treasuryKey()).address;
  const before = treasury ? await balances(treasury) : null;
  if (before) {
    stage.log('treasury before', { xbzz: formatUnits(before.xbzz, 16), xdai: formatEther(before.xdai), tglm: formatEther(before.tglm) });
  }

  const main = await context.newPage();
  for (const p of context.pages()) if (p !== main) await p.close().catch(() => undefined);

  // a. Title card.
  await main.goto(CARD_ORIGIN, { waitUntil: 'domcontentloaded' });
  await fontsReady(main);
  await stage.show(main, 'main');
  await stage.where(null);
  await stage.card(INTRO, 700);
  stage.beat('title');
  await stage.roll('title card');
  await sleep(5500);
  await stage.cut();

  // b. The repository on GitHub.
  // Slow venue links: the load is cut from the video, so it may take its time.
  for (let i = 0; ; i++) {
    try {
      await main.goto(o.repo, { waitUntil: 'domcontentloaded', timeout: 150_000 });
      break;
    } catch (e) {
      if (i >= 1) throw e;
      stage.log('GitHub is slow to answer; loading the repository again');
    }
  }
  await main.waitForLoadState('load', { timeout: 60_000 }).catch(() => undefined);
  await sleep(1200);
  await stage.overlay();
  await stage.where(undefined);
  await stage.say('');
  stage.beat('github');
  await stage.roll('github');
  await sleep(1500);
  await stage.say('Code and pages change or vanish. Can you prove what this repo contained today?');
  await sleep(1800);
  await stage.scrollTo(330, 1600);
  await sleep(900);
  await stage.scrollTo(0, 1200);
  await stage.cut();
  // The popup is drawn over this page, as in Chrome.
  await stage.say('');
  await sleep(500);
  const backdrop = await main.screenshot({ type: 'jpeg', quality: 72 }).catch(() => null);
  await stage.roll('section capture');
  await stage.card(sectionCard('1', 'Capture', "A witness records GitHub's answer for the branch; the extension checks the code against it."), 2600);
  await stage.cut();
  await stage.card(null);

  // c. The popup (opened as a tab, drawn at the top right over the repository).
  const tabId = await tabIdOf(context, o.repo);
  const popup = await context.newPage();
  const openPopup = async () => {
    await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
    await stagePopup(popup, backdrop);
  };
  await openPopup();
  try {
    await popup.getByText('Witness online').first().waitFor({ timeout: 45_000 });
  } catch {
    stage.log('the popup did not show "Witness online" yet; opening it again');
    await openPopup();
    await popup.getByText('Witness online').first().waitFor({ timeout: 45_000 });
  }
  const captureBtn = popup.getByRole('button', { name: /^Capture this (repository|page)$/ });
  await captureBtn.waitFor({ timeout: 30_000 });
  await stage.show(popup, 'popup');
  await stage.where('Recall extension');
  stage.beat('popup');
  await stage.roll('popup');
  await stage.say('The Recall extension, opened on this repository', 3200);
  const help = popup.getByRole('button', { name: 'How Recall works' });
  if (await visible(help)) {
    await stage.say('A three-step guide on first use');
    await stage.press(help, 700);
    const next = popup.locator('.ob-next');
    for (let i = 0; i < 3; i++) {
      await sleep(1500);
      if (!(await visible(next))) break;
      await stage.press(next, 600);
    }
  } else {
    stage.log('this build has no first-run guide; skipping it');
  }
  const btnLabel = ((await captureBtn.textContent()) ?? '').trim();
  notes.captureButton = btnLabel;

  let entity: Hex = P2_ENTITY;
  let record: Page = main;
  if (o.dry) {
    await stage.say('[dry run] The paid capture and publish are skipped');
    await stage.point(captureBtn, 3200);
    await stage.cut();
  } else {
    if (btnLabel !== 'Capture this repository') throw new Error(`the popup offers "${btnLabel}", not "Capture this repository"`);
    // d. Capture.
    stage.beat('capture');
    let attempts = 0;
    let outcome: 'done' | 'error' | 'confirmation';
    for (;;) {
      attempts++;
      await stage.press(attempts === 1 ? captureBtn : popup.getByRole('button', { name: 'Try again' }), 800);
      outcome = await narrate(
        stage,
        [
          { caption: "TLSNotary: GitHub's answer is recorded through an independent witness, without trusting us" },
          {
            caption: 'Checking the downloaded code against the commit GitHub reported',
            when: async () =>
              /Downloading the code|Checking the code/.test((await popup.locator('[aria-current="step"]').first().textContent({ timeout: 300 }).catch(() => '')) ?? ''),
          },
        ],
        async () => {
          const body = (await popup.locator('body').innerText().catch(() => '')) ?? '';
          if (/Continue in the Recall tab/.test(body)) return /Unchanged since/.test(body) ? ('confirmation' as const) : ('done' as const);
          if (await visible(popup.getByRole('button', { name: 'Try again' }))) return 'error' as const;
          return false;
        },
        { timeoutMs: 360_000 },
      );
      if (outcome !== 'error' || attempts >= 2) break;
      stage.log('capture failed; trying once more', { shown: redact(await popup.locator('body').innerText()) });
      await stage.say('A capture can fail on a slow link; trying again');
    }
    // The extension opens the Recall tab now; the popup stays in front for its last caption.
    await stage.front();
    if (outcome === 'error') throw new Error(`the capture failed twice: ${redact(await popup.locator('body').innerText())}`);
    if (outcome === 'confirmation') {
      throw new Error(
        "GitHub's answer for this branch is unchanged since an earlier capture, so Recall offers a confirmation (no code upload). " +
          'Nothing was paid. Record a branch with no earlier capture: --repo https://github.com/<owner>/<repo>/tree/<branch>',
      );
    }
    await stage.roll();
    await stage.point(popup.getByText('Continue in the Recall tab').first(), 400);
    await stage.say('Captured and checked. Nothing is uploaded until you choose to save it.', 3300);
    await stage.cut();

    // e. The publish page (the extension opens it).
    let approve = context.pages().find((p) => p.url().includes('#/approve/'));
    if (!approve) {
      await stage.roll();
      await stage.press(popup.getByRole('button', { name: 'Open Recall tab' }));
      await stage.cut();
    }
    approve = await until('the publish tab', async () => context.pages().find((p) => p.url().includes('#/approve/')), 30_000);
    record = approve;
    await approve.waitForLoadState('domcontentloaded');
    // A tab the extension opens can load before the wallet's init script (and the routes) apply.
    const hasWallet = await approve.evaluate(() => !!(window as unknown as { ethereum?: { isMockWallet?: boolean } }).ethereum?.isMockWallet).catch(() => false);
    let ours = true;
    if (o.localApp) {
      const bundle = /src="\.\/(assets\/index-[^"]+\.js)"/.exec(readFileSync(join(APP_DIST, 'index.html'), 'utf8'))?.[1];
      ours = !!bundle && (await approve.evaluate(() => [...document.scripts].map((x) => x.src)).catch(() => [] as string[])).includes(`${APP_URL}${bundle}`);
    }
    if (!hasWallet || !ours) {
      stage.log('reloading the publish tab so the wallet (and the local app) apply');
      await approve.reload({ waitUntil: 'domcontentloaded' });
    }
    await appRendered(stage, approve, 20_000);
    const primary = approve.getByRole('button', { name: /^(Buy storage and publish|Upload and publish|Confirm it's still the same|Publish record)$/ });
    await primary.first().waitFor({ timeout: 120_000 });
    await stage.show(approve, 'approve');
    await stage.where(undefined);
    stage.beat('publish page');
    await stage.roll('section publish');
    await stage.card(sectionCard('2', 'Publish', 'Storage on Swarm, paid by the user; an index record on Arkiv.'), 2600);
    await stage.card(null, 500);
    await stage.roll('publish page');
    await stage.say('The Recall tab checks the capture again before anything is saved', 3300);
    const repoSection = approve.locator('section:has(#repo-title)');
    if (await visible(repoSection)) {
      await stage.say('Repository snapshot: the code matches the commit GitHub reported');
      await stage.point(repoSection, 3000);
    }
    const label = ((await primary.first().textContent()) ?? '').trim();
    notes.publishButton = label;
    if (label === "Confirm it's still the same" || label === 'Publish record') {
      throw new Error(`the publish tab offers "${label}" (no storage purchase or code upload); nothing was paid`);
    }
    if (label === 'Buy storage and publish') {
      // The price, read from the page and from Gnosis, against the cap, before anything is pressed.
      const helperText = await until(
        'the storage price',
        async () => {
          const t = (await approve!.locator('body').innerText()) ?? '';
          return /about [\d.]+ xBZZ/.test(t) && (await primary.first().isEnabled()) ? t : false;
        },
        60_000,
      );
      const shown = /about ([\d.]+) xBZZ/.exec(helperText)![1]!;
      const depth = Number(/depth (\d+)/.exec(helperText)?.[1] ?? 18);
      const quote = await costFor(gnosisPub, depth, BUY_DAYS);
      const price = { page: `${shown} xBZZ`, gnosis: `${formatUnits(quote, 16)} xBZZ`, depth, days: BUY_DAYS, cap: `${formatUnits(CAPS.xbzz, 16)} xBZZ` };
      notes.price = price;
      console.log(`\nSTORAGE PRICE: the page asks about ${shown} xBZZ; Gnosis quotes ${price.gnosis} (depth ${depth}, ${BUY_DAYS} days). Cap: ${price.cap}.\n`);
      if (parseUnits(shown, 16) > CAPS.xbzz || quote > CAPS.xbzz) throw new Error(`the storage price is above the cap (${JSON.stringify(price)}); nothing was paid`);
      if (before && before.xbzz < quote) throw new Error('the treasury has too little xBZZ for this batch; nothing was paid');
      await stage.say('Storage is paid by the user on Swarm (Gnosis)');
      await stage.point(approve.getByText(/about [\d.]+ xBZZ/).first(), 3600);
    } else {
      await stage.say('Storage for this capture is already bought', 3200);
    }
  }
  if (!o.dry && o.rehearse) {
    stage.log('rehearsal: stopping before the purchase; nothing is paid. The rest runs on the P2 record.');
    stage.notes.rehearsal = 'stopped before Buy';
    await stage.say('[rehearsal] Buying and publishing are skipped');
    await sleep(2500);
    await stage.cut();
    record = context.pages().find((p) => p.url().includes('#/approve/')) ?? main;
  } else if (!o.dry) {
    const approve = record;
    const primary = approve.getByRole('button', { name: /^(Buy storage and publish|Upload and publish)$/ });

    // f. Buy, upload, publish.
    stage.beat('publish');
    await stage.press(primary.first(), 900);
    const activeStep = async () => (await approve!.locator('[aria-current="step"]').first().textContent({ timeout: 300 }).catch(() => '')) ?? '';
    const bodyText = async () => (await approve!.locator('body').innerText().catch(() => '')) ?? '';
    let retries = 0;
    await narrate(
      stage,
      [
        { caption: 'A test wallet signs here (MetaMask in real use)' },
        {
          caption: 'Evidence + code uploaded to Swarm',
          when: async () => /^Upload/.test(await activeStep()) || /Uploading the evidence|Checking the upload/.test(await bodyText()),
        },
        {
          caption: 'Index record written to Arkiv',
          when: async () => /^(Connect MetaMask|Switch to|Publish the)/.test(await activeStep()) || /Publishing|Checking Arkiv/.test(await bodyText()),
        },
      ],
      async () => {
        if (await visible(approve!.getByRole('heading', { name: 'Published', exact: true }))) return true;
        if (await visible(approve!.getByRole('heading', { name: 'Upload failed' }))) {
          if (++retries > 2) throw new Error(`the upload failed three times: ${redact(await bodyText())}`);
          stage.log('upload failed; trying again', { shown: redact(await bodyText()) });
          await approve!.getByRole('button', { name: 'Try upload again' }).click();
          return false;
        }
        const err = approve!.locator('.notice-error');
        if (await visible(err)) throw new Error(`the publish tab shows an error: ${redact((await err.first().innerText()) ?? '')}`);
        return false;
      },
      { timeoutMs: 900_000 },
    );
    entity = ((await approve.locator('.approve-record .mono-value').first().getAttribute('title')) ?? '') as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(entity)) throw new Error('no entity key on the Published notice');
    notes.entityKey = entity;
    notes.attachmentKey = await approve.locator('.approve-record .mono-value').nth(1).getAttribute('title').catch(() => null);
    stage.log('published', { entity, attachment: notes.attachmentKey });
    await stage.say('Published: evidence and code on Swarm, the index record on Arkiv');
    await stage.point(approve.getByRole('heading', { name: 'Published', exact: true }), 3200);
    await stage.roll('section verify');
    await stage.card(sectionCard('3', 'Verify', 'In any browser, from Arkiv and Swarm. Even offline, from the file.'), 2600);
    await stage.card(null, 400);
    await stage.press(approve.getByRole('link', { name: 'View this capture' }), 600);
  }
  /** A capture was published in this take (else the record page is the P2 live capture's). */
  const published = !o.dry && !o.rehearse;

  // g. The record page.
  if (!published) {
    await stage.show(record, record === main ? 'main' : 'approve');
    await stage.roll('section verify');
    await stage.card(sectionCard('3', 'Verify', 'In any browser, from Arkiv and Swarm. Even offline, from the file.'), 2600);
    await stage.cut();
    // The load (Arkiv, then Swarm) plays sped up under the first caption.
    await record.goto(`${APP_URL}#/c/${entity}`, { waitUntil: 'commit', timeout: 150_000 });
    await appRendered(stage, record, 90_000);
    await stage.overlay();
    await stage.card(null);
    await stage.where(undefined);
  }
  stage.beat('record');
  await soft(stage, 'the record page', async () => {
    const verdict = record.locator('[data-verdict]').first();
    await narrate(
      stage,
      [{ caption: 'The record page reads the index from Arkiv and the evidence from Swarm' }],
      async () => (await verdict.getAttribute('data-verdict', { timeout: 300 }).catch(() => null)) === 'pass',
      { minMs: 3600, timeoutMs: 180_000 },
    );
    await stage.say('Anyone can re-check this in their browser; nothing turns green unless it verifies.');
    await stage.point(verdict, 2600);
    const exhibit = record.locator('.exhibit').first();
    if (await visible(exhibit)) {
      await stage.say('What the witness saw: the server, the time, the exact answer it signed');
      await stage.point(exhibit, 3100);
    }
  });
  await soft(stage, 'the repository snapshot', async () => {
    const snapshot = record.locator('.repo-snapshot').first();
    if (published && !(await visible(snapshot))) {
      await stage.fast();
      await until('the repository snapshot card', () => visible(snapshot), 120_000).catch(() => undefined);
      await stage.roll();
    }
    if (await visible(snapshot)) {
      await stage.point(snapshot, 600);
      await narrate(
        stage,
        [{ caption: 'Repository snapshot: the browser downloads the code and recomputes the git tree hash' }],
        async () => {
          const phase = await snapshot.getAttribute('data-phase', { timeout: 300 }).catch(() => null);
          if (phase === 'ok') return true;
          if (phase && /mismatch|unavailable|error|fail/.test(phase)) throw new Error(`the repository snapshot says ${phase}: ${redact(await snapshot.innerText())}`);
          return false;
        },
        { minMs: 4000, timeoutMs: 240_000 },
      );
      await stage.say(`Hash-anchored ${CHECK}: this code is exactly the commit GitHub reported`);
      await stage.point(snapshot.getByText('Hash-anchored').first(), 3000);
      const dlCode = snapshot.getByRole('button', { name: /Download code/ });
      if (await visible(dlCode)) {
        await stage.say('Download code: the snapshot, straight from Swarm');
        const wait = record.waitForEvent('download', { timeout: 60_000 }).catch(() => null);
        await stage.press(dlCode, 900);
        const d = await wait;
        if (d) {
          notes.codeDownload = d.suggestedFilename();
          await d.saveAs(join(stage.runDir, 'downloads', d.suggestedFilename())).catch(() => undefined);
        }
        await sleep(2200);
      }
    } else if (published) {
      throw new Error('no repository snapshot card on the record page');
    }
  });
  await soft(stage, 'the checks summary', async () => {
    await stage.roll();
    const checks = record.locator('.checks-summary-row').first();
    if (await visible(checks)) {
      await stage.say(`Checks A ${CHECK} B ${CHECK} C ${CHECK}: the bytes, the request and the witness signature`);
      await stage.point(checks, 3300);
    }
  });

  // h. Tamper: one changed byte in the evidence file, dropped on Home.
  stage.beat('tamper');
  await soft(stage, 'the tamper check', async () => {
    await stage.roll();
    const dlBtn = record.getByRole('button', { name: 'Download evidence file' }).last();
    await stage.say('The evidence file can be checked anywhere, even offline');
    const dlWait = record.waitForEvent('download', { timeout: 60_000 });
    await stage.press(dlBtn, 900);
    const dl = await dlWait;
    const dlPath = join(stage.runDir, 'downloads', dl.suggestedFilename());
    mkdirSync(dirname(dlPath), { recursive: true });
    await dl.saveAs(dlPath);
    const edited = tamper(readFileSync(dlPath));
    await sleep(1200);
    await record.evaluate(() => {
      window.location.hash = '#/';
  });
  await record.locator('.dropzone').first().waitFor({ timeout: 30_000 });
  await stage.overlay();
  await stage.scrollTo(0, 300);
  await stage.say('Change one byte and it fails.');
  await dropFile(stage, record, `edited-${dl.suggestedFilename()}`, edited);
  const bad = record.locator('[data-verdict]').first();
  await until('the red verdict', async () => (await bad.getAttribute('data-verdict', { timeout: 300 }).catch(() => null)) === 'fail', 30_000);
  await sleep(700);
  await stage.point(bad, 2400);
  const checkA = record.locator('[data-check="A"]').first();
  if (await visible(checkA)) await stage.point(checkA, 2600);
  await stage.cut();
  });

  // i. The app on Swarm.
  stage.beat('swarm');
  await soft(stage, 'the app on Swarm', async () => {
    await record.goto(`${SWARM_APP_URL}#/c/${entity}`, { waitUntil: 'commit', timeout: 150_000 });
    await appRendered(stage, record, 90_000);
    await stage.overlay();
    await stage.where(undefined);
    const swarmVerdict = record.locator('[data-verdict]').first();
    await narrate(
      stage,
      [{ caption: 'The app itself is hosted on Swarm too: no single server can take it down.' }],
      async () => (await swarmVerdict.getAttribute('data-verdict', { timeout: 300 }).catch(() => null)) === 'pass',
      { minMs: 4200, timeoutMs: 180_000 },
    );
    await stage.say(`Same record, verified ${CHECK}, from the copy of the app on Swarm (recallapp.bzz.link)`);
    await stage.point(swarmVerdict, 3600);
    await stage.cut();
  });

  // j. End card.
  await record.goto(CARD_ORIGIN, { waitUntil: 'domcontentloaded' });
  await fontsReady(record);
  await stage.overlay();
  await stage.say('');
  await stage.where(null);
  await stage.card(END, 700);
  stage.beat('end');
  await stage.roll('end card');
  await sleep(7000);
  await stage.cut();

  if (treasury && before) {
    const after = await balances(treasury);
    const spent = { xbzz: before.xbzz - after.xbzz, xdai: before.xdai - after.xdai, tglm: before.tglm - after.tglm };
    notes.spend = { xbzz: formatUnits(spent.xbzz, 16), xdai: formatEther(spent.xdai), tglm: formatEther(spent.tglm) };
    notes.txs = money?.sent;
    notes.refused = money?.refused;
    stage.log('spent', notes.spend);
    const over = (['xbzz', 'xdai', 'tglm'] as const).filter((k) => spent[k] > CAPS[k]);
    if (over.length) stage.log(`WARNING: spend above the cap for ${over.join(', ')}`);
  }
}

function dirSizeMb(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else total += s.size;
    }
  };
  if (existsSync(dir)) walk(dir);
  return Math.round(total / 1e6);
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  loadEnvLocal();
  if (!existsSync(join(RELEASE_BUILD_DIR, 'manifest.json'))) throw new Error(`No release build at ${RELEASE_BUILD_DIR}. Run: pnpm extension:release`);
  if (o.localApp && !existsSync(join(APP_DIST, 'index.html'))) throw new Error(`No web build at ${APP_DIST}. Run: VITE_RECALL_NET=live pnpm --filter web build`);
  if (!o.dry) {
    treasuryKey();
    const popupJs = readFileSync(join(RELEASE_BUILD_DIR, 'popup.bundle.js'), 'utf8');
    if (!popupJs.includes('Capture this repository')) throw new Error('The release build has no repository capture yet. Run: pnpm extension:release');
    const appHasRepo = o.localApp
      ? readdirSync(join(APP_DIST, 'assets')).some((f) => f.endsWith('.js') && readFileSync(join(APP_DIST, 'assets', f), 'utf8').includes('Hash-anchored'))
      : await deployedAppHas(APP_URL, 'Hash-anchored');
    if (!appHasRepo) {
      throw new Error(
        o.localApp
          ? 'apps/web/dist has no repository snapshot yet. Rebuild it: VITE_RECALL_NET=live pnpm --filter web build'
          : 'The Pages app has no repository snapshot yet (not redeployed?). Wait for the deploy, or add --local-app.',
      );
    }
    const t = await repoTarget(o.repo);
    const earlier = await listByUrl(rabdiPub, urlHash(canonicalUrl(t.api))).catch(() => null);
    const n = earlier?.rows.length ?? 0;
    console.log(`Repository ${t.owner}/${t.repo} @ ${t.branch} -> ${t.api}`);
    if (n) {
      console.log(
        `NOTE: Arkiv already has ${n} record(s) for this branch. If GitHub's answer is unchanged, Recall offers a confirmation ` +
          'instead of a new capture, and this script stops before paying. A fresh branch: --repo https://github.com/<o>/<r>/tree/<branch>',
      );
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const kind = o.dry ? 'dry' : o.rehearse ? 'rehearse' : 'live';
  const runDir = join(tmpdir(), 'recall-demo', `${kind}-${stamp}`);
  mkdirSync(join(runDir, 'downloads'), { recursive: true });
  mkdirSync(o.profile, { recursive: true });
  const stage = new Stage(runDir, kind, VIEWPORT, { width: VIEWPORT.width * SCALE, height: VIEWPORT.height * SCALE });
  stage.notes.repo = o.repo;
  stage.notes.app = o.localApp ? 'apps/web/dist at the Pages origin' : APP_URL;
  const what = { dry: 'dry run: nothing is paid', rehearse: 'rehearsal: a real capture, stops before paying', live: 'LIVE: spends real tokens, within the caps' }[kind];
  console.log(`Recording (${what}) into ${runDir}`);

  const context = await chromium.launchPersistentContext(o.profile, {
    channel: 'chromium',
    headless: !o.headed,
    // No emulated viewport: the screencast sends what the window shows, so the window itself is
    // sized (Stage.fitWindow) to show 1280x720 CSS px, at a device scale of 1.5 (1920x1080 frames).
    viewport: null,
    colorScheme: 'light',
    bypassCSP: true,
    acceptDownloads: true,
    slowMo: 150,
    args: [
      `--disable-extensions-except=${RELEASE_BUILD_DIR}`,
      `--load-extension=${RELEASE_BUILD_DIR}`,
      // UDP to Cloudflare-fronted hosts is throttled on this network (see p2-live).
      '--disable-quic',
      '--hide-scrollbars',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height + 139}`,
      `--force-device-scale-factor=${SCALE}`,
    ],
  });
  let failed: unknown;
  try {
    await run(context, stage, o);
  } catch (e) {
    failed = e;
    console.error(`\nDEMO FAILED: ${redact(e instanceof Error ? e.message : String(e))}\n`);
    // What every tab showed when it failed (screenshots and page text, nothing secret).
    for (const [i, p] of context.pages().entries()) {
      const base = join(runDir, `failed-tab-${i + 1}`);
      await p.screenshot({ path: `${base}.png` }).catch(() => undefined);
      const text = await p.locator('body').innerText({ timeout: 2000 }).catch(() => '');
      writeFileSync(`${base}.txt`, `${redact(p.url())}\n\n${redact(text, 4000)}\n`);
      console.error(`  tab ${i + 1}: ${redact(p.url()).slice(0, 120)} -> ${base}.png`);
    }
  }
  const timelinePath = join(runDir, 'timeline.json');
  const timeline = await stage.finish(timelinePath);
  await context.close().catch(() => undefined);
  console.log(`timeline: ${timelinePath} (${timeline.shots.length} shots, frames ${dirSizeMb(join(runDir, 'frames'))} MB)`);

  if (o.edit && timeline.shots.length) {
    const out = failed ? o.out.replace(/\.mp4$/, '.partial.mp4') : o.out;
    const r = assemble(timelinePath, out, { budgetS: o.budget });
    console.table(r.shots.map((s) => ({ at: s.at.toFixed(1), out: s.outS.toFixed(1), speed: s.kind === 'fast' ? `${s.speed.toFixed(1)}x` : '1x', label: s.label })));
    console.log(`VIDEO: ${r.out} (${r.durationS.toFixed(1)} s)`);
    if (r.durationS > 180) console.log('WARNING: the video is longer than 3:00; shorten the holds in record-demo.ts or lower --budget');
    writeFileSync(join(runDir, 'result.json'), JSON.stringify({ video: r.out, durationS: r.durationS, failed: failed ? String(failed) : null, notes: stage.notes }, null, 1));
    if (!o.keepFrames && !failed) rmSync(join(runDir, 'frames'), { recursive: true, force: true });
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(redact(e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exit(1);
});
