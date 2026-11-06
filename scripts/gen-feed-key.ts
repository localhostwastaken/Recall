// Generates the hosting feed key into .env.local (HOSTING_FEED_KEY, mode 600). Prints only the
// address. `pnpm publish:swarm --feed` signs the site's feed with this key; whoever holds it can
// repoint the feed's permanent address, so keep it apart from the treasury key. RECALL_ENV_FILE
// points the script at another file (the tests use it).
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const envPath = process.env.RECALL_ENV_FILE ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
const force = process.argv.includes('--force');
// `HOSTING_FEED_KEY=...`, also written `export HOSTING_FEED_KEY=...` or indented.
const line = /^[ \t]*(?:export[ \t]+)?HOSTING_FEED_KEY=(.*)$/m;

const text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const existing = text.match(line)?.[1]?.trim() ?? '';
if (existing && !force) {
  console.error('HOSTING_FEED_KEY is already set in .env.local; pass --force to overwrite (the feed address changes with the key).');
  process.exit(1);
}

const key = generatePrivateKey();
const entry = `HOSTING_FEED_KEY=${key}`;
let next: string;
if (line.test(text)) next = text.replace(line, () => entry);
else next = text + (text === '' || text.endsWith('\n') ? '' : '\n') + entry + '\n';
// Written next to the target and renamed over it: a crash can never leave a half-written .env.local
// (it holds the treasury key too). The temporary file is created 0600, so is the result.
const tmp = `${envPath}.${process.pid}.tmp`;
writeFileSync(tmp, next, { mode: 0o600 });
chmodSync(tmp, 0o600);
renameSync(tmp, envPath);
console.log(privateKeyToAccount(key).address);
