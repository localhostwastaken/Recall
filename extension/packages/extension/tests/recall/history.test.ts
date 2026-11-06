import { describe, expect, it } from 'vitest';
import { sha256, toBytes, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  buildEvidence,
  CAPTURE_TYPES,
  canonicalUrl,
  encodeEvidence,
  urlHash,
  WITNESS_DOMAIN,
  type EvidenceFile,
} from '@recall/evidence';
import type { Listed } from '@recall/net/arkiv';
import {
  latestVerifiedCapture,
  summarizeHistory,
  verifiedFacts,
  type HistoryDeps,
} from '../../src/recall/history';

// Synthetic but genuinely signed evidence (no network): a GET of /notice on the fixture
// host, a 200 response with the given body, signed by a test witness key.
const WITNESS_KEY = generatePrivateKey();
const WITNESS = privateKeyToAccount(WITNESS_KEY).address;
const STRANGER_KEY = generatePrivateKey();
const HOST = 'notice.recall.test';
const URL_ = `https://${HOST}/notice`;
const HASH = urlHash(canonicalUrl(URL_));
const T0 = 1_793_800_000n;

async function evidence(body: string, signedAt: bigint, key: Hex = WITNESS_KEY, path = '/notice'): Promise<EvidenceFile> {
  const sent = toBytes(`GET ${path} HTTP/1.1\r\nHost: ${HOST}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
  const recv = toBytes(
    `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${toBytes(body).length}\r\nConnection: close\r\n\r\n${body}`,
  );
  const statement = {
    serverName: HOST,
    connTime: signedAt - 1n,
    signedAt,
    sentSha256: sha256(sent),
    recvSha256: sha256(recv),
    sentLen: sent.length,
    recvLen: recv.length,
    tlsVersion: 12,
    nonce: sha256(toBytes(`${body}${signedAt}${path}`)),
  };
  const account = privateKeyToAccount(key);
  const signature = await account.signTypedData({
    domain: WITNESS_DOMAIN,
    types: CAPTURE_TYPES,
    primaryType: 'Capture',
    message: statement,
  });
  return buildEvidence({ statement, signature, signer: account.address, sent, recv });
}

const bodyHash = (body: string) => sha256(toBytes(body));
let n = 0;
const key = (): Hex => `0x${(++n).toString(16).padStart(64, '0')}`;

/** A store of uploaded evidence plus the capture records pointing at it. */
function world() {
  const files = new Map<string, Uint8Array>();
  const rows: Listed[] = [];
  const downloads: Hex[] = [];
  const deps: HistoryDeps = {
    urlHash: HASH,
    pinned: [WITNESS],
    download: async (ref) => {
      downloads.push(ref);
      const b = files.get(ref.toLowerCase());
      if (!b) throw new Error('not found');
      return b;
    },
  };
  const capture = async (
    e: EvidenceFile,
    claims: Partial<{ urlHash: Hex; bodySha256: Hex; witness: Address; signedAt: bigint; evidenceRef: Hex }> = {},
  ): Promise<Hex> => {
    const ref = claims.evidenceRef ?? key();
    files.set(ref.toLowerCase(), encodeEvidence(e));
    const body = new TextDecoder().decode(Uint8Array.from(atob(e.transcript.recv), (c) => c.charCodeAt(0))).split('\r\n\r\n')[1];
    const entityKey = key();
    rows.push({
      kind: 'capture',
      entityKey,
      owner: WITNESS,
      expiresAtBlock: 1000n,
      urlHash: claims.urlHash ?? HASH,
      bodySha256: claims.bodySha256 ?? bodyHash(body),
      serverName: HOST,
      witness: claims.witness ?? e.signer,
      signedAt: claims.signedAt ?? BigInt(e.statement.signedAt),
      httpStatus: 200,
      batchId: key(),
      evidenceRef: ref,
      canonicalUrl: URL_,
    });
    return entityKey;
  };
  /** A record whose evidence reference leads nowhere. */
  const junk = (bodySha256: Hex, signedAt: bigint): Hex => {
    const entityKey = key();
    rows.push({
      kind: 'capture',
      entityKey,
      owner: WITNESS,
      expiresAtBlock: 1000n,
      urlHash: HASH,
      bodySha256,
      serverName: HOST,
      witness: WITNESS,
      signedAt,
      httpStatus: 200,
      batchId: key(),
      evidenceRef: key(),
      canonicalUrl: URL_,
    });
    return entityKey;
  };
  const confirmation = (captureKey: Hex, e: EvidenceFile, body: string): Hex => {
    const entityKey = key();
    rows.push({
      kind: 'confirmation',
      entityKey,
      owner: WITNESS,
      expiresAtBlock: 1000n,
      captureKey,
      urlHash: HASH,
      bodySha256: bodyHash(body),
      witness: e.signer,
      signedAt: BigInt(e.statement.signedAt),
      evidence: encodeEvidence(e),
    });
    return entityKey;
  };
  return { files, rows, deps, downloads, capture, junk, confirmation };
}

describe('earlier captures', () => {
  it('verifiedFacts needs checks A-C with a pinned witness and a record that matches its evidence', async () => {
    const e = await evidence('<p>v1</p>', T0);
    const claims = { urlHash: HASH, bodySha256: bodyHash('<p>v1</p>'), witness: WITNESS, signedAt: T0 };
    const deps = { urlHash: HASH, pinned: [WITNESS] };
    expect((await verifiedFacts(encodeEvidence(e), claims, deps))?.bodySha256).toBe(bodyHash('<p>v1</p>'));
    // An unknown witness, a changed field or another address are never verified.
    expect(await verifiedFacts(encodeEvidence(e), claims, { ...deps, pinned: [] })).toBeNull();
    expect(await verifiedFacts(encodeEvidence(e), { ...claims, signedAt: T0 + 1n }, deps)).toBeNull();
    expect(await verifiedFacts(encodeEvidence(e), { ...claims, bodySha256: bodyHash('x') }, deps)).toBeNull();
    expect(await verifiedFacts(encodeEvidence(e), claims, { ...deps, urlHash: urlHash('https://other.example/') })).toBeNull();
    // Unreadable or altered bytes.
    expect(await verifiedFacts(toBytes('not json'), claims, deps)).toBeNull();
    const recv = Uint8Array.from(atob(e.transcript.recv), (c) => c.charCodeAt(0));
    recv[recv.length - 3] ^= 1;
    const tampered = { ...e, transcript: { ...e.transcript, recv: btoa(String.fromCharCode(...recv)) } };
    expect(await verifiedFacts(encodeEvidence(tampered), claims, deps)).toBeNull();
  });

  it('latest verified capture: junk with a later claimed time is skipped, never trusted', async () => {
    const w = world();
    const v1 = await evidence('<p>v1</p>', T0);
    const k1 = await w.capture(v1);
    // Junk claiming the same body and a later time, one pointing nowhere, one at real
    // evidence of another address (R13: the record's address differs from the evidence's).
    w.junk(bodyHash('<p>v1</p>'), T0 + 500n);
    const other = await evidence('<p>v1</p>', T0 + 400n, WITNESS_KEY, '/other');
    await w.capture(other, { urlHash: HASH, bodySha256: bodyHash('<p>v1</p>'), signedAt: T0 + 400n });
    const latest = await latestVerifiedCapture(w.rows, w.deps);
    expect(latest).toEqual({ entityKey: k1, bodySha256: bodyHash('<p>v1</p>'), signedAt: T0 });
  });

  it('latest verified capture is the newest verified one, whatever its body', async () => {
    const w = world();
    await w.capture(await evidence('<p>v1</p>', T0));
    const k2 = await w.capture(await evidence('<p>v2</p>', T0 + 100n));
    expect((await latestVerifiedCapture(w.rows, w.deps))?.entityKey).toBe(k2);
    // Signed by a witness that is not pinned: ignored.
    await w.capture(await evidence('<p>v3</p>', T0 + 200n, STRANGER_KEY));
    expect((await latestVerifiedCapture(w.rows, w.deps))?.entityKey).toBe(k2);
  });

  it('latest verified capture gives up (null) after a bounded number of failed candidates', async () => {
    const w = world();
    await w.capture(await evidence('<p>v1</p>', T0));
    for (let i = 1; i <= 4; i++) w.junk(bodyHash('<p>v1</p>'), T0 + BigInt(i));
    expect(await latestVerifiedCapture(w.rows, w.deps, 3)).toBeNull();
    expect(w.downloads).toHaveLength(3);
    expect(await latestVerifiedCapture(w.rows, w.deps, 5)).not.toBeNull();
  });

  it('no candidates without a pinned witness (nothing could verify)', async () => {
    const w = world();
    await w.capture(await evidence('<p>v1</p>', T0));
    expect(await latestVerifiedCapture(w.rows, { ...w.deps, pinned: [] })).toBeNull();
    expect(w.downloads).toHaveLength(0);
  });

  it('summary counts only verified versions and confirmations', async () => {
    const w = world();
    const v1 = await evidence('<p>v1</p>', T0);
    const k1 = await w.capture(v1);
    // The same observation published twice is one version.
    await w.capture(v1);
    w.junk(bodyHash('<p>v1</p>'), T0 + 10n);
    w.confirmation(k1, await evidence('<p>v1</p>', T0 + 50n), '<p>v1</p>');
    // Not counted: a different body, dated before its capture, an unknown witness.
    w.confirmation(k1, await evidence('<p>other</p>', T0 + 60n), '<p>other</p>');
    w.confirmation(k1, await evidence('<p>v1</p>', T0 - 5n), '<p>v1</p>');
    w.confirmation(k1, await evidence('<p>v1</p>', T0 + 70n, STRANGER_KEY), '<p>v1</p>');
    await w.capture(await evidence('<p>v2</p>', T0 + 100n));
    // After the newer version: "unchanged" cannot hold across it.
    w.confirmation(k1, await evidence('<p>v1</p>', T0 + 150n), '<p>v1</p>');
    expect(await summarizeHistory(w.rows, false, w.deps)).toEqual({
      versions: 2,
      confirmations: 1,
      latest: T0 + 100n,
      incomplete: false,
    });
  });

  it('summary of nothing, and an incomplete listing is flagged', async () => {
    const w = world();
    expect(await summarizeHistory([], false, w.deps)).toEqual({ versions: 0, confirmations: 0, incomplete: false });
    await w.capture(await evidence('<p>v1</p>', T0));
    expect((await summarizeHistory(w.rows, true, w.deps)).incomplete).toBe(true);
  });
});
