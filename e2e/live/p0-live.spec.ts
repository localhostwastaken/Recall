import { randomBytes } from 'node:crypto';
import { request } from 'node:https';
import { connect } from 'node:tls';
import { keccak256, stringToBytes, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { expect, test } from '@playwright/test';
import {
  arkivPublic,
  arkivWallet,
  downloadBytes,
  listByUrl,
  liveConfig,
  normalizeKey,
  uploadFree,
  writeCapture,
  type CaptureRow,
} from '../../packages/net/src/index';

const NOTICE_URL = 'https://localhostwastaken.github.io/Recall/notice/';

function env() {
  const e = process.env as Record<string, string>;
  for (const k of ['TREASURY_PRIVATE_KEY', 'ARKIV_ACCESS_KEY']) {
    if (!e[k]) throw new Error(`${k} missing: fill .env.local`);
  }
  return e;
}

test.describe('@live p0', () => {
  test('Rabdi write/read', async () => {
    const cfg = liveConfig(env());
    const account = privateKeyToAccount(normalizeKey(env().TREASURY_PRIVATE_KEY));
    console.log('treasury', account.address);
    const w = arkivWallet(cfg, http(cfg.arkiv.rpcUrl), account);
    const pub = arkivPublic(cfg);
    const urlHash = keccak256(stringToBytes(`https://notice.recall.test/p0-live?run=${Date.now()}`));
    const row: CaptureRow = {
      urlHash,
      bodySha256: `0x${'ab'.repeat(32)}` as Hex,
      serverName: 'notice.recall.test',
      witness: account.address,
      signedAt: BigInt(Math.floor(Date.now() / 1000)),
      httpStatus: 200,
      batchId: `0x${'cd'.repeat(32)}` as Hex,
      evidenceRef: `0x${'ef'.repeat(32)}` as Hex,
      canonicalUrl: 'https://notice.recall.test/p0-live',
    };
    const { entityKey, txHash } = await writeCapture(w, row);
    console.log('RABDI entityKey', entityKey, 'txHash', txHash, new Date().toISOString());
    let found = false;
    for (let i = 0; i < 60 && !found; i++) {
      const { rows } = await listByUrl(pub, urlHash);
      found = rows.some((r) => r.kind === 'capture' && r.entityKey === entityKey);
      if (!found) await new Promise((r) => setTimeout(r, 2000));
    }
    expect(found).toBe(true);
  });

  test('free upload then download from two gateways', async () => {
    const cfg = liveConfig(env());
    // Single chunk (<= 4096 B): for larger bodies the public gateway's /bytes upload builds a different
    // tree (observed: root differs from the plain ChunkSplitter root), so its ref is not locally verifiable.
    const bytes = new Uint8Array(randomBytes(3000));
    const ref = await uploadFree(bytes, cfg.swarm.uploadUrl);
    console.log('SWARM ref', ref, new Date().toISOString());
    const served: string[] = [];
    for (const url of cfg.swarm.downloadUrls) {
      let ok = false;
      for (let i = 0; i < 10 && !ok; i++) {
        try {
          const got = await downloadBytes(ref, [url]);
          expect(Buffer.from(got.bytes).equals(Buffer.from(bytes))).toBe(true);
          ok = true;
          served.push(url);
        } catch (e) {
          if (i === 9) console.log('gateway failed', url, (e as Error).message);
          else await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
    console.log('SWARM served by', served.join(', '));
    expect(served.length).toBeGreaterThanOrEqual(2);
  });

  test('gateway accepts /chunks route', async () => {
    const cfg = liveConfig(env());
    const res = await fetch(`${cfg.swarm.uploadUrl}/chunks`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'swarm-postage-stamp': '00'.repeat(113) },
      body: new Uint8Array(randomBytes(64)),
    });
    const text = await res.text();
    console.log('CHUNKS', res.status, text.slice(0, 200));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(405);
    expect(text.toLowerCase()).toMatch(/stamp|batch/);
  });

  test('Pages notice negotiates TLS 1.2', async () => {
    const u = new URL(NOTICE_URL);
    const probe = connect({ host: u.hostname, port: 443, servername: u.hostname, maxVersion: 'TLSv1.2' });
    await new Promise<void>((res, rej) => {
      probe.once('secureConnect', () => res());
      probe.once('error', rej);
    });
    expect(probe.getProtocol()).toBe('TLSv1.2');
    probe.destroy();
    const body = await new Promise<string>((res, rej) => {
      const req = request(
        { host: u.hostname, path: u.pathname, maxVersion: 'TLSv1.2', servername: u.hostname },
        (r) => {
          expect(r.statusCode).toBe(200);
          let s = '';
          r.setEncoding('utf8');
          r.on('data', (d) => (s += d));
          r.on('end', () => res(s));
        },
      );
      req.on('error', rej);
      req.end();
    });
    expect(body).toContain('15 December');
  });
});
