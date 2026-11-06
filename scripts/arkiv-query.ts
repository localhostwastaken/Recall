// The README's runnable Arkiv query: prints the latest VERIFIED captures of one page from Arkiv
// Rabdi. Run: `pnpm arkiv:query [options]` (tsx scripts/arkiv-query.ts).
//
//   --url <url>        The captured page (default: the demo notice of the P2 live run,
//                      https://localhostwastaken.github.io/Recall/notice/?run=0tzgmo55).
//   --limit <n>        How many verified captures to print, newest first (default 5). Rows are
//                      checked newest first until that many verify; the ones that fail are
//                      counted and listed in one line each.
//   --witness <addr>   A witness address to trust for check C (repeatable; default: the Recall
//                      witness 0xC9319e18e86cd7EB653c0Ed0693c0cf5B63db37D).
//   --no-verify        Only list the latest rows; do not download and check the evidence.
//
// Exit code: 0 when at least one capture verified (or, with --no-verify, at least one row was
// found); 1 on an error; 2 when no capture of the page verified (or none exists).
//
// How it works: the URL is parsed as the extension parses the page it captures, canonicalised and
// hashed (keccak256), and `listByUrl` from @recall/net asks Rabdi for every `recall.v1.capture`
// entity whose indexed `urlHash` attribute equals it (keyset paging on $key). Anyone can write rows with our schema, so a row by itself
// proves nothing: for each one the evidence file is downloaded from Swarm by its `evidenceRef`
// (the Swarm root hash is recomputed locally, so the gateway is not trusted), checks A to C run
// on it, and the verified facts must match the row (urlHash, bodySha256, witness, signedAt).
// Only then is the row counted as "verified A-C".
//
// Reads use ARKIV_ACCESS_KEY from the environment or .env.local when there is one (sent the
// SDK's way, in the Rabdi URL path) and the public, rate-limited Rabdi endpoint otherwise. The
// key is never printed, and errors are scrubbed of it.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getAddress, isAddress, type Address } from 'viem';
import { canonicalPageUrl, decodeEvidence, runChecks, urlHash, type VerifiedFacts } from '../packages/evidence/src/index';
import {
  arkivPublic,
  downloadBytes,
  isFreeBatch,
  listByUrl,
  liveConfig,
  redactKey,
  type Listed,
} from '../packages/net/src/index';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'https://localhostwastaken.github.io/Recall/notice/?run=0tzgmo55';
const RECALL_WITNESS: Address = '0xC9319e18e86cd7EB653c0Ed0693c0cf5B63db37D';
const DOWNLOAD_TIMEOUT_MS = 30_000;

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

const accessKey = envLocal('ARKIV_ACCESS_KEY');
const safe = (text: string): string => redactKey(text, accessKey);

function fail(msg: string): never {
  console.error(`arkiv-query: ${safe(msg)}`);
  process.exit(1);
}

type Capture = Extract<Listed, { kind: 'capture' }>;

type Verdict = { verdict: string; facts?: VerifiedFacts };

/**
 * Downloads the evidence, runs A to C and compares the verified facts with the row. Only a
 * verified row comes back with `facts`: what is printed about the page comes from them.
 */
async function verify(row: Capture, pinned: Address[], downloadUrls: string[]): Promise<Verdict> {
  const no = (verdict: string): Verdict => ({ verdict: `not verified: ${verdict}` });
  let bytes: Uint8Array;
  let from: string;
  try {
    ({ bytes, from } = await downloadBytes(row.evidenceRef, downloadUrls, {
      verifyRoot: !isFreeBatch(row.batchId),
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    }));
  } catch (e) {
    return no(`evidence not downloaded (${(e as Error).message})`);
  }
  let report;
  try {
    report = await runChecks(decodeEvidence(bytes), { pinnedWitnesses: pinned });
  } catch (e) {
    return no(`the evidence file does not parse (${(e as Error).message})`);
  }
  const failed = (['A', 'B', 'C'] as const).filter((k) => report[k].status !== 'pass');
  if (failed.length > 0) return no(failed.map((k) => `${k} ${report[k].status} (${report[k].detail})`).join('; '));
  const f = report.facts!;
  const mismatch = [
    f.urlHash.toLowerCase() !== row.urlHash.toLowerCase() && 'urlHash',
    f.bodySha256.toLowerCase() !== row.bodySha256.toLowerCase() && 'bodySha256',
    getAddress(f.witness) !== getAddress(row.witness) && 'witness',
    f.signedAt !== row.signedAt && 'signedAt',
  ].filter(Boolean);
  if (mismatch.length > 0) return no(`the row does not match its evidence (${mismatch.join(', ')})`);
  return {
    verdict: `verified A-C (evidence ${bytes.length} B from ${from}, Swarm root checked: ${!isFreeBatch(row.batchId)})`,
    facts: f,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: DEFAULT_URL },
      limit: { type: 'string', default: '5' },
      witness: { type: 'string', multiple: true },
      'no-verify': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('--limit must be a whole number from 1 to 100');
  const pinned = (values.witness ?? [RECALL_WITNESS]).map((w) => {
    if (!isAddress(w, { strict: false })) fail(`not an address: ${w}`);
    return getAddress(w);
  });

  let canonical: string;
  try {
    canonical = canonicalPageUrl(values.url!);
  } catch (e) {
    fail((e as Error).message);
  }
  const hash = urlHash(canonical);
  const cfg = liveConfig(accessKey ? { ARKIV_ACCESS_KEY: accessKey } : {});
  const pub = arkivPublic(cfg);

  console.log(`Arkiv Rabdi (chain 7794095), entity type recall.v1.capture`);
  console.log(`  page     ${canonical}`);
  console.log(`  urlHash  ${hash}`);
  console.log(
    `  endpoint https://rpc.rabdi.db-chain.testnet.arkiv.network ${accessKey ? '(with ARKIV_ACCESS_KEY from the environment or .env.local; not shown)' : '(public and rate-limited: no ARKIV_ACCESS_KEY set)'}`,
  );
  console.log(`  query    select().from(recall.v1.capture).where(eq('urlHash', ${hash})).orderBy(asc('$key'))`);

  let result;
  try {
    result = await listByUrl(pub, hash);
  } catch (e) {
    fail(`the Arkiv read failed: ${(e as Error).message}`);
  }
  const captures = result.rows
    .filter((r): r is Capture => r.kind === 'capture')
    .sort((a, b) => (b.signedAt > a.signedAt ? 1 : b.signedAt < a.signedAt ? -1 : 0));
  const confirmations = result.rows.length - captures.length;
  console.log(
    `\n${captures.length} capture row(s) and ${confirmations} confirmation row(s) for this page${result.truncated ? ' (truncated: more rows exist)' : ''}.`,
  );

  const print = (n: number, row: Capture, checked?: Verdict) => {
    console.log(`\n${n}. entity ${row.entityKey}`);
    console.log(`   owner        ${row.owner}`);
    console.log(`   signer       ${row.witness}`);
    console.log(`   signedAt     ${row.signedAt} (${new Date(Number(row.signedAt) * 1000).toISOString()})`);
    // From the verified evidence when there is one; a bare row only claims these.
    if (checked?.facts) console.log(`   serverName   ${checked.facts.serverName}  HTTP ${checked.facts.httpStatus} (from the evidence)`);
    else console.log(`   serverName   ${row.serverName}  HTTP ${row.httpStatus} (as the row claims; not verified)`);
    console.log(`   bodySha256   ${row.bodySha256}`);
    console.log(`   evidenceRef  ${row.evidenceRef}`);
    console.log(`   batchId      ${row.batchId}`);
    console.log(`   expires at   block ${row.expiresAtBlock}`);
    console.log(`   open         https://bzz.link/bytes/${row.evidenceRef.replace(/^0x/, '')}`);
    if (checked) console.log(`   ${safe(checked.verdict)}`);
  };

  if (values['no-verify']) {
    console.log(`Latest ${Math.min(limit, captures.length)} (not verified: --no-verify):`);
    captures.slice(0, limit).forEach((row, i) => print(i + 1, row));
    if (captures.length === 0) process.exitCode = 2;
    return;
  }

  // Newest first, until `limit` rows verify. Anyone can write rows, so a failing row is only
  // counted (and named), never shown as a capture.
  const verified: Capture[] = [];
  const rejected: { row: Capture; why: string }[] = [];
  for (const row of captures) {
    if (verified.length >= limit) break;
    const checked = await verify(row, pinned, cfg.swarm.downloadUrls);
    if (checked.facts) {
      verified.push(row);
      print(verified.length, row, checked);
    } else {
      rejected.push({ row, why: checked.verdict });
    }
  }
  const checked = verified.length + rejected.length;
  console.log(
    `\nChecked ${checked} of ${captures.length} capture row(s): ${verified.length} verified A-C against the pinned witness(es) ${pinned.join(', ')}, ${rejected.length} rejected.`,
  );
  for (const { row, why } of rejected) console.log(`  rejected ${row.entityKey}: ${safe(why)}`);
  if (verified.length === 0) {
    console.error('arkiv-query: no capture of this page verified.');
    process.exitCode = 2;
  }
}

main().catch((e) => fail((e as Error).stack ?? String(e)));
