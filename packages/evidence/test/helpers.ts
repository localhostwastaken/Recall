import fs from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { sha256, type Hex } from 'viem';
import vector from './vectors/statement-v1.json';
import { CAPTURE_TYPES, WITNESS_DOMAIN, type Statement } from '../src/statement';
import { buildEvidence, type EvidenceFile } from '../src/evidence';

export const FIXTURE_HOST = 'notice.recall.test';
const CA = fs.readFileSync(
  fileURLToPath(new URL('../../../fixtures/notice/.certs/ca.pem', import.meta.url)),
);

export type Recording = { sent: Uint8Array; recv: Uint8Array };

/** The exact request bytes a Recall capture sends (GET, identity encoding, no cookies). */
export function requestBytes(target: string, host = FIXTURE_HOST): Uint8Array {
  return new TextEncoder().encode(
    `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`,
  );
}

/** Sends `sent` to the local notice fixture over TLS 1.2 and collects every byte received. */
export function recordRaw(sent: Uint8Array): Promise<Recording> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = tls.connect({
      host: '127.0.0.1',
      port: 443,
      servername: FIXTURE_HOST,
      ca: CA,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    });
    socket.setTimeout(15_000, () => socket.destroy(new Error('fixture timeout')));
    socket.on('secureConnect', () => {
      if (socket.getProtocol() !== 'TLSv1.2') socket.destroy(new Error('not TLS 1.2'));
      else socket.write(sent);
    });
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', reject);
    socket.on('end', () => resolve({ sent, recv: new Uint8Array(Buffer.concat(chunks)) }));
  });
}

export const record = (target: string) => recordRaw(requestBytes(target));

/** Independent oracle: the body as decoded by Node's own HTTP client. */
export function nodeBody(target: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          host: '127.0.0.1',
          port: 443,
          path: target,
          servername: FIXTURE_HOST,
          ca: CA,
          headers: { Host: FIXTURE_HOST, 'Accept-Encoding': 'identity' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
          res.on('error', reject);
        },
      )
      .on('error', reject);
  });
}

export const fixtureFile = (name: string): Uint8Array =>
  new Uint8Array(
    fs.readFileSync(fileURLToPath(new URL(`../../../fixtures/notice/content/${name}`, import.meta.url))),
  );

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Hardhat #1: the public test key from the statement vector. */
export const TEST_KEY = (vector as { privateKey: Hex }).privateKey;
export const TEST_SIGNER = privateKeyToAccount(TEST_KEY).address;

export type MakeOpts = {
  key?: Hex;
  serverName?: string;
  capturedUrl?: string;
  override?: Partial<Statement>;
};

/** Builds a statement from the real recorded bytes and signs it (real crypto, no mocks). */
export async function makeEvidence(rec: Recording, opts: MakeOpts = {}): Promise<EvidenceFile> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}` as Hex;
  const statement: Statement = {
    serverName: opts.serverName ?? FIXTURE_HOST,
    connTime: now - 2n,
    signedAt: now,
    sentSha256: sha256(rec.sent),
    recvSha256: sha256(rec.recv),
    sentLen: rec.sent.length,
    recvLen: rec.recv.length,
    tlsVersion: 12,
    nonce,
    ...opts.override,
  };
  const account = privateKeyToAccount(opts.key ?? TEST_KEY);
  const signature = await account.signTypedData({
    domain: WITNESS_DOMAIN,
    types: CAPTURE_TYPES,
    primaryType: 'Capture',
    message: statement,
  });
  return buildEvidence({
    statement,
    signature,
    signer: account.address,
    sent: rec.sent,
    recv: rec.recv,
    capturedUrl: opts.capturedUrl,
  });
}
