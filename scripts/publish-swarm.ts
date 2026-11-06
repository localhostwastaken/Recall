// Publishes the web app (apps/web) as a Swarm website, so it keeps working after our own
// servers are gone. Run: `pnpm publish:swarm [options]` (tsx scripts/publish-swarm.ts).
//
//   --net local|live   Which network to build for and pay on (default local):
//                        local = the devnet (Bee :1633, Gnosis fork :9545), paid by the public
//                                bee-compose faucet key;
//                        live  = Swarm mainnet through a gateway, paid by TREASURY_PRIVATE_KEY
//                                from .env.local (never printed).
//   --bee <url>        The Bee API that receives the chunks (default: the net's upload URL,
//                      http://localhost:1633 locally).
//   --batch <id>       Stamp with this existing batch instead of buying one. The payer key must
//                      own it (the payer key is the stamp key) and it must be a batch no other
//                      upload has used yet: the stamper starts from empty buckets, so stamping
//                      into a used batch can reuse a slot and drop an earlier chunk.
//   --days <n>         Lifetime of a bought batch (default 30).
//   --depth 17|18      Depth of a bought batch (default 18, about 21 MB of stamp capacity).
//   --dir <path>       Publish this folder instead of building apps/web first. A warning is
//                      printed when the folder was built for the other network than --net.
//   --gnosis-rpc <url> Gnosis RPC to read and pay on (default: the net's own).
//   --feed             Also write a Swarm feed update that points at the new site, and print the
//                      feed manifest reference: a URL that keeps working when the site is
//                      published again (the pattern of docs.ethswarm.org/docs/develop/host-your-website).
//                      The feed is owned by HOSTING_FEED_KEY (.env.local; `pnpm feed:keygen` makes
//                      one), else by the payer key. Stamps come from the same batch, no extra cost.
//                      The feed is written only after the site was read back through the node.
//   --feed-topic <t>   The feed's topic name (default "website", the docs' choice; the topic is
//                      keccak256 of the name). The feed manifest is byte for byte what bee-js
//                      createFeedManifest stores, and an update is what makeFeedWriter(...)
//                      .uploadReference sends; only the stamp is made here.
//   --max-xbzz <n>     Refuse a batch that costs more than this many xBZZ (default 5).
//   --new-batch        Live runs record their batch in .publish-state.json (gitignored) and refuse
//                      to buy another while it is unfinished (resume it instead: see below).
//                      --days is at most 90.
// How it works. No Bee node owns the batch, so every chunk is stamped here, on the client:
// each file is split into chunks, each chunk is stamped with the batch owner's key (`Stamper`)
// and pushed with `POST /chunks`. The mantaray manifest that maps paths to files (index
// document `index.html`) is built with `MantarayNode.saveRecursively(onChunk)`, whose chunks
// take the same route. The resulting root reference is the website: `/bzz/<ref>/`.
//
// Every chunk push has a 30 s time limit and is tried again (the stamp is made once, so a retry
// never uses another slot): 3 tries on the devnet; on live 6 tries up to 10 s apart, 3 in flight,
// honouring Retry-After, and every 4xx is retried until the first push has gone through (a
// gateway may not know a fresh batch yet). The guard that stops a live run without --yes comes
// before the build, and the build gets only a minimal environment (no wallet keys). A failure
// after the batch is bought prints the command that resumes on the same batch
// (`--batch <id> --dir <dist> --no-wait`): the site manifest is deterministic, so a resumed run
// re-stamps exactly the slots of the first try.
//
// Type-checking the app is `pnpm --filter web typecheck` (CI does it); this script only runs
// `vite build`, so a half-edited source tree that still bundles can be published locally.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, parseAbi, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { BEE_COMPOSE_FAUCET_KEY } from '../e2e/fixtures/keys';
import {
  LOCAL,
  POSTAGE_STAMP,
  Stamper,
  XBZZ,
  buyBatch,
  costFor,
  liveConfig,
  normalizeKey,
  redactKey,
  waitBatchUsable,
} from '../packages/net/src/index';
// bee-js comes through packages/net's hosting helper (it is a dependency of that package only).
import {
  ChunkSplitter,
  MantarayNode,
  NULL_ADDRESS,
  Reference,
  DEFAULT_FEED_TOPIC,
  builtNetOf,
  feedManifest,
  feedOwnerOf,
  feedTopic,
  feedUpdate,
  isClientError,
  isRetryable,
  nextFeedIndex,
  pushChunk,
  pushFeedUpdate,
  readFeed,
  refuseNewBuy,
  REQUEST_TIMEOUT_MS,
  resumeCommand,
  retryWithBackoff,
  zeroObfuscation,
  Bee,
  type PublishState,
  type RetryOptions,
} from '../packages/net/src/hosting';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'apps', 'web');
const INDEX_DOCUMENT = 'index.html';
/** Chunk pushes in flight at once on the devnet (stamps are still issued one by one, in order); live is gentler. */
const CONCURRENCY = 8;
const LIVE_CONCURRENCY = 3;
/** A batch that lasts longer than this is refused: this script hosts a demo, not an archive. */
const MAX_DAYS = 90;
/** The most xBZZ one run may pay for a batch unless --max-xbzz says otherwise. */
const DEFAULT_MAX_XBZZ = '5';
/** Where a live run records its batch (gitignored): the money must never be spent twice by accident. */
const STATE_FILE = join(ROOT, '.publish-state.json');

// Common web types; anything else is served as a download. Bee returns this metadata as the
// Content-Type header, and a browser refuses a module script that is not a JavaScript type.
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

const say = (msg: string) => console.log(msg);

// Keys this run handles. Every message shown goes through redactKey first, as a last line of
// defence (an error that quotes a URL or a header must not carry a key).
const secrets: string[] = [];
const hide = (key: string | undefined) => {
  if (key) secrets.push(key, key.replace(/^0x/i, ''));
};
const clean = (text: string) => redactKey(text, ...secrets);

function fail(msg: string): never {
  console.error(`publish-swarm: ${clean(msg)}`);
  process.exit(1);
}

/** Reads one variable from the repo-root .env.local (gitignored); the process env wins. */
function envLocal(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const text = readFileSync(join(ROOT, '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && m[1] === name) return m[2].replace(/^(['"])(.*)\1$/, '$2') || undefined;
    }
  } catch {
    /* no .env.local */
  }
  return undefined;
}

function listFiles(dir: string): { path: string; abs: string }[] {
  const out: { path: string; abs: string }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === '.DS_Store') continue;
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push({ path: relative(dir, abs).split(sep).join('/'), abs });
    }
  };
  walk(dir);
  return out;
}

/**
 * The only variables the web build gets: no wallet keys, no tokens, nothing else from this shell.
 * The NODE_ ones are listed one by one (NODE_TLS_REJECT_UNAUTHORIZED and the like stay out).
 */
const BUILD_ENV_KEEP =
  /^(PATH|HOME|NODE_OPTIONS|NODE_PATH|NODE_ENV|NODE_EXTRA_CA_CERTS|NODE_NO_WARNINGS|NODE_DISABLE_COLORS|VITE_[A-Z0-9_]*|ARKIV_ACCESS_KEY)$/;

function buildWeb(net: 'local' | 'live'): string {
  const outDir = join(WEB, 'dist');
  say(`Building apps/web for the ${net} network...`);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && BUILD_ENV_KEEP.test(k)) env[k] = v;
  env.VITE_RECALL_NET = net;
  // R30: a live build bakes the (public) Arkiv access key in; vite.config.ts also reads .env.local itself.
  const arkivKey = net === 'live' ? envLocal('ARKIV_ACCESS_KEY') : undefined;
  if (arkivKey) env.ARKIV_ACCESS_KEY = arkivKey;
  const r = spawnSync('pnpm', ['--filter', 'web', 'exec', 'vite', 'build', '--emptyOutDir'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(clean(`${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').slice(-40).join('\n')));
    fail('the web build failed');
  }
  return outDir;
}

const postageAbi = parseAbi([
  'function batchOwner(bytes32 _batchId) view returns (address)',
  'function batchDepth(bytes32 _batchId) view returns (uint8)',
]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** GET with a few tries: a gateway may lag behind the push. Resolves with the last response, or undefined. */
async function fetchWithTries(url: string, tries: number, waitMs: number, ok: (r: Response) => boolean): Promise<Response | undefined> {
  let last: Response | undefined;
  for (let i = 0; i < tries; i++) {
    last = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => undefined);
    if (last && ok(last)) return last;
    if (i < tries - 1) await sleep(waitMs);
  }
  return last;
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

// ---- the state file: a live run's paid-for batch, so a failure never costs a second purchase ----
function readState(): PublishState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as PublishState;
  } catch {
    return {};
  }
}
function updateState(change: (s: PublishState) => PublishState): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(change(readState()), null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  const { values } = parseArgs({
    options: {
      net: { type: 'string', default: 'local' },
      bee: { type: 'string' },
      batch: { type: 'string' },
      days: { type: 'string', default: '30' },
      depth: { type: 'string', default: '18' },
      dir: { type: 'string' },
      'gnosis-rpc': { type: 'string' },
      'max-xbzz': { type: 'string', default: DEFAULT_MAX_XBZZ },
      'new-batch': { type: 'boolean', default: false },
      feed: { type: 'boolean', default: false },
      'feed-topic': { type: 'string', default: DEFAULT_FEED_TOPIC },
      yes: { type: 'boolean', default: false },
      'no-wait': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const net = values.net;
  if (net !== 'local' && net !== 'live') fail('--net must be local or live');
  const live = net === 'live';
  const days = Number(values.days);
  if (!(days > 0)) fail('--days must be a positive number');
  if (days > MAX_DAYS) fail(`--days is at most ${MAX_DAYS}`);
  const depth = Number(values.depth);
  if (depth !== 17 && depth !== 18) fail('--depth must be 17 or 18');
  let maxXbzz: bigint;
  try {
    maxXbzz = parseUnits(values['max-xbzz'] ?? DEFAULT_MAX_XBZZ, 16);
  } catch {
    fail('--max-xbzz must be a plain decimal number of xBZZ');
  }
  const cfg = net === 'local' ? LOCAL : liveConfig({});
  const beeUrl = (values.bee ?? cfg.swarm.uploadUrl).replace(/\/+$/, '');
  const gnosisRpc = values['gnosis-rpc'] ?? cfg.gnosis.rpcUrl;
  hide(envLocal('ARKIV_ACCESS_KEY'));

  // Pushes: the devnet gets 3 quick tries; a public gateway gets 6 tries up to 10 s apart, 3 at once.
  const policy: RetryOptions = live ? { tries: 6, backoffMs: [1000, 2000, 4000, 8000, 10_000] } : {};
  const concurrency = live ? LIVE_CONCURRENCY : CONCURRENCY;

  // The payer is also the batch owner, so it is also the stamp key.
  let payerKey: Hex;
  if (!live) {
    payerKey = BEE_COMPOSE_FAUCET_KEY;
  } else {
    const raw = envLocal('TREASURY_PRIVATE_KEY');
    if (!raw) fail('TREASURY_PRIVATE_KEY is not set (put it in .env.local)');
    payerKey = normalizeKey(raw);
  }
  hide(payerKey);
  const account = privateKeyToAccount(payerKey);
  const transport = http(gnosisRpc);
  const pub = createPublicClient({ chain: gnosis, transport });

  // The feed key: HOSTING_FEED_KEY, else the payer key. Never printed.
  let feedKey: Hex | undefined;
  const topicName = values['feed-topic']!;
  if (values.feed) {
    const raw = live ? envLocal('HOSTING_FEED_KEY') : process.env.HOSTING_FEED_KEY;
    feedKey = raw ? normalizeKey(raw) : payerKey;
    hide(feedKey);
    if (!/^0x[0-9a-fA-F]{64}$/.test(feedKey)) fail('HOSTING_FEED_KEY must be a 32-byte hex key');
    say(`Feed owner: ${privateKeyToAccount(feedKey).address} (${raw ? 'HOSTING_FEED_KEY' : 'the payer key'}), topic "${topicName}".`);
    const last = readState().lastFeed;
    if (live && last && last.topic === topicName && last.owner.toLowerCase() !== privateKeyToAccount(feedKey).address.toLowerCase()) {
      console.warn(
        `Warning: the last feed written here for topic "${topicName}" belonged to ${last.owner}; this run's owner is different, so the feed manifest address changes (${last.manifestRef} is no longer updated).`,
      );
    }
  }
  const feedSigner = feedKey ? feedOwnerOf(feedKey) : undefined;
  const topic = feedTopic(topicName);

  // Preflight, before anything is built or bought: the node answers, and (for a feed) its lookup
  // answers and the next index can be read.
  const health = await fetch(`${beeUrl}/health`, { signal: AbortSignal.timeout(15_000) }).catch((e: Error) => e);
  if (health instanceof Error) fail(`cannot reach ${beeUrl}: ${health.message}`);
  await health.body?.cancel().catch(() => undefined);
  if (!health.ok) say(`Note: ${beeUrl}/health answered HTTP ${health.status}; going on.`);
  const lookupIndex = () =>
    retryWithBackoff('feed index lookup', (signal) => nextFeedIndex(beeUrl, feedSigner!.owner, topic, { signal }), {
      ...policy,
      retryable: () => true,
    });
  let preIndex: bigint | undefined;
  if (feedSigner) {
    preIndex = await lookupIndex().catch((e: Error) => fail(`${e.message}. The feed cannot be updated through ${beeUrl}; nothing was bought.`));
    say(`Feed preflight: the next update takes index ${preIndex}.`);
  }

  // Everything else that can refuse the run comes next, before the build and before any spend.
  let batchId: Hex | undefined;
  let batchDepth = depth;
  let quoted = 0n;
  if (values.batch) {
    batchId = (values.batch.startsWith('0x') ? values.batch : `0x${values.batch}`) as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(batchId)) fail('--batch must be a 32-byte hex batch id');
    const owner = await pub.readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'batchOwner', args: [batchId] });
    if (owner.toLowerCase() !== account.address.toLowerCase()) {
      fail(`batch ${batchId} is owned by ${owner}, not by the payer ${account.address}; only its owner can stamp`);
    }
    batchDepth = Number(
      await pub.readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'batchDepth', args: [batchId] }),
    );
    say(`Using batch ${batchId} (depth ${batchDepth}). It must not have stamped any other upload yet.`);
  } else {
    quoted = await costFor(pub, depth, days);
    const balance = await pub.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
    say(`A depth-${depth} batch for ${days} days costs ${formatUnits(quoted, 16)} xBZZ; ${account.address} holds ${formatUnits(balance, 16)}.`);
    if (quoted > maxXbzz) fail(`that is more than --max-xbzz ${formatUnits(maxXbzz, 16)}; raise it only if the price is expected`);
    if (live && !values.yes) fail('this spends real xBZZ on Gnosis mainnet; run again with --yes to buy the batch');
    if (balance < quoted) fail('the payer does not hold enough xBZZ for the batch');
    if (live && !values['new-batch']) {
      const b = readState().batch;
      const refusal = refuseNewBuy(
        readState(),
        b?.batchId && b.dir ? resumeCommand({ net, batchId: b.batchId, dir: b.dir, bee: values.bee, feedTopic: feedKey ? topicName : undefined }) : undefined,
      );
      if (refusal) fail(refusal);
    }
  }

  let webDir: string;
  if (values.dir) {
    webDir = resolve(values.dir);
    if (!existsSync(join(webDir, INDEX_DOCUMENT))) fail(`${webDir} has no ${INDEX_DOCUMENT}`);
    const built = builtNetOf(webDir);
    if (built && built !== net) {
      console.warn(`Warning: ${relative(ROOT, webDir) || webDir} was built for the ${built} network but --net is ${net}. Publishing it as is.`);
    } else if (!built) {
      say(`Note: could not tell which network ${relative(ROOT, webDir) || webDir} was built for; it must match --net ${net}.`);
    }
  } else {
    webDir = buildWeb(net);
    if (!existsSync(join(webDir, INDEX_DOCUMENT))) fail(`${webDir} has no ${INDEX_DOCUMENT}`);
  }
  const files = listFiles(webDir);
  say(`Site: ${files.length} files from ${relative(ROOT, webDir) || '.'}`);

  // Batch: bought here (owner = payer), or the existing one checked above. Each step of the money
  // is shown (and, live, saved) as soon as it has a hash.
  const now = () => new Date().toISOString();
  const saveBatch = (b: NonNullable<PublishState['batch']>) => {
    if (live) updateState((s) => ({ ...s, batch: { ...s.batch, ...b } }));
  };
  if (!batchId) {
    const wallet = createWalletClient({ account, chain: gnosis, transport });
    let sentTx: Hex | undefined;
    try {
      const bought = await buyBatch(wallet, {
        owner: account.address,
        depth: depth as 17 | 18,
        days,
        quotedTotal: quoted, // the price may move up 10% at most between the quote and the purchase
        onApproveSent: (h) => say(`Approval sent: ${h}`),
        onSent: (h) => {
          sentTx = h;
          say(`Batch purchase sent: ${h} (waiting for it to be mined)`);
          saveBatch({ status: 'sent', txHash: h, dir: webDir, at: now() });
        },
      });
      batchId = bought.batchId;
      saveBatch({ status: 'bought', txHash: bought.txHash, batchId, depth, dir: webDir, at: now() });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      fail(
        sentTx
          ? `${why}. The purchase transaction ${sentTx} was sent and may still be mined: check it on gnosisscan before buying again (a live run refuses a second purchase while ${relative(ROOT, STATE_FILE)} shows it; --new-batch overrides).`
          : why,
      );
    }
    say(`Batch ${batchId} created (owner ${account.address}).`);
  } else {
    saveBatch({ status: 'bought', batchId, depth: batchDepth, dir: webDir, at: now() });
  }
  const paidBatch: Hex = batchId;
  const resume = resumeCommand({ net, batchId: paidBatch, dir: webDir, bee: values.bee, feedTopic: feedKey ? topicName : undefined });

  // From here on the batch is paid for: any failure prints how to continue without paying again.
  try {
    await afterBuy();
  } catch (e) {
    console.error(`publish-swarm: ${clean(e instanceof Error ? e.message : String(e))}`);
    console.error(`Batch ${paidBatch} is paid for. Continue without buying again:\n  ${resume}`);
    process.exit(1);
  }

  async function afterBuy() {
    if (!values['no-wait']) {
      say(`Waiting until ${beeUrl} accepts stamps of the batch (about a minute)...`);
      // A node with /chainstate and /batches is asked; a public gateway without them is judged by the chain.
      await waitBatchUsable(beeUrl, paidBatch, 10 * 60_000, { chain: pub });
    }

    // Client-side stamping: one Stamper for the whole site, so no slot is ever used twice.
    const stamper = Stamper.fromBlank(payerKey, paidBatch, batchDepth);
    const bee = new Bee(beeUrl);
    const seen = new Set<string>();
    const inflight = new Set<Promise<void>>();
    let failure: unknown;
    let pushed = 0;
    // A stamp-related 4xx can be a batch the gateway does not know yet: until one push has gone
    // through, every 4xx is tried again.
    let firstPushOk = false;
    const retryable = (e: unknown) => isRetryable(e) || (!firstPushOk && isClientError(e));

    type Pushable = { hash(): { toUint8Array(): Uint8Array; toHex(): string }; build(): Uint8Array };
    async function put(chunk: Pushable): Promise<void> {
      if (failure) throw failure;
      const address = chunk.hash().toHex();
      if (seen.has(address)) return; // identical chunks (e.g. two empty files) are stored once
      seen.add(address);
      const envelope = stamper.stamp(chunk.hash().toUint8Array()); // once: a retry re-sends this stamp
      const data = chunk.build();
      const task: Promise<void> = retryWithBackoff(
        `push of chunk ${address.slice(0, 8)}`,
        (signal) => pushChunk(beeUrl, envelope, data, signal),
        { ...policy, retryable },
      )
        .then(() => {
          firstPushOk = true;
          pushed++;
        })
        .catch((e: unknown) => void (failure ??= e))
        .finally(() => void inflight.delete(task));
      inflight.add(task);
      if (inflight.size >= concurrency) await Promise.race(inflight);
    }
    const settle = async () => {
      await Promise.all(inflight);
      if (failure) throw failure;
    };

    const site = new MantarayNode();
    let bytesTotal = 0;
    for (const file of files) {
      const bytes = readFileSync(file.abs);
      bytesTotal += bytes.length;
      const splitter = new ChunkSplitter(async (batch: { chunk: Pushable }[]) => {
        for (const { chunk } of batch) await put(chunk);
        return [];
      });
      await splitter.append(bytes);
      const root = await splitter.finalize(); // the root chunk never reaches the batch callback
      await put(root);
      site.addFork(file.path, root.hash(), {
        'Content-Type': MIME[extname(file.path).toLowerCase()] ?? 'application/octet-stream',
        Filename: file.path.split('/').pop()!,
      });
    }
    // The index document is what a bare /bzz/<ref>/ serves. The app is a single page that routes by
    // hash, so every unknown path serves it too (the error document is the index document).
    site.addFork('/', NULL_ADDRESS, {
      'website-index-document': INDEX_DOCUMENT,
      'website-error-document': INDEX_DOCUMENT,
    });
    // Zero obfuscation keys: the manifest, and so every stamp slot, is the same on a resumed run.
    zeroObfuscation(site);
    const { reference } = await site.core.saveRecursively(async (chunk: Pushable) => put(chunk));
    await settle();

    const ref = Buffer.from(reference).toString('hex');
    say(`Uploaded ${pushed} chunks (${bytesTotal} bytes of files). Site manifest: ${ref}`);
    saveBatch({ status: 'uploaded', siteRef: ref, at: now() });

    // Read the site back through the node the way a visitor would, BEFORE a feed is pointed at it.
    // Locally any miss is an error. On a public gateway an unreachable page only leaves the site
    // "unconfirmed" (HTML may be held for moderation, the network may lag), but a page that arrives
    // with other bytes is always an error.
    const problems: string[] = [];
    const unconfirmed: string[] = [];
    const tries = live ? 4 : 1;
    const check = async (label: string, url: string, want: Buffer) => {
      const got = await fetchWithTries(url, tries, 5000, (r) => r.ok);
      if (got?.ok) {
        if (Buffer.from(await got.arrayBuffer()).equals(want)) return say(`Verified: ${label} (${url}).`);
        problems.push(`${label}: ${url} served other bytes than the local file`);
        return;
      }
      const why = `${label}: ${url} did not answer with the file (${got ? `HTTP ${got.status}` : 'unreachable'})`;
      if (live) {
        console.warn(`Warning: ${why}. A gateway can hold content until it is approved; check again later.`);
        unconfirmed.push(why);
      } else problems.push(why);
    };
    const indexBytes = readFileSync(join(webDir, INDEX_DOCUMENT));
    await check('index document', `${beeUrl}/bzz/${ref}/`, indexBytes);
    // One script, read through the manifest: it spans many chunks, so it proves the chunk tree too.
    const js = files
      .filter((f) => /\.m?js$/.test(f.path))
      .map((f) => ({ ...f, size: statSync(f.abs).size }))
      .sort((a, b) => b.size - a.size)[0];
    if (js) await check('JS asset', `${beeUrl}/bzz/${ref}/${encodePath(js.path)}`, readFileSync(js.abs));
    else say('No JS asset in the site to read back.');
    if (problems.length) throw new Error(`verification failed:\n  ${problems.join('\n  ')}`);

    // Optional feed: an owner-signed single-owner chunk pointing at the new manifest, stamped here
    // like every other chunk, plus the feed manifest (the permanent address of the feed). It is
    // written only for a site that was read back above.
    let feed: { owner: string; index: bigint; manifestRef: string } | undefined;
    if (feedKey && feedSigner) {
      if (unconfirmed.length) {
        console.warn(
          `Warning: the feed was NOT updated, because the site could not be read back yet. When it can, run:\n  ${resume}`,
        );
      } else {
        // The index is read again right before the push: another update may have landed since the preflight.
        const index = await lookupIndex();
        if (preIndex !== undefined && index !== preIndex) {
          console.warn(`Warning: the next feed index is ${index}, it was ${preIndex} at the preflight (another update landed); using ${index}.`);
        }
        const update = feedUpdate(feedSigner.owner, topic, index, reference);
        const envelope = stamper.stamp(update.address.toUint8Array());
        await retryWithBackoff(`feed update ${index}`, (signal) => pushFeedUpdate(bee, feedSigner.signer, envelope, update, signal), {
          ...policy,
          retryable,
        });
        const { reference: fref } = await feedManifest(feedSigner.owner, topic).core.saveRecursively(async (chunk: Pushable) => put(chunk));
        await settle();
        feed = { owner: privateKeyToAccount(feedKey).address, index, manifestRef: Buffer.from(fref).toString('hex') };
        say(`Feed update ${index} pushed. Feed manifest: ${feed.manifestRef}`);

        // The feed lookup also asks the network for the next index, so a node may say "not found" for
        // a few seconds after the push: poll until it names the new manifest.
        let seenAt: { reference: string; index: string } | undefined;
        for (let i = 0; i < (live ? 24 : 40); i++) {
          seenAt = await readFeed(beeUrl, feedSigner.owner, topic);
          if (seenAt?.reference === ref) break;
          await sleep(1500);
        }
        if (seenAt?.reference === ref) {
          say(`Verified: the feed (index ${seenAt.index}) points at ${ref}.`);
          await check('feed manifest', `${beeUrl}/bzz/${feed.manifestRef}/`, indexBytes);
        } else if (seenAt) {
          // A readable update that is not ours (a lower index, or another site) is never "just lag".
          problems.push(
            `the feed points at ${seenAt.reference} (index ${seenAt.index}), not at ${ref} (index ${index}): another update, or a node that has not got ours. Do not publish again before this is explained`,
          );
        } else if (live) {
          console.warn(`Warning: the feed has no readable update through ${beeUrl} yet; check it later.`);
        } else {
          problems.push(`the feed has no readable update through ${beeUrl}`);
        }
        if (problems.length) throw new Error(`verification failed:\n  ${problems.join('\n  ')}`);
      }
    }

    // A DNS label is at most 63 characters, so the 64-character hex reference cannot be a
    // subdomain; bzz.link takes the CID form there.
    const cid = new Reference(ref).toCid('manifest');
    say('');
    say(`bzz reference: ${ref}`);
    say(`batch: ${paidBatch} (owner ${account.address}, depth ${batchDepth})`);
    say(`via your Bee node: ${beeUrl}/bzz/${ref}/`);
    say(`bzz.link: https://${cid}.bzz.link/`);
    say(`bzz.link (path form): https://bzz.link/bzz/${ref}/`);
    if (feed) {
      say('');
      say(`feed owner: ${feed.owner}`);
      say(`feed topic: ${topicName} (${topic.toHex()})`);
      say(`feed update: index ${feed.index} -> ${ref}`);
      say(`feed manifest reference: ${feed.manifestRef}`);
      say(`feed via your Bee node: ${beeUrl}/bzz/${feed.manifestRef}/`);
      say(`feed bzz.link: https://${new Reference(feed.manifestRef).toCid('feed')}.bzz.link/`);
      say(`feed bzz.link (path form): https://bzz.link/bzz/${feed.manifestRef}/`);
    }
    if (live) {
      updateState((s) => ({
        ...s,
        batch: { ...s.batch!, status: unconfirmed.length ? 'uploaded' : 'done', siteRef: ref, at: now() },
        ...(feed ? { lastFeed: { owner: feed.owner, topic: topicName, manifestRef: feed.manifestRef, index: String(feed.index) } } : {}),
      }));
    }
  }
}

main().catch((e: unknown) => {
  // Error messages never include a key: it is only ever handed to the signer, and redactKey is a second wall.
  console.error(`publish-swarm: ${clean(e instanceof Error ? e.message : String(e))}`);
  process.exit(1);
});
