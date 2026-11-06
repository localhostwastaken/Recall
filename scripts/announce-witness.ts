// Announces where the witness can be reached: writes a `recall.v1.witness` profile entity on
// Arkiv, signed BY the witness key. The extension trusts only profiles created by its pinned
// witness, takes the newest one's URL, and falls back to the URL in its settings. Run again
// whenever the URL changes (a quick tunnel gets a new URL on every restart).
// Run: `pnpm witness:announce [options]` (tsx scripts/announce-witness.ts).
//
//   --net local|live   Where to announce (default local):
//                        local = the devnet Arkiv node (:8545), with the devnet witness's public
//                                test key (DEVNET_WITNESS_KEY), topped up from the dev account;
//                        live  = Arkiv Rabdi, with WITNESS_PRIVATE_KEY and ARKIV_ACCESS_KEY from
//                                .env.local, topped up from TREASURY_PRIVATE_KEY (keys never printed).
//   --url <url>        The URL to announce (default: local http://localhost:7047; live
//                      WITNESS_PUBLIC_URL from .env.local, which scripts/tunnel.sh writes).
//   --skip-check       Announce even if `GET <url>/info` does not answer as this witness.
//   --dry-run          Print the plan (addresses, balance, URL check) and send nothing.
//
// Fees: if the witness address holds less than 0.01 of the chain's coin (tGLM on Rabdi), it is
// first topped up with 0.05 from the funding key. Prints only addresses, amounts and tx hashes.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { formatEther, http, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DEV_PRIVATE_KEY, DEVNET_WITNESS_KEY } from '../e2e/fixtures/keys';
import {
  LOCAL,
  arkivPublic,
  arkivWallet,
  latestWitnessUrl,
  liveConfig,
  normalizeKey,
  writeWitnessProfile,
  type NetConfig,
} from '../packages/net/src/index';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_BALANCE = parseEther('0.01');
const TOP_UP = parseEther('0.05');
/** The witness profile's url is stored as a short string (the schema's str() limit). */
const MAX_URL_BYTES = 128;

function fail(msg: string): never {
  console.error(`announce-witness: ${msg}`);
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

function checkUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    fail(`not a URL: ${raw}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') fail('the URL must be http(s)');
  if (u.username || u.password) fail('the URL must not carry a user name or password');
  const url = raw.replace(/\/+$/, '');
  if (new TextEncoder().encode(url).length > MAX_URL_BYTES) fail(`the URL is longer than ${MAX_URL_BYTES} bytes`);
  return url;
}

/** Whether `GET <url>/info` answers 200 with this witness as signer. */
async function answersAs(url: string, witness: Address): Promise<string | null> {
  try {
    const res = await fetch(`${url}/info`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return `GET ${url}/info answered ${res.status}`;
    const signer = ((await res.json()) as { signer?: unknown }).signer;
    if (typeof signer !== 'string' || signer.toLowerCase() !== witness.toLowerCase()) {
      return `GET ${url}/info answered for signer ${String(signer)}, not ${witness}`;
    }
    return null;
  } catch (err) {
    return `GET ${url}/info failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Retries a send that raced another sender on the same key (shared devnet dev account). */
async function retrying<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 3 || !/nonce|underpriced|already known/i.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      net: { type: 'string', default: 'local' },
      url: { type: 'string' },
      'skip-check': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const net = values.net;
  if (net !== 'local' && net !== 'live') fail('--net must be local or live');

  let cfg: NetConfig;
  let witnessKey: Hex;
  let funderKey: Hex;
  let rawUrl: string | undefined = values.url;
  if (net === 'local') {
    cfg = LOCAL;
    witnessKey = DEVNET_WITNESS_KEY;
    funderKey = DEV_PRIVATE_KEY;
    rawUrl ??= 'http://localhost:7047';
  } else {
    const access = envLocal('ARKIV_ACCESS_KEY');
    if (!access) fail('ARKIV_ACCESS_KEY is not set (put it in .env.local)');
    cfg = liveConfig({ ARKIV_ACCESS_KEY: access });
    const w = envLocal('WITNESS_PRIVATE_KEY');
    if (!w) fail('WITNESS_PRIVATE_KEY is not set (put it in .env.local)');
    witnessKey = normalizeKey(w);
    const t = envLocal('TREASURY_PRIVATE_KEY');
    if (!t) fail('TREASURY_PRIVATE_KEY is not set (put it in .env.local)');
    funderKey = normalizeKey(t);
    rawUrl ??= envLocal('WITNESS_PUBLIC_URL');
    if (!rawUrl) fail('no URL: pass --url or set WITNESS_PUBLIC_URL (scripts/tunnel.sh writes it)');
  }
  const url = checkUrl(rawUrl);
  const witness = privateKeyToAccount(witnessKey);
  const funder = privateKeyToAccount(funderKey);
  // Live: the default transport uses the chain's RPC URL, which carries the access key.
  const transport = net === 'live' ? http() : http(cfg.arkiv.rpcUrl);
  const pub = arkivPublic(cfg);

  console.log(`net       ${net} (Arkiv ${cfg.arkiv.chain})`);
  console.log(`witness   ${witness.address}`);
  console.log(`url       ${url}`);
  const problem = await answersAs(url, witness.address);
  console.log(`check     ${problem ?? `GET ${url}/info answers as this witness`}`);
  if (problem && !values['skip-check']) fail(`${problem}. Start the witness (or pass --skip-check).`);

  const current = await latestWitnessUrl(pub, witness.address).catch(() => null);
  console.log(`announced ${current ?? '(none yet)'}`);

  const balance = await pub.getBalance({ address: witness.address });
  console.log(`balance   ${formatEther(balance)}`);
  const needsTopUp = balance < MIN_BALANCE;
  if (values['dry-run']) {
    if (needsTopUp) console.log(`plan      top up ${formatEther(TOP_UP)} from ${funder.address}`);
    console.log(`plan      write a recall.v1.witness profile for ${url}`);
    console.log('dry run: nothing sent');
    return;
  }

  if (needsTopUp) {
    const payer = arkivWallet(cfg, transport, funder);
    const funds = await pub.getBalance({ address: funder.address });
    if (funds < TOP_UP) fail(`the funding address ${funder.address} holds only ${formatEther(funds)}`);
    const hash = await retrying(() => payer.sendTransaction({ to: witness.address, value: TOP_UP }));
    await pub.waitForTransactionReceipt({ hash });
    console.log(`top-up    ${formatEther(TOP_UP)} from ${funder.address}, tx ${hash}`);
  }

  const w = arkivWallet(cfg, transport, witness);
  const { entityKey, txHash } = await retrying(() => writeWitnessProfile(w, { witness: witness.address, url }));
  console.log(`profile   entity ${entityKey}, tx ${txHash}`);
  const now = await latestWitnessUrl(pub, witness.address);
  if (now !== url) fail(`the newest profile reads back as ${now ?? '(none)'}, not ${url}`);
  console.log('done: the extension will find this URL');
}

main().catch((err) => fail(err instanceof Error ? err.message.split('\n')[0] : String(err)));
