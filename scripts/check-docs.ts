// Checks that the submission docs are complete. Run: `pnpm check:docs` (tsx scripts/check-docs.ts).
// Exits 0 when everything is there, else 1 and lists each missing item.
//
// README.md must have the sections `## CROPS` (one line each for C, O, P and S), `## Run it`,
// `## Writer wallets` (with an address and `pnpm arkiv:query`), `## Limitations` and `## AI use`.
// arkiv/ must hold schema, friction, reach, why-arkiv, how-you-use-arkiv and swarm (.md), and
// arkiv/swarm.md must name a real entity key, the Swarm reference it points to, the postage batch
// ID, the wallet that owns the batch and the Bee node or gateway used for the upload.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const README_SECTIONS = ['CROPS', 'Run it', 'Writer wallets', 'Limitations', 'AI use'] as const;
export const ARKIV_FILES = ['schema', 'friction', 'reach', 'why-arkiv', 'how-you-use-arkiv', 'swarm'] as const;

const CROPS_LETTERS: [letter: string, word: RegExp][] = [
  ['C', /censorship/i],
  ['O', /open source/i],
  ['P', /priva(te|cy)/i],
  ['S', /secur(e|ity)/i],
];

const HEX32 = '0x[0-9a-fA-F]{64}';
const ADDRESS = '0x[0-9a-fA-F]{40}';

/** The body of a `## <title>` section (up to the next `## ` heading), or null when it is missing. */
export function section(markdown: string, title: string): string | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${title}`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** The first value matching `value` on a line that also matches `label`. */
function labelled(text: string, label: RegExp, value: string): string | null {
  for (const line of text.split('\n')) {
    if (!label.test(line)) continue;
    const m = new RegExp(value).exec(line);
    if (m) return m[0].toLowerCase();
  }
  return null;
}

/** Every missing item, in plain words; empty when the docs are complete. */
export function checkDocs(root: string): string[] {
  const missing: string[] = [];
  const readmePath = join(root, 'README.md');
  if (!existsSync(readmePath)) {
    missing.push('README.md');
  } else {
    const readme = readFileSync(readmePath, 'utf8');
    for (const title of README_SECTIONS) {
      const body = section(readme, title);
      if (body === null) missing.push(`README.md: section "## ${title}"`);
      else if (body.trim() === '') missing.push(`README.md: section "## ${title}" is empty`);
    }
    const crops = section(readme, 'CROPS');
    if (crops !== null) {
      for (const [letter, word] of CROPS_LETTERS) {
        const labelled = new RegExp(`(^|\\n)\\s*(?:[-*]\\s+)?(?:\\*\\*)?${letter}(?:\\*\\*)?\\s*[:.(]`).test(crops);
        if (!labelled || !word.test(crops)) missing.push(`README.md: CROPS line for ${letter} (${word.source})`);
      }
    }
    const wallets = section(readme, 'Writer wallets');
    if (wallets !== null) {
      if (!new RegExp(ADDRESS).test(wallets)) missing.push('README.md: a writer wallet address under "## Writer wallets"');
      if (!wallets.includes('pnpm arkiv:query')) missing.push('README.md: the runnable query `pnpm arkiv:query` under "## Writer wallets"');
    }
  }

  for (const name of ARKIV_FILES) {
    const p = join(root, 'arkiv', `${name}.md`);
    if (!existsSync(p)) missing.push(`arkiv/${name}.md`);
    else if (readFileSync(p, 'utf8').trim() === '') missing.push(`arkiv/${name}.md is empty`);
  }

  const swarmPath = join(root, 'arkiv', 'swarm.md');
  if (existsSync(swarmPath)) {
    const swarm = readFileSync(swarmPath, 'utf8');
    const entityKey = labelled(swarm, /entity key/i, HEX32);
    const ref = labelled(swarm, /swarm ref|reference/i, `(?<![0-9a-fA-Fx])(0x)?[0-9a-fA-F]{64}`);
    const batchId = labelled(swarm, /batch id/i, HEX32);
    if (!entityKey) missing.push('arkiv/swarm.md: an Arkiv entity key (a line with "entity key" and 0x + 64 hex)');
    if (!ref) missing.push('arkiv/swarm.md: a Swarm reference (a line with "Swarm reference" and 64 hex)');
    if (!batchId) missing.push('arkiv/swarm.md: the postage batch ID (a line with "batch ID" and 0x + 64 hex)');
    const values = [entityKey, ref?.replace(/^0x/, ''), batchId?.replace(/^0x/, '')].filter(Boolean);
    const bare = values.map((v) => v!.replace(/^0x/, ''));
    if (values.length === 3 && new Set(bare).size !== 3) {
      missing.push('arkiv/swarm.md: the entity key, Swarm reference and batch ID must be three different values');
    }
    if (!labelled(swarm, /batch owner|bought by|owner/i, ADDRESS)) {
      missing.push('arkiv/swarm.md: the wallet that owns the batch (a line with "owner" and an address)');
    }
    if (!labelled(swarm, /bee node|gateway/i, 'https?://[^\\s)`>]+')) {
      missing.push('arkiv/swarm.md: the Bee node or gateway used (a line with "Bee node" or "gateway" and a URL)');
    }
  }
  return missing;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const missing = checkDocs(root);
  if (missing.length > 0) {
    console.error(`check-docs: FAIL, ${missing.length} missing:`);
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }
  console.log(`check-docs: OK (README sections, CROPS letters, writer wallets, ${ARKIV_FILES.length} arkiv/*.md, swarm.md values)`);
}
