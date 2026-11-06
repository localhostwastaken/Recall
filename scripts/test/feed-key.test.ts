import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const run = (envFile: string, ...args: string[]) =>
  promisify(execFile)('pnpm', ['exec', 'tsx', 'scripts/gen-feed-key.ts', ...args], {
    cwd: ROOT,
    env: { ...process.env, RECALL_ENV_FILE: envFile },
  });

describe('pnpm feed:keygen', () => {
  const dirs: string[] = [];
  const tmpEnv = (text?: string): string => {
    const d = mkdtempSync(join(tmpdir(), 'recall-keygen-'));
    dirs.push(d);
    const f = join(d, '.env.local');
    if (text !== undefined) writeFileSync(f, text, { mode: 0o644 });
    return f;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('writes HOSTING_FEED_KEY (mode 600), keeps the other lines and prints only the address', async () => {
    const f = tmpEnv('TREASURY_PRIVATE_KEY=0xabc\nARKIV_ACCESS_KEY=k');
    const { stdout } = await run(f);
    const text = readFileSync(f, 'utf8');
    const key = /^HOSTING_FEED_KEY=(0x[0-9a-f]{64})$/m.exec(text)?.[1];
    expect(key).toBeDefined();
    expect(text).toContain('TREASURY_PRIVATE_KEY=0xabc\nARKIV_ACCESS_KEY=k\n');
    expect(stdout.trim()).toBe(privateKeyToAccount(key as `0x${string}`).address);
    expect(stdout).not.toContain(key!.slice(2));
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('creates the file when there is none', async () => {
    const f = tmpEnv();
    await run(f);
    expect(readFileSync(f, 'utf8')).toMatch(/^HOSTING_FEED_KEY=0x[0-9a-f]{64}\n$/);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('refuses to replace a key without --force, and --force replaces it', async () => {
    const f = tmpEnv('HOSTING_FEED_KEY=0x1111111111111111111111111111111111111111111111111111111111111111\n');
    await expect(run(f)).rejects.toMatchObject({ stderr: expect.stringContaining('already set') });
    expect(readFileSync(f, 'utf8')).toContain('0x1111');
    await run(f, '--force');
    expect(readFileSync(f, 'utf8')).not.toContain('0x1111');
    expect(readFileSync(f, 'utf8')).toMatch(/^HOSTING_FEED_KEY=0x[0-9a-f]{64}\n$/);
  });
});
