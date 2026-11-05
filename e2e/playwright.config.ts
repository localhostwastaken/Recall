import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// The live project reads secrets from the repo-root .env.local (gitignored).
function loadEnvLocal() {
  try {
    const text = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    /* no .env.local: live specs fail loudly on missing values */
  }
}
loadEnvLocal();

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  projects: [
    { name: 'local', testMatch: /.*\.spec\.ts/, grep: /@p\d/, timeout: 60_000 },
    { name: 'live', testMatch: /live\/.*\.spec\.ts/, grep: /@live/, timeout: 180_000 },
  ],
});
