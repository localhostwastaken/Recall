import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, erc20Abi, getAddress, http, parseEther, parseUnits, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { BEE_COMPOSE_FAUCET_KEY, DEV_ADDRESS, DEV_PRIVATE_KEY } from '../../e2e/fixtures/keys';
import { LOCAL, POSTAGE_STAMP, XBZZ } from '../../packages/net/src/index';
import { sendFresh } from '../fund';

// `pnpm fund` against the REAL local devnet (Arkiv dev chain :8545, Gnosis fork :9545), run as a
// child process exactly the way a person runs it. Live mode is never exercised with a key: the
// child gets no treasury key and an env file that does not exist, so even a bug in a refusal
// below could not move real funds.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const SCRIPT = join(ROOT, 'scripts/fund.ts');

type Run = { code: number; out: string; err: string };

function fund(args: string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env, RECALL_ENV_FILE: join(ROOT, 'no-such-env-file') };
  delete env.TREASURY_PRIVATE_KEY;
  delete env.ARKIV_ACCESS_KEY;
  Object.assign(env, extraEnv);
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
    // Each hash is printed when the transaction is broadcast, before the receipt is awaited.
    expect(r.out.match(/broadcast, tx 0x[0-9a-f]{64}/g)).toHaveLength(3);
    expect(r.out).not.toMatch(/warning/);
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

  it('the xBZZ token contract and the postage stamp contract', async () => {
    await refuses([XBZZ, '--net', 'local'], /contract/i);
    await refuses([POSTAGE_STAMP.toLowerCase(), '--net', 'local'], /contract/i);
  });

  it('plain numbers only: 1e3 and .5 are rejected', async () => {
    const to = freshRecipient();
    for (const bad of ['1e3', '.5', '5.', '0x10', '1,5', ' 1']) {
      await refuses([to, '--net', 'local', `--tglm=${bad}`], /amount/i);
    }
  });

  it('a funder that holds too little sends nothing at all', async () => {
    const to = freshRecipient();
    // The faucet holds far fewer than 100 million xBZZ; the other two tokens must not be sent either.
    await refuses([to, '--net', 'local', '--tglm', '0.01', '--xdai', '0.001', '--xbzz', '100000000'], /too little/i);
    expect(await balances(to)).toEqual({ tglm: 0n, xdai: 0n, xbzz: 0n });
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

  it('live cap boundaries: exactly the cap passes the cap check, one unit over fails it', async () => {
    const to = freshRecipient();
    // At the cap the run gets past the caps and stops later, on the missing live key (no key is available here).
    const atCap = async (flag: string, amount: string) => {
      const r = await fund([to, '--net', 'live', `--${flag}`, amount, '--dry-run']);
      expect(r.code).not.toBe(0);
      expect(r.err, `${flag} ${amount} should pass the cap check`).not.toMatch(/cap/i);
      expect(r.err).toMatch(/ARKIV_ACCESS_KEY is not set/);
    };
    await atCap('tglm', '2');
    await atCap('xdai', '0.02');
    await atCap('xbzz', '1');
    await atCap('xbzz', '1.0000000000000000');
    // One base unit over: 1 wei for tGLM and xDAI (18 decimals), 1e-16 for xBZZ (16 decimals).
    await refuses([to, '--net', 'live', '--tglm', '2.000000000000000001', '--dry-run'], /cap.*tGLM/i);
    await refuses([to, '--net', 'live', '--xdai', '0.020000000000000001', '--dry-run'], /cap.*xDAI/i);
    await refuses([to, '--net', 'live', '--xbzz', '1.0000000000000001', '--dry-run'], /cap.*xBZZ/i);
  });

  it('a live send without --yes (and without a terminal to ask on)', async () => {
    await refuses([freshRecipient(), '--net', 'live'], /--yes/);
  });
});

describe('secrets never reach the output', () => {
  const MARK = 'ZZMARKERZZ';

  it('a malformed treasury key and access key are not echoed (offline: it fails on the key)', async () => {
    const badKey = `0x${MARK}not-a-hex-key${MARK}`;
    const r = await fund([freshRecipient(), '--net', 'live', '--dry-run'], {
      TREASURY_PRIVATE_KEY: badKey,
      ARKIV_ACCESS_KEY: `${MARK} access/key?x=1`,
    });
    expect(r.code).not.toBe(0);
    for (const text of [r.out, r.err]) {
      expect(text).not.toContain(MARK);
      expect(text).not.toContain(encodeURIComponent(`${MARK} access/key?x=1`));
    }
    expect(r.err).toMatch(/^fund: /);
  });

  it('a valid key with an odd access key: the failure shows neither (read-only, dry run)', async () => {
    const throwaway = generatePrivateKey(); // a fresh key that holds nothing
    const access = `${MARK} access/key?x=1`;
    const r = await fund([freshRecipient(), '--net', 'live', '--dry-run'], {
      TREASURY_PRIVATE_KEY: throwaway.slice(2), // no 0x prefix, as in .env.local
      ARKIV_ACCESS_KEY: access,
    });
    // It cannot succeed: the endpoint rejects the key, or the throwaway funder holds nothing.
    expect(r.code).not.toBe(0);
    for (const text of [r.out, r.err]) {
      expect(text).not.toContain(MARK);
      expect(text).not.toContain(encodeURIComponent(access));
      expect(text).not.toContain(throwaway);
      expect(text).not.toContain(throwaway.slice(2));
    }
    expect(r.out.match(HASH)).toBeNull();
  });
});

describe('sendFresh (the nonce-race retry)', () => {
  const pub = (nonces: number[]) => {
    let i = 0;
    return { getTransactionCount: async () => nonces[Math.min(i++, nonces.length - 1)] };
  };
  const HASH1 = `0x${'11'.repeat(32)}` as const;
  const from = '0x0000000000000000000000000000000000000001';

  it('live (0 retries): one attempt only, whatever the error says', async () => {
    for (const message of [
      'nonce too low',
      'replacement transaction underpriced',
      'already known',
      'HTTP request failed. Status: 502',
    ]) {
      let calls = 0;
      await expect(
        sendFresh(pub([5, 6]), from, async () => {
          calls++;
          throw new Error(message);
        }, 0),
      ).rejects.toThrow(message);
      expect(calls, message).toBe(1);
    }
  });

  it('local: retries a lost nonce race with the next pending nonce', async () => {
    const used: number[] = [];
    const hash = await sendFresh(
      pub([5, 6]),
      from,
      async (nonce) => {
        used.push(nonce);
        if (nonce === 5) throw new Error('nonce too low: next nonce 6, tx nonce 5');
        return HASH1;
      },
      5,
    );
    expect(hash).toBe(HASH1);
    expect(used).toEqual([5, 6]);
  });

  it('local: never retries "already known" or an unrelated error', async () => {
    for (const message of ['already known', 'insufficient funds for gas']) {
      let calls = 0;
      await expect(
        sendFresh(pub([5, 6]), from, async () => {
          calls++;
          throw new Error(message);
        }, 5),
      ).rejects.toThrow(message);
      expect(calls, message).toBe(1);
    }
  });

  it('local: gives up after the retry budget', async () => {
    let calls = 0;
    await expect(
      sendFresh(pub([5]), from, async () => {
        calls++;
        throw new Error('nonce too low');
      }, 2),
    ).rejects.toThrow('nonce too low');
    expect(calls).toBe(3);
  }, 30_000);
});
