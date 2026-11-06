import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http, parseEther, sha256, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import {
  CAPTURE_REQUEST_HEADERS,
  CAPTURE_TYPES,
  WITNESS_DOMAIN,
  buildEvidence,
  canonicalUrl,
  encodeEvidence,
  parseResponse,
  urlHash as hashUrl,
  type EvidenceFile,
  type Statement,
} from '../../packages/evidence/src/index';
import {
  LOCAL,
  Stamper,
  arkivPublic,
  arkivWallet,
  buyBatch,
  uploadStamped,
  waitBatchUsable,
  writeCapture,
  type CaptureRow,
} from '../../packages/net/src/index';
import { BEE_COMPOSE_FAUCET_KEY, DEVNET_WITNESS_KEY, DEV_PRIVATE_KEY } from './keys';

// Everything the browse/verify specs need, built against the REAL local devnet: transcripts are
// recorded over TLS 1.2 from the notice fixture, witness-signed (EIP-712) with a key, uploaded
// to Swarm under a bought batch and indexed on Arkiv. The only thing faked is the key of the
// "witness": the public devnet witness key is used directly instead of running an MPC session.

export const NOTICE_HOST = 'notice.recall.test';
const CA = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/notice/.certs/ca.pem'),
);

export type Recording = { sent: Uint8Array; recv: Uint8Array };

/** The exact request bytes a Recall capture sends: GET, Host and the fixed headers check B pins, no cookies. */
export function requestBytes(target: string): Uint8Array {
  const fixed = Object.entries(CAPTURE_REQUEST_HEADERS).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  return new TextEncoder().encode(`GET ${target} HTTP/1.1\r\nHost: ${NOTICE_HOST}\r\n${fixed}\r\n`);
}

/** Sends the request to the notice fixture over TLS 1.2 and collects every response byte. */
export function record(target: string): Promise<Recording> {
  const sent = requestBytes(target);
  return new Promise((resolveRec, reject) => {
    const chunks: Buffer[] = [];
    const socket = tls.connect({
      host: '127.0.0.1',
      port: 443,
      servername: NOTICE_HOST,
      ca: CA,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    });
    socket.setTimeout(15_000, () => socket.destroy(new Error('notice fixture timeout')));
    socket.on('secureConnect', () => socket.write(sent));
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', reject);
    socket.on('end', () => resolveRec({ sent, recv: new Uint8Array(Buffer.concat(chunks)) }));
  });
}

/** Builds the EIP-712 statement for a recording and signs it with `key`. */
export async function signEvidence(
  rec: Recording,
  opts: { key?: Hex; capturedUrl?: string; override?: Partial<Statement> } = {},
): Promise<{ evidence: EvidenceFile; signer: Address; signedAt: bigint }> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const statement: Statement = {
    serverName: NOTICE_HOST,
    connTime: now - 2n,
    signedAt: now,
    sentSha256: sha256(rec.sent),
    recvSha256: sha256(rec.recv),
    sentLen: rec.sent.length,
    recvLen: rec.recv.length,
    tlsVersion: 12,
    nonce: `0x${randomBytes(32).toString('hex')}` as Hex,
    ...opts.override,
  };
  const account = privateKeyToAccount(opts.key ?? DEVNET_WITNESS_KEY);
  const signature = await account.signTypedData({
    domain: WITNESS_DOMAIN,
    types: CAPTURE_TYPES,
    primaryType: 'Capture',
    message: statement,
  });
  const evidence = buildEvidence({
    statement,
    signature,
    signer: account.address,
    sent: rec.sent,
    recv: rec.recv,
    capturedUrl: opts.capturedUrl,
  });
  return { evidence, signer: account.address, signedAt: statement.signedAt };
}

export type Published = {
  url: string;
  urlHash: Hex;
  body: Uint8Array;
  bodySha256: Hex;
  evidence: EvidenceFile;
  evidenceBytes: Uint8Array;
  evidenceRef: Hex;
  witness: Address;
  signedAt: bigint;
  batchId: Hex;
  row: CaptureRow;
  entityKey: Hex;
};

const eventually = async <T>(read: () => Promise<T>, what: string): Promise<T> => {
  let last: unknown;
  for (let i = 0; i < 60; i++) {
    try {
      return await read();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`${what} did not show up: ${(last as Error)?.message}`);
};

/**
 * One depth-17 batch and one Arkiv writer, shared by every capture a spec publishes
 * (one Stamper instance, so chunk slots are never reused).
 */
export class Rig {
  private constructor(
    readonly batchId: Hex,
    private readonly stamper: Stamper,
    private readonly writerKey: Hex,
  ) {}

  /**
   * `payerKey` pays for the batch (default: the bee-compose faucet) and `writerKey` writes the Arkiv
   * entities (default: a fresh key funded from DEV). A spec that runs next to others on the same
   * devnet passes its own wallet for both, so it never sends from the shared faucet or DEV keys.
   * A given `writerKey` must already hold Arkiv gas.
   */
  static async create(opts: { payerKey?: Hex; writerKey?: Hex } = {}): Promise<Rig> {
    const stampKey = generatePrivateKey();
    const gnosisTransport = http(LOCAL.gnosis.rpcUrl);
    const payer = createWalletClient({
      account: privateKeyToAccount(opts.payerKey ?? BEE_COMPOSE_FAUCET_KEY),
      chain: gnosis,
      transport: gnosisTransport,
    });
    // 10 days: comfortably more than the 7 days under which check E starts to warn.
    const { batchId } = await buyBatch(payer, {
      owner: privateKeyToAccount(stampKey).address,
      depth: 17,
      days: 10,
    });
    await waitBatchUsable(LOCAL.swarm.uploadUrl, batchId, 240_000);

    const writerKey = opts.writerKey ?? generatePrivateKey();
    if (!opts.writerKey) {
      const pub = arkivPublic(LOCAL);
      const bank = createWalletClient({
        account: privateKeyToAccount(DEV_PRIVATE_KEY),
        chain: pub.chain,
        transport: http(LOCAL.arkiv.rpcUrl),
      });
      await pub.waitForTransactionReceipt({
        hash: await bank.sendTransaction({ to: privateKeyToAccount(writerKey).address, value: parseEther('1') }),
      });
    }
    return new Rig(batchId, Stamper.fromBlank(stampKey, batchId, 17), writerKey);
  }

  /** Uploads bytes under the shared batch; returns the Swarm root reference. */
  upload(bytes: Uint8Array): Promise<Hex> {
    return uploadStamped(bytes, { uploadUrl: LOCAL.swarm.uploadUrl, stamper: this.stamper });
  }

  /** Writes a capture entity and waits until the node serves it back. */
  async write(row: CaptureRow): Promise<Hex> {
    const wallet = arkivWallet(LOCAL, http(LOCAL.arkiv.rpcUrl), privateKeyToAccount(this.writerKey));
    const { entityKey } = await writeCapture(wallet, row);
    const pub = arkivPublic(LOCAL);
    await eventually(() => pub.getEntity(entityKey), `entity ${entityKey}`);
    return entityKey;
  }

  /**
   * A real capture: records `target` (a unique `?run=` is added so every capture has its own
   * URL), signs it, uploads the evidence file and indexes a matching Arkiv entity.
   * `entity` patches the written row (for records that disagree with their evidence).
   */
  async publish(
    opts: { path?: string; witnessKey?: Hex; entity?: Partial<CaptureRow> } = {},
  ): Promise<Published> {
    const target = `${opts.path ?? '/notice'}?run=${randomBytes(6).toString('hex')}`;
    const rec = await record(target);
    const url = canonicalUrl(`https://${NOTICE_HOST}${target}`);
    const { evidence, signer, signedAt } = await signEvidence(rec, { key: opts.witnessKey, capturedUrl: url });
    const evidenceBytes = encodeEvidence(evidence);
    const evidenceRef = await this.upload(evidenceBytes);
    const body = parseResponse(rec.recv).body;
    const row: CaptureRow = {
      urlHash: hashUrl(url),
      bodySha256: sha256(body),
      serverName: NOTICE_HOST,
      witness: signer,
      signedAt,
      httpStatus: 200,
      batchId: this.batchId,
      evidenceRef,
      canonicalUrl: url,
      ...opts.entity,
    };
    const entityKey = await this.write(row);
    return {
      url,
      urlHash: hashUrl(url),
      body,
      bodySha256: sha256(body),
      evidence,
      evidenceBytes,
      evidenceRef,
      witness: signer,
      signedAt,
      batchId: this.batchId,
      row,
      entityKey,
    };
  }
}

/** Replaces one base64 character of the response transcript, so the length stays valid. */
export function tamperEvidence(e: EvidenceFile): Uint8Array {
  const recv = e.transcript.recv;
  const at = Math.floor(recv.length / 2);
  const swap = recv[at] === 'A' ? 'B' : 'A';
  const copy: EvidenceFile = {
    ...e,
    transcript: { sent: e.transcript.sent, recv: recv.slice(0, at) + swap + recv.slice(at + 1) },
  };
  return encodeEvidence(copy);
}
