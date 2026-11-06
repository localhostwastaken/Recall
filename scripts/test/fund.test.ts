import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, erc20Abi, getAddress, http, parseEther, parseUnits, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { BEE_COMPOSE_FAUCET_KEY, DEV_ADDRESS, DEV_PRIVATE_KEY } from '../../e2e/fixtures/keys';
import { LOCAL, XBZZ } from '../../packages/net/src/index';

// `pnpm fund` against the REAL local devnet (Arkiv dev chain :8545, Gnosis fork :9545), run as a
// child process exactly the way a person runs it. Live mode is never exercised with a key: the
// child gets no treasury key and an env file that does not exist, so even a bug in a refusal
// below could not move real funds.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const SCRIPT = join(ROOT, 'scripts/fund.ts');

type Run = { code: number; out: string; err: string };

function fund(args: string[]): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env, RECALL_ENV_FILE: join(ROOT, 'no-such-env-file') };
  delete env.TREASURY_PRIVATE_KEY;
  delete env.ARKIV_ACCESS_KEY;
  return new Promise((done) => {
    execFile(TSX, [SCRIPT, ...args], { cwd: ROOT, env, timeout: 100_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      done({ code, out: stdout, err: stderr });
    });
  });
}

const arkiv = createPublicClient({ transport: http(LOCAL.arkiv.rpcUrl) });
const gnosis = createPublicClient({ transport: http(LOCAL.gnosis.rpcUrl) });

async function balances(a: Address) {
  return {
    tglm: await arkiv.getBalance({ address: a }),
    xdai: await gnosis.getBalance({ address: a }),
    xbzz: await gnosis.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'balanceOf', args: [a] }),
  };
}

const freshRecipient = (): Address => privateKeyToAccount(generatePrivateKey()).address;
const HASH = /0x[0-9a-f]{64}/g;

describe('pnpm fund --net local', () => {
  it('sends exactly the amounts of all three tokens to a fresh recipient', async () => {
    const to = freshRecipient();
    expect(await balances(to)).toEqual({ tglm: 0n, xdai: 0n, xbzz: 0n });

    const r = await fund([to, '--net', 'local', '--tglm', '0.01', '--xdai', '0.002', '--xbzz', '0.05']);
    expect(r.code, r.err || r.out).toBe(0);

    expect(await balances(to)).toEqual({
      tglm: parseEther('0.01'),
      xdai: parseEther('0.002'),
      xbzz: parseUnits('0.05', 16),
    });

    // Prints the recipient, the amounts and one tx hash per token, and no key material.
    expect(r.out).toContain(to);
    expect(new Set(r.out.match(HASH)).size).toBeGreaterThanOrEqual(3);
    for (const secret of [DEV_PRIVATE_KEY, BEE_COMPOSE_FAUCET_KEY]) {
      expect(r.out + r.err).not.toContain(secret);
      expect(r.out + r.err).not.toContain(secret.slice(2));
    }
  });

  it('skips a token whose amount is 0', async () => {
    const to = freshRecipient();
    const r = await fund([to, '--net', 'local', '--tglm', '0', '--xdai', '0', '--xbzz', '0.01']);
    expect(r.code, r.err || r.out).toBe(0);
    expect(await balances(to)).toEqual({ tglm: 0n, xdai: 0n, xbzz: parseUnits('0.01', 16) });
  });

  it('--dry-run prints the plan and sends nothing', async () => {
    const to = freshRecipient();
    const r = await fund([to, '--net', 'local', '--dry-run']);
    expect(r.code, r.err || r.out).toBe(0);
    expect(r.out).toContain(to);
    expect(r.out).toMatch(/dry run/i);
    expect(r.out.match(HASH)).toBeNull();
    expect(await balances(to)).toEqual({ tglm: 0n, xdai: 0n, xbzz: 0n });
  });
});

describe('pnpm fund refusals (nothing is sent)', () => {
  const refuses = async (args: string[], message: RegExp) => {
    const r = await fund(args);
    expect(r.code, `expected a refusal: ${r.out}`).not.toBe(0);
    expect(r.err).toMatch(message);
    expect(r.out.match(HASH)).toBeNull();
  };

  it('a missing, malformed or wrong-checksum address', async () => {
    await refuses([], /address/i);
    await refuses(['hello', '--net', 'local'], /address/i);
    await refuses(['0x1234', '--net', 'local'], /address/i);
    await refuses([`0x${'g'.repeat(40)}`, '--net', 'local'], /address/i);
    // A mixed-case address whose checksum is wrong: one letter of a valid one has its case flipped.
    const good = getAddress(freshRecipient()).slice(2);
    const i = good.search(/[a-fA-F]/);
    const bad = `0x${good.slice(0, i)}${/[a-f]/.test(good[i]) ? good[i].toUpperCase() : good[i].toLowerCase()}${good.slice(i + 1)}`;
    await refuses([bad, '--net', 'local'], /checksum/i);
  });

  it('the zero address and the funder itself', async () => {
    await refuses([`0x${'0'.repeat(40)}`, '--net', 'local'], /zero address/i);
    await refuses([DEV_ADDRESS, '--net', 'local'], /funder/i);
    await refuses([privateKeyToAccount(BEE_COMPOSE_FAUCET_KEY).address, '--net', 'local'], /funder/i);
  });

  it('bad amounts', async () => {
    const to = freshRecipient();
    await refuses([to, '--net', 'local', '--tglm', 'lots'], /amount/i);
    await refuses([to, '--net', 'local', '--xdai=-1'], /amount/i);
    await refuses([to, '--net', 'local', '--xbzz', '0.12345678901234567'], /decimals/i);
    await refuses([to, '--net', 'local', '--tglm', '0', '--xdai', '0', '--xbzz', '0'], /nothing to send/i);
    expect(await balances(to)).toEqual({ tglm: 0n, xdai: 0n, xbzz: 0n });
  });

  it('an unknown --net', async () => {
    await refuses([freshRecipient(), '--net', 'mainnet'], /--net/);
  });

  it('live amounts over the per-run caps', async () => {
    const to = freshRecipient();
    await refuses([to, '--net', 'live', '--tglm', '2.5', '--dry-run'], /cap.*tGLM|tGLM.*cap/i);
    await refuses([to, '--net', 'live', '--xdai', '0.03', '--dry-run'], /cap.*xDAI|xDAI.*cap/i);
    await refuses([to, '--net', 'live', '--xbzz', '1.5', '--dry-run'], /cap.*xBZZ|xBZZ.*cap/i);
    // Caps apply to live only: the same amount is fine on the devnet.
    const ok = await fund([to, '--net', 'local', '--dry-run', '--tglm', '2.5']);
    expect(ok.code, ok.err).toBe(0);
  });

  it('a live send without --yes (and without a terminal to ask on)', async () => {
    await refuses([freshRecipient(), '--net', 'live'], /--yes/);
  });
});
