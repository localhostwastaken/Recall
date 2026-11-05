// Generates a witness key into .env.local (WITNESS_PRIVATE_KEY). Prints only the address.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
const force = process.argv.includes('--force');
const line = /^WITNESS_PRIVATE_KEY=(.*)$/m;

const text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const existing = text.match(line)?.[1]?.trim() ?? '';
if (existing && !force) {
  console.error('WITNESS_PRIVATE_KEY is already set in .env.local; pass --force to overwrite.');
  process.exit(1);
}

const key = generatePrivateKey();
const entry = `WITNESS_PRIVATE_KEY=${key}`;
let next: string;
if (line.test(text)) next = text.replace(line, () => entry);
else next = text + (text === '' || text.endsWith('\n') ? '' : '\n') + entry + '\n';
writeFileSync(envPath, next, { mode: 0o600 });
console.log(privateKeyToAccount(key).address);
