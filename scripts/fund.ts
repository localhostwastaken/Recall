// Funds a teammate so they can capture and publish: tGLM for the Arkiv write (Rabdi testnet),
// xDAI for gas and xBZZ for the Swarm storage batch (both on Gnosis).
// Run: `pnpm fund <address> [options]` (tsx scripts/fund.ts).
//
//   --net live|local   live (default) = Arkiv Rabdi + Gnosis mainnet, sent from TREASURY_PRIVATE_KEY
//                      in .env.local; local = the devnet (Arkiv dev chain :8545, Gnosis fork :9545),
//                      sent from the public devnet keys (DEV_PRIVATE_KEY, BEE_COMPOSE_FAUCET_KEY).
//   --tglm <n>         tGLM to send (default 0.2; live cap 2)
//   --xdai <n>         xDAI to send (default 0.003; live cap 0.02)
//   --xbzz <n>         xBZZ to send (default 0.4; live cap 1). One 7-day depth-17 batch costs ~0.32 xBZZ.
//   --dry-run          Print the plan and the balances, send nothing.
//   --yes              Skip the y/N question (a live send needs this when there is no terminal).
//
// A token whose amount is 0 is skipped. Prints only addresses, amounts and tx hashes (with
// explorer links); a private key is never printed, and an error shows only its first line.
// Each hash is printed as soon as the transaction is broadcast, before the receipt is awaited.
// Live sends are NEVER retried: a retry after a gateway error could pay twice. Only the shared
// local devnet keys retry, on a lost nonce race.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  parseUnits,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { BEE_COMPOSE_FAUCET_KEY, DEV_PRIVATE_KEY } from '../e2e/fixtures/keys';
import { LOCAL, POSTAGE_STAMP, XBZZ, arkivPublic, arkivRpcUrl, liveConfig, normalizeKey, type NetConfig } from '../packages/net/src/index';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const XBZZ_DECIMALS = 16;
const DEFAULTS = { tglm: '0.2', xdai: '0.003', xbzz: '0.4' } as const;
/** Hard caps per run on live (a mistyped amount must not drain the treasury). */
const CAPS = { tglm: '2', xdai: '0.02', xbzz: '1' } as const;
/** Gas the xDAI send and the xBZZ transfer use at most on Gnosis (with room), for the balance check. */
const GNOSIS_GAS = 21_000n + 120_000n;
/** Local devnet only: how many times a send may be retried after losing a nonce race. */
const LOCAL_RETRIES = 5;
/**
 * A lost nonce race on a shared devnet key. "already known" is deliberately NOT here: it means
 * the node holds this very transaction, so signing another one would pay twice.
 */
const NONCE_RACE = /nonce too low|nonce has already been used|replacement transaction underpriced|nonce.*(too low|lower than)/i;

/** Everything that must never reach the output: loaded private keys and the Arkiv access key. */
const secrets: string[] = [];
function redact(text: string): string {
  return secrets.reduce((t, s) => (s ? t.split(s).join('***') : t), text);
}
function keep<T extends string>(secret: T): T {
  // The key as typed, without 0x, and as it appears inside a URL (percent-encoded).
  secrets.push(secret, secret.replace(/^0x/i, ''), encodeURIComponent(secret));
  return secret;
}

/** Transfers already broadcast in this run, repeated when a later step fails. */
const sent: string[] = [];

function fail(msg: string): never {
  console.error(`fund: ${redact(msg)}`);
  if (sent.length) {
    console.error(`fund: already broadcast before this error: ${redact(sent.join('; '))}. Check the recipient's balances before running again.`);
  }
  process.exit(1);
}

/** Reads one variable from the repo-root .env.local (gitignored); the process env wins. */
function envLocal(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const text = readFileSync(process.env.RECALL_ENV_FILE ?? join(ROOT, '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && m[1] === name) return m[2].replace(/^(['"])(.*)\1$/, '$2') || undefined;
    }
  } catch {
    /* no env file */
  }
  return undefined;
}

type Token = 'tglm' | 'xdai' | 'xbzz';
const SYMBOL: Record<Token, string> = { tglm: 'tGLM', xdai: 'xDAI', xbzz: 'xBZZ' };
const DECIMALS: Record<Token, number> = { tglm: 18, xdai: 18, xbzz: XBZZ_DECIMALS };

/** A plain non-negative decimal number, in the token's base units. */
function parseAmount(token: Token, text: string): bigint {
  const flag = `--${token}`;
  if (!/^\d+(\.\d+)?$/.test(text)) fail(`bad amount for ${flag}: "${text}" (use a plain number such as 0.2)`);
  const fraction = text.split('.')[1] ?? '';
  if (fraction.length > DECIMALS[token]) fail(`${flag} has more than ${DECIMALS[token]} decimals`);
  return parseUnits(text, DECIMALS[token]);
}

/** Checksummed, or all lower-case. Returns the checksummed form. */
function parseRecipient(raw: string | undefined): Address {
  if (!raw) fail('usage: pnpm fund <address> [--net live|local] [--tglm n] [--xdai n] [--xbzz n] [--dry-run] [--yes]; the address is missing');
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) fail('that is not an address (expected 0x and 40 hex characters)');
  const checksummed = getAddress(raw);
  if (raw !== raw.toLowerCase() && raw !== checksummed) fail('the address checksum is wrong (copy it again, or use all lower-case)');
  if (checksummed === zeroAddress) fail('refusing the zero address');
  return checksummed;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorText = (e: unknown): string =>
  e instanceof Error ? `${e.message} ${(e as { details?: string }).details ?? ''} ${(e.cause as Error | undefined)?.message ?? ''}` : String(e);

/**
 * Sends with the funder's current pending nonce. With `retries` > 0 (local devnet only) it signs
 * again with a fresh nonce when another sender on the same key wins that nonce. On live
 * `retries` is 0: one broadcast, no second attempt whatever the error says.
 */
export async function sendFresh(
  pub: Pick<PublicClient, 'getTransactionCount'>,
  from: Address,
  send: (nonce: number) => Promise<Hex>,
  retries: number,
): Promise<Hex> {
  for (let attempt = 0; ; attempt++) {
    const nonce = await pub.getTransactionCount({ address: from, blockTag: 'pending' });
    try {
      return await send(nonce);
    } catch (e) {
      if (attempt >= retries || !NONCE_RACE.test(errorText(e))) throw e;
      await sleep(250 * 2 ** attempt + Math.random() * 250);
    }
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

type Side = { label: 'Arkiv' | 'Gnosis'; chain: Chain; transport: Transport; pub: PublicClient; explorer?: string };

function side(label: Side['label'], chain: Chain, transport: Transport, explorer?: string): Side {
  return { label, chain, transport, pub: createPublicClient({ chain, transport }) as PublicClient, explorer };
}

/** Runs one RPC step and names the chain in its error (first line only, never the URL). */
async function at<T>(s: Side, what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new Error(`${s.label} ${what} failed: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
  }
}

async function main() {
  let values: ReturnType<typeof parseArgs>['values'];
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        net: { type: 'string', default: 'live' },
        tglm: { type: 'string', default: DEFAULTS.tglm },
        xdai: { type: 'string', default: DEFAULTS.xdai },
        xbzz: { type: 'string', default: DEFAULTS.xbzz },
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
      },
    }));
  } catch (e) {
    fail(`bad arguments: ${errorText(e).trim()}`);
  }
  const net = values.net;
  if (net !== 'local' && net !== 'live') fail('--net must be live or local');
  const live = net === 'live';
  const dryRun = values['dry-run'] === true;
  const yes = values.yes === true;
  if (positionals.length > 1) fail(`expected one address, got ${positionals.length}`);
  const to = parseRecipient(positionals[0]);

  const amounts = {
    tglm: parseAmount('tglm', String(values.tglm)),
    xdai: parseAmount('xdai', String(values.xdai)),
    xbzz: parseAmount('xbzz', String(values.xbzz)),
  };
  const tokens = (Object.keys(amounts) as Token[]).filter((t) => amounts[t] > 0n);
  if (tokens.length === 0) fail('nothing to send: every amount is 0');
  if (live) {
    for (const t of tokens) {
      if (amounts[t] > parseUnits(CAPS[t], DECIMALS[t])) {
        fail(`--${t} ${formatUnits(amounts[t], DECIMALS[t])} is over the live cap of ${CAPS[t]} ${SYMBOL[t]} per run`);
      }
    }
    // Decide this before any key or network is touched.
    if (!dryRun && !yes && !process.stdin.isTTY) fail('a live send needs --yes (there is no terminal to ask on)');
  }

  // Who pays what, and where.
  let cfg: NetConfig;
  let tglmFunder: PrivateKeyAccount;
  let xdaiFunder: PrivateKeyAccount;
  let xbzzFunder: PrivateKeyAccount;
  let arkiv: Side;
  if (live) {
    const access = envLocal('ARKIV_ACCESS_KEY');
    if (!access) fail('ARKIV_ACCESS_KEY is not set (put it in .env.local)');
    keep(access);
    const key = envLocal('TREASURY_PRIVATE_KEY');
    if (!key) fail('TREASURY_PRIVATE_KEY is not set (put it in .env.local)');
    const treasury = privateKeyToAccount(keep(normalizeKey(key)));
    tglmFunder = xdaiFunder = xbzzFunder = treasury;
    cfg = liveConfig({ ARKIV_ACCESS_KEY: access });
    // The chain's own RPC URL carries the access key; it is never printed.
    const chain = arkivPublic(cfg).chain as Chain;
    arkiv = side('Arkiv', chain, http(), chain.blockExplorers?.default.url);
  } else {
    cfg = LOCAL;
    tglmFunder = xdaiFunder = privateKeyToAccount(DEV_PRIVATE_KEY);
    xbzzFunder = privateKeyToAccount(BEE_COMPOSE_FAUCET_KEY);
    arkiv = side('Arkiv', arkivPublic(cfg).chain as Chain, http(arkivRpcUrl(cfg)));
  }
  const gnosisChain: Chain = { ...gnosis, rpcUrls: { default: { http: [cfg.gnosis.rpcUrl] } } };
  const chainGnosis = side('Gnosis', gnosisChain, http(cfg.gnosis.rpcUrl), live ? 'https://gnosisscan.io' : undefined);

  const funders = new Set([tglmFunder, xdaiFunder, xbzzFunder].map((a) => a.address));
  if (funders.has(to)) fail("the recipient is one of the funder's own addresses");
  if (to === XBZZ || to === POSTAGE_STAMP) fail('the recipient is a token or postage contract, which would lock the funds');
  const sides: Record<Token, Side> = { tglm: arkiv, xdai: chainGnosis, xbzz: chainGnosis };
  const funderOf: Record<Token, PrivateKeyAccount> = { tglm: tglmFunder, xdai: xdaiFunder, xbzz: xbzzFunder };

  const balanceOf = (token: Token, owner: Address): Promise<bigint> =>
    token === 'xbzz'
      ? at(chainGnosis, 'balance read', () =>
          chainGnosis.pub.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }) as Promise<bigint>,
        )
      : at(sides[token], 'balance read', () => sides[token].pub.getBalance({ address: owner }));
  const show = (token: Token, v: bigint) => `${formatUnits(v, DECIMALS[token])} ${SYMBOL[token]}`;
  const holdings = async (owner: Address, which: Token[]): Promise<Record<string, bigint>> =>
    Object.fromEntries(await Promise.all(which.map(async (t) => [t, await balanceOf(t, owner)] as const)));
  const list = (h: Record<string, bigint>) => (Object.keys(h) as Token[]).map((t) => show(t, h[t])).join(', ');

  console.log(`net        ${net} (Arkiv ${cfg.arkiv.chain}, Gnosis ${gnosisChain.id})`);
  console.log(`recipient  ${to}`);
  console.log(`send       ${tokens.map((t) => show(t, amounts[t])).join(', ')}`);
  for (const f of [...funders]) {
    const own = tokens.filter((t) => funderOf[t].address === f);
    if (own.length) console.log(`funder     ${f} holds ${list(await holdings(f, own))}`);
  }
  const before = await holdings(to, tokens);
  console.log(`before     ${list(before)}`);

  // Each funder must hold what it sends plus the gas of its sends (priced at double the current rate).
  const arkivGas = (await at(arkiv, 'gas price read', () => arkiv.pub.getGasPrice())) * 21_000n * 2n;
  const gnosisGas = (await at(chainGnosis, 'gas price read', () => chainGnosis.pub.getGasPrice())) * GNOSIS_GAS * 2n;
  for (const f of funders) {
    const sends = (t: Token) => tokens.includes(t) && funderOf[t].address === f;
    const wants: { token: Token; have: bigint; want: bigint }[] = [];
    if (sends('tglm')) wants.push({ token: 'tglm', have: await balanceOf('tglm', f), want: amounts.tglm + arkivGas });
    if (sends('xdai') || sends('xbzz')) {
      wants.push({ token: 'xdai', have: await balanceOf('xdai', f), want: (sends('xdai') ? amounts.xdai : 0n) + gnosisGas });
    }
    if (sends('xbzz')) wants.push({ token: 'xbzz', have: await balanceOf('xbzz', f), want: amounts.xbzz });
    for (const { token, have, want } of wants) {
      if (have < want) fail(`the funder ${f} holds ${show(token, have)}, too little for ${show(token, want)} (the amount plus gas)`);
    }
  }

  if (dryRun) {
    console.log('dry run: nothing sent');
    return;
  }
  if (live && !yes) {
    if (!(await confirm(`Send these to ${to} on the live networks? [y/N] `))) fail('cancelled, nothing sent');
  }

  const retries = live ? 0 : LOCAL_RETRIES;
  for (const t of tokens) {
    const s = sides[t];
    const account = funderOf[t];
    const wallet = createWalletClient({ account, chain: s.chain, transport: s.transport });
    let hash: Hex;
    try {
      hash = await at(s, 'send', () =>
        sendFresh(
          s.pub,
          account.address,
          (nonce) =>
            t === 'xbzz'
              ? wallet.writeContract({ address: XBZZ, abi: erc20Abi, functionName: 'transfer', args: [to, amounts.xbzz], nonce })
              : wallet.sendTransaction({ to, value: amounts[t], nonce }),
          retries,
        ),
      );
    } catch (e) {
      // The node may have taken the transaction before the error came back; never guess.
      fail(`${(e as Error).message}. The ${SYMBOL[t]} transfer may or may not have gone out: check ${account.address} and the recipient before running again.`);
    }
    // Print the hash now, so a later failure (or a lost receipt) leaves a record.
    const link = s.explorer ? ` ${s.explorer}/tx/${hash}` : '';
    console.log(`${SYMBOL[t].padEnd(10)} ${formatUnits(amounts[t], DECIMALS[t])} broadcast, tx ${hash}${link}`);
    sent.push(`${SYMBOL[t]} ${formatUnits(amounts[t], DECIMALS[t])} tx ${hash}`);
    const receipt = await at(s, `wait for the receipt of ${hash}`, () => s.pub.waitForTransactionReceipt({ hash, pollingInterval: 1_000 }));
    if (receipt.status !== 'success') fail(`the ${SYMBOL[t]} transfer ${hash} reverted`);
    console.log(`${SYMBOL[t].padEnd(10)} confirmed in block ${receipt.blockNumber}`);
  }
  const after = await holdings(to, tokens);
  console.log(`after      ${list(after)}`);
  for (const t of tokens) {
    if (after[t] - before[t] !== amounts[t]) {
      console.log(
        `warning    ${SYMBOL[t]} rose by ${formatUnits(after[t] - before[t], DECIMALS[t])}, expected ${formatUnits(amounts[t], DECIMALS[t])} (a lagging RPC, or another transfer to this address); check the explorer`,
      );
    }
  }
}

/** True when run as `tsx scripts/fund.ts`; false when a test imports `sendFresh`. */
const isMain = process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  main().catch((err) => fail(err instanceof Error ? err.message.split('\n')[0] : String(err).split('\n')[0]));
}
