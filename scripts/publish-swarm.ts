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
//                      published again. The feed is owned by HOSTING_FEED_KEY (.env.local), else
//                      by the payer key. Stamps come from the same batch, no extra cost.
//   --feed-topic <t>   The feed's topic name (default recall-app).
//   --yes              Required with --net live when buying a batch: that spends real xBZZ
//                      (the dry run without it prints the price and the payer, then stops).
//   --no-wait          Do not wait for the node to accept stamps of a fresh batch. The wait works
//                      on a node (it reads /chainstate and /batches) and on a public gateway
//                      (which hides them: the batch counts as usable some blocks after creation,
//                      judged from the Gnosis chain).
//
// How it works. No Bee node owns the batch, so every chunk is stamped here, on the client:
// each file is split into chunks, each chunk is stamped with the batch owner's key (`Stamper`)
// and pushed with `POST /chunks`. The mantaray manifest that maps paths to files (index
// document `index.html`) is built with `MantarayNode.saveRecursively(onChunk)`, whose chunks
// take the same route. The resulting root reference is the website: `/bzz/<ref>/`.
//
// Every chunk push has a 30 s time limit and is tried 3 times (the stamp is made once, so a retry
// never uses another slot). The guard that stops a live run without --yes comes before the
// build, and the build gets only a minimal environment (no wallet keys).
//
// Type-checking the app is `pnpm --filter web typecheck` (CI does it); this script only runs
// `vite build`, so a half-edited source tree that still bundles can be published locally.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, parseAbi, type Hex } from 'viem';
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
  waitBatchUsable,
} from '../packages/net/src/index';
// bee-js comes through packages/net's hosting helper (it is a dependency of that package only).
import {
  Bee,
  ChunkSplitter,
  MantarayNode,
  NULL_ADDRESS,
  Reference,
  builtNetOf,
  feedManifest,
  feedOwnerOf,
  feedTopic,
  feedUpdate,
  nextFeedIndex,
  pushFeedUpdate,
  readFeed,
  REQUEST_TIMEOUT_MS,
  retryWithBackoff,
} from '../packages/net/src/hosting';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'apps', 'web');
const INDEX_DOCUMENT = 'index.html';
/** Chunk pushes in flight at once. Stamps are still issued one by one, in order. */
const CONCURRENCY = 8;

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

function fail(msg: string): never {
  console.error(`publish-swarm: ${msg}`);
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

/** The only variables the web build gets: no wallet keys, no tokens, nothing else from this shell. */
const BUILD_ENV_KEEP = /^(PATH|HOME|NODE_[A-Z0-9_]*|VITE_[A-Z0-9_]*|ARKIV_ACCESS_KEY)$/;

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
    console.error(`${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').slice(-40).join('\n'));
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
      feed: { type: 'boolean', default: false },
      'feed-topic': { type: 'string', default: 'recall-app' },
      yes: { type: 'boolean', default: false },
      'no-wait': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const net = values.net;
  if (net !== 'local' && net !== 'live') fail('--net must be local or live');
  const days = Number(values.days);
  if (!(days > 0)) fail('--days must be a positive number');
  const depth = Number(values.depth);
  if (depth !== 17 && depth !== 18) fail('--depth must be 17 or 18');
  const cfg = net === 'local' ? LOCAL : liveConfig({});
  const beeUrl = (values.bee ?? cfg.swarm.uploadUrl).replace(/\/+$/, '');
  const gnosisRpc = values['gnosis-rpc'] ?? cfg.gnosis.rpcUrl;

  // The payer is also the batch owner, so it is also the stamp key.
  let payerKey: Hex;
  if (net === 'local') {
    payerKey = BEE_COMPOSE_FAUCET_KEY;
  } else {
    const raw = envLocal('TREASURY_PRIVATE_KEY');
    if (!raw) fail('TREASURY_PRIVATE_KEY is not set (put it in .env.local)');
    payerKey = normalizeKey(raw);
  }
  const account = privateKeyToAccount(payerKey);
  const transport = http(gnosisRpc);
  const pub = createPublicClient({ chain: gnosis, transport });

  // The feed key: HOSTING_FEED_KEY, else the payer key. Never printed.
  let feedKey: Hex | undefined;
  if (values.feed) {
    const raw = net === 'live' ? envLocal('HOSTING_FEED_KEY') : process.env.HOSTING_FEED_KEY;
    feedKey = raw ? normalizeKey(raw) : payerKey;
    if (!/^0x[0-9a-fA-F]{64}$/.test(feedKey)) fail('HOSTING_FEED_KEY must be a 32-byte hex key');
    say(`Feed owner: ${privateKeyToAccount(feedKey).address} (${raw ? 'HOSTING_FEED_KEY' : 'the payer key'}), topic "${values['feed-topic']}".`);
  }

  // Everything that can refuse the run comes first, before the build and before any spend.
  let batchId: Hex | undefined;
  let batchDepth = depth;
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
    const cost = await costFor(pub, depth, days);
    const balance = await pub.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
    say(`A depth-${depth} batch for ${days} days costs ${formatUnits(cost, 16)} xBZZ; ${account.address} holds ${formatUnits(balance, 16)}.`);
    if (net === 'live' && !values.yes) fail('this spends real xBZZ on Gnosis mainnet; run again with --yes to buy the batch');
    if (balance < cost) fail('the payer does not hold enough xBZZ for the batch');
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

  // Batch: bought here (owner = payer), or the existing one checked above.
  if (!batchId) {
    const wallet = createWalletClient({ account, chain: gnosis, transport });
    ({ batchId } = await buyBatch(wallet, { owner: account.address, depth: depth as 17 | 18, days }));
    say(`Batch ${batchId} created (owner ${account.address}).`);
  }
  if (!values['no-wait']) {
    say(`Waiting until ${beeUrl} accepts stamps of the batch (about a minute)...`);
    // A node with /chainstate and /batches is asked; a public gateway without them is judged by the chain.
    await waitBatchUsable(beeUrl, batchId, 10 * 60_000, { chain: pub }).catch((e: Error) => {
      fail(`${e.message}. Retry with --batch ${batchId} --no-wait`);
    });
  }

  // Client-side stamping: one Stamper for the whole site, so no slot is ever used twice.
  const stamper = Stamper.fromBlank(payerKey, batchId, batchDepth);
  const bee = new Bee(beeUrl);
  const seen = new Set<string>();
  const inflight = new Set<Promise<void>>();
  let failure: unknown;
  let pushed = 0;

  type Pushable = { hash(): { toUint8Array(): Uint8Array; toHex(): string }; build(): Uint8Array };
  async function put(chunk: Pushable): Promise<void> {
    if (failure) throw failure;
    const address = chunk.hash().toHex();
    if (seen.has(address)) return; // identical chunks (e.g. two empty files) are stored once
    seen.add(address);
    const envelope = stamper.stamp(chunk.hash().toUint8Array()); // once: a retry re-sends this stamp
    const data = chunk.build();
    const task: Promise<void> = retryWithBackoff(`push of chunk ${address.slice(0, 8)}`, (signal) =>
      bee.chunk.upload(envelope, data, { deferred: false }, { signal }),
    )
      .then(() => void pushed++)
      .catch((e: unknown) => void (failure ??= e))
      .finally(() => void inflight.delete(task));
    inflight.add(task);
    if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
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
  // The index document is what a bare /bzz/<ref>/ serves.
  site.addFork('/', NULL_ADDRESS, { 'website-index-document': INDEX_DOCUMENT });
  const { reference } = await site.core.saveRecursively(async (chunk: Pushable) => put(chunk));
  await settle();

  const ref = Buffer.from(reference).toString('hex');
  say(`Uploaded ${pushed} chunks (${bytesTotal} bytes of files). Site manifest: ${ref}`);

  // Optional feed: an owner-signed single-owner chunk pointing at the new manifest, stamped here
  // like every other chunk, plus the feed manifest (the permanent address of the feed).
  let feed: { owner: string; topicName: string; topicHex: string; index: bigint; manifestRef: string } | undefined;
  let feedOwner: ReturnType<typeof feedOwnerOf>['owner'] | undefined;
  let feedTopicValue: ReturnType<typeof feedTopic> | undefined;
  if (feedKey) {
    const { signer, owner } = feedOwnerOf(feedKey);
    feedOwner = owner;
    feedTopicValue = feedTopic(values['feed-topic']!);
    const index = await retryWithBackoff('feed index lookup', (signal) => nextFeedIndex(bee, owner, feedTopicValue!, signal));
    const update = feedUpdate(owner, feedTopicValue, index, reference);
    const envelope = stamper.stamp(update.address.toUint8Array());
    await retryWithBackoff(`feed update ${index}`, (signal) => pushFeedUpdate(bee, signer, envelope, update, signal));
    const { reference: fref } = await feedManifest(owner, feedTopicValue).core.saveRecursively(async (chunk: Pushable) => put(chunk));
    await settle();
    feed = {
      owner: privateKeyToAccount(feedKey).address,
      topicName: values['feed-topic']!,
      topicHex: feedTopicValue.toHex(),
      index,
      manifestRef: Buffer.from(fref).toString('hex'),
    };
    say(`Feed update ${index} pushed. Feed manifest: ${feed.manifestRef}`);
  }

  // Read it back through the node the way a visitor would. A mismatch is an error locally; on a
  // public gateway an unreachable page only warns (HTML may be held for moderation, and the
  // network may lag), but a page that arrives with other bytes is always an error.
  const problems: string[] = [];
  const lagTolerant = net === 'live';
  const tries = lagTolerant ? 4 : 1;
  const check = async (label: string, url: string, want: Buffer) => {
    const got = await fetchWithTries(url, tries, 5000, (r) => r.ok);
    if (got?.ok) {
      if (Buffer.from(await got.arrayBuffer()).equals(want)) return say(`Verified: ${label} (${url}).`);
      problems.push(`${label}: ${url} served other bytes than the local file`);
      return;
    }
    const why = `${label}: ${url} did not answer with the file (${got ? `HTTP ${got.status}` : 'unreachable'})`;
    if (lagTolerant) console.warn(`Warning: ${why}. A gateway can hold content until it is approved; check again later.`);
    else problems.push(why);
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
  if (feed && feedOwner && feedTopicValue) {
    // The feed lookup also asks the network for the next index, so a node may say "not found" for
    // a few seconds after the push: poll until it names the new manifest.
    let seenAt: { reference: string; index: string } | undefined;
    for (let i = 0; i < (lagTolerant ? 24 : 40); i++) {
      seenAt = await readFeed(beeUrl, feedOwner, feedTopicValue);
      if (seenAt?.reference === ref) break;
      await sleep(1500);
    }
    if (seenAt?.reference === ref) {
      say(`Verified: the feed (index ${seenAt.index}) points at ${ref}.`);
      await check('feed manifest', `${beeUrl}/bzz/${feed.manifestRef}/`, indexBytes);
    } else {
      const why = `the feed does not point at ${ref} yet (${seenAt ? `it points at ${seenAt.reference}` : 'no readable update'})`;
      if (lagTolerant) console.warn(`Warning: ${why}.`);
      else problems.push(why);
    }
  }

  // A DNS label is at most 63 characters, so the 64-character hex reference cannot be a
  // subdomain; bzz.link takes the CID form there.
  const cid = new Reference(ref).toCid('manifest');
  say('');
  say(`bzz reference: ${ref}`);
  say(`batch: ${batchId} (owner ${account.address}, depth ${batchDepth})`);
  say(`via your Bee node: ${beeUrl}/bzz/${ref}/`);
  say(`bzz.link: https://${cid}.bzz.link/`);
  say(`bzz.link (path form): https://bzz.link/bzz/${ref}/`);
  if (feed) {
    say('');
    say(`feed owner: ${feed.owner}`);
    say(`feed topic: ${feed.topicName} (${feed.topicHex})`);
    say(`feed update: index ${feed.index} -> ${ref}`);
    say(`feed manifest reference: ${feed.manifestRef}`);
    say(`feed via your Bee node: ${beeUrl}/bzz/${feed.manifestRef}/`);
    say(`feed bzz.link: https://${new Reference(feed.manifestRef).toCid('feed')}.bzz.link/`);
    say(`feed bzz.link (path form): https://bzz.link/bzz/${feed.manifestRef}/`);
  }
  if (problems.length) fail(`verification failed:\n  ${problems.join('\n  ')}`);
}

main().catch((e: unknown) => {
  // Error messages never include the key: it is only ever handed to the signer.
  console.error(`publish-swarm: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
