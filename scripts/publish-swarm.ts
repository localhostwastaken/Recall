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
//   --dir <path>       Publish this folder instead of building apps/web first.
//   --no-wait          Do not wait for Bee to accept stamps of a fresh batch (public gateways
//                      do not expose /batches, so waiting on them cannot succeed).
//
// How it works. No Bee node owns the batch, so every chunk is stamped here, on the client:
// each file is split into chunks, each chunk is stamped with the batch owner's key (`Stamper`)
// and pushed with `POST /chunks`. The mantaray manifest that maps paths to files (index
// document `index.html`) is built with `MantarayNode.saveRecursively(onChunk)`, whose chunks
// take the same route. The resulting root reference is the website: `/bzz/<ref>/`.
//
// Type-checking the app is `pnpm --filter web typecheck` (CI does it); this script only runs
// `vite build`, so a half-edited source tree that still bundles can be published locally.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPublicClient, createWalletClient, formatUnits, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { BEE_COMPOSE_FAUCET_KEY } from '../e2e/fixtures/keys';
import {
  LOCAL,
  POSTAGE_STAMP,
  Stamper,
  buyBatch,
  costFor,
  liveConfig,
  normalizeKey,
  waitBatchUsable,
} from '../packages/net/src/index';
// bee-js is a dependency of packages/net only, so it is imported by its real path (the same
// module instance packages/net uses). It re-exports core-sdk's chunking and Mantaray classes.
import {
  Bee,
  ChunkSplitter,
  MantarayNode,
  NULL_ADDRESS,
  Reference,
} from '../packages/net/node_modules/@ethersphere/bee-js/dist/mjs/index.js';

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

function buildWeb(net: 'local' | 'live'): string {
  const outDir = join(WEB, 'dist');
  say(`Building apps/web for the ${net} network...`);
  const r = spawnSync('pnpm', ['--filter', 'web', 'exec', 'vite', 'build', '--emptyOutDir'], {
    cwd: ROOT,
    env: { ...process.env, VITE_RECALL_NET: net },
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

async function main() {
  const { values } = parseArgs({
    options: {
      net: { type: 'string', default: 'local' },
      bee: { type: 'string' },
      batch: { type: 'string' },
      days: { type: 'string', default: '30' },
      depth: { type: 'string', default: '18' },
      dir: { type: 'string' },
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
  const transport = http(cfg.gnosis.rpcUrl);
  const pub = createPublicClient({ chain: gnosis, transport });

  const webDir = values.dir ? resolve(values.dir) : buildWeb(net);
  if (!existsSync(join(webDir, INDEX_DOCUMENT))) fail(`${webDir} has no ${INDEX_DOCUMENT}`);
  const files = listFiles(webDir);
  say(`Site: ${files.length} files from ${relative(ROOT, webDir) || '.'}`);

  // Batch: bought here (owner = payer), or an existing one the payer owns.
  let batchId: Hex;
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
    say(`Buying a depth-${depth} batch for ${days} days: ${formatUnits(cost, 16)} xBZZ, paid by ${account.address}`);
    const wallet = createWalletClient({ account, chain: gnosis, transport });
    ({ batchId } = await buyBatch(wallet, { owner: account.address, depth, days }));
    say(`Batch ${batchId} created (owner ${account.address}).`);
  }
  if (!values['no-wait']) {
    say(`Waiting until ${beeUrl} accepts stamps of the batch (about a minute)...`);
    await waitBatchUsable(beeUrl, batchId, 10 * 60_000).catch((e: Error) => {
      fail(`${e.message}. A node that hides /batches cannot be waited on: retry with --batch ${batchId} --no-wait`);
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
    const envelope = stamper.stamp(chunk.hash().toUint8Array());
    const task = bee.chunk
      .upload(envelope, chunk.build(), { deferred: false })
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
  say(`Uploaded ${pushed} chunks (${bytesTotal} bytes of files).`);

  // Read it back through the node the way a visitor would: index document served at /bzz/<ref>/.
  const served = await fetch(`${beeUrl}/bzz/${ref}/`).catch(() => undefined);
  const want = readFileSync(join(webDir, INDEX_DOCUMENT));
  const ok = served?.ok === true && Buffer.from(await served.arrayBuffer()).equals(want);
  if (ok) say(`Verified: ${beeUrl}/bzz/${ref}/ serves ${INDEX_DOCUMENT}.`);
  else {
    const why = `${beeUrl}/bzz/${ref}/ did not serve ${INDEX_DOCUMENT} (${served ? `HTTP ${served.status}` : 'unreachable'})`;
    if (net === 'local') fail(why);
    // A public gateway may hold HTML back (moderation) or lag behind the push.
    console.warn(`Warning: ${why}. A gateway can hold HTML until it is approved; check again later.`);
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
}

main().catch((e: unknown) => {
  // Error messages never include the key: it is only ever handed to the signer.
  console.error(`publish-swarm: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
