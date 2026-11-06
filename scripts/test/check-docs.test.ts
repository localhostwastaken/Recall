import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARKIV_FILES, checkDocs } from '../check-docs';

// The docs check on throwaway folders: an empty one, a complete one, and complete ones with one
// thing broken. No network.

const KEY = `0x${'a1'.repeat(32)}`;
const REF = `${'b2'.repeat(32)}`;
const BATCH = `0x${'c3'.repeat(32)}`;
const OWNER = `0x${'d4'.repeat(20)}`;

const README = `# Project

## CROPS
- **C: Censorship resistance.** Nothing we run is needed to verify.
- **O: Open source.** MIT.
- **P: Privacy.** No trackers.
- **S: Security.** Keys stay on the device.

## Run it
pnpm install

## Writer wallets
- Treasury ${OWNER}
- Query: \`pnpm arkiv:query\`

## Limitations
One witness.

## AI use
<!-- placeholder -->
Some words.
`;

const SWARM = `# Swarm
- Arkiv entity key: ${KEY}
- Swarm reference: ${REF}
- Postage batch ID: ${BATCH}
- Batch owner: ${OWNER}
- Uploaded through the gateway https://api.gateway.example
`;

function folder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'check-docs-'));
  mkdirSync(join(root, 'arkiv'));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return root;
}

function complete(overrides: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = { 'README.md': README, 'arkiv/swarm.md': SWARM };
  for (const name of ARKIV_FILES) files[`arkiv/${name}.md`] ??= `# ${name}\ntext\n`;
  return { ...files, ...overrides };
}

describe('check-docs', () => {
  it('lists everything in an empty folder', () => {
    const missing = checkDocs(folder({}));
    expect(missing).toContain('README.md');
    for (const name of ARKIV_FILES) expect(missing).toContain(`arkiv/${name}.md`);
  });

  it('passes a complete folder', () => {
    expect(checkDocs(folder(complete()))).toEqual([]);
  });

  it('names a missing README section', () => {
    const missing = checkDocs(folder(complete({ 'README.md': README.replace('## Limitations', '## Caveats') })));
    expect(missing).toEqual(['README.md: section "## Limitations"']);
  });

  it('wants a CROPS line for each letter', () => {
    const missing = checkDocs(folder(complete({ 'README.md': README.replace(/- \*\*P: Privacy\.\*\* No trackers\.\n/, '') })));
    expect(missing.some((m) => m.includes('CROPS line for P'))).toBe(true);
  });

  it('wants the runnable query under Writer wallets', () => {
    const missing = checkDocs(folder(complete({ 'README.md': README.replace('`pnpm arkiv:query`', 'later') })));
    expect(missing.some((m) => m.includes('pnpm arkiv:query'))).toBe(true);
  });

  it.each([
    ['entity key', SWARM.replace(/- Arkiv entity key.*\n/, '')],
    ['Swarm reference', SWARM.replace(/- Swarm reference.*\n/, '')],
    ['batch ID', SWARM.replace(/- Postage batch ID.*\n/, '')],
    ['owns the batch', SWARM.replace(/- Batch owner.*\n/, '')],
    ['Bee node or gateway', SWARM.replace(/- Uploaded through.*\n/, '')],
  ])('wants the %s in swarm.md', (what, text) => {
    const missing = checkDocs(folder(complete({ 'arkiv/swarm.md': text })));
    expect(missing.length).toBe(1);
    expect(missing[0]).toContain(what);
  });

  it('refuses the same value given as entity key, reference and batch ID', () => {
    const text = SWARM.replace(REF, KEY.slice(2)).replace(BATCH, KEY);
    expect(checkDocs(folder(complete({ 'arkiv/swarm.md': text }))).some((m) => m.includes('three different'))).toBe(true);
  });
});
