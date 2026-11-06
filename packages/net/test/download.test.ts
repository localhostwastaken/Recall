import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ATTACHMENT_MAX_DOWNLOAD_BYTES, DEFAULT_MAX_DOWNLOAD_BYTES, downloadBytes, swarmRootOf } from '../src/index';

// downloadBytes against throwaway local HTTP servers (no devnet needed): the size cap, the
// abort signal and the root-hash check that must keep working next to them.

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const refOf = async (bytes: Uint8Array) => `0x${await swarmRootOf(bytes)}`;

describe('downloadBytes limits', () => {
  it('returns bytes under the cap whose root matches (with and without a stated length)', async () => {
    const data = new Uint8Array(randomBytes(9000));
    const ref = await refOf(data);
    const sized = await serve((_q, res) => res.writeHead(200, { 'content-length': data.length }).end(Buffer.from(data)));
    const chunked = await serve((_q, res) => {
      res.writeHead(200); // no Content-Length: chunked
      res.write(Buffer.from(data.subarray(0, 4000)));
      res.end(Buffer.from(data.subarray(4000)));
    });
    for (const url of [sized, chunked]) {
      const got = await downloadBytes(ref, [url]);
      expect(Buffer.from(got.bytes).equals(Buffer.from(data))).toBe(true);
    }
  });

  it('defaults to a 2 MB cap', () => {
    expect(DEFAULT_MAX_DOWNLOAD_BYTES).toBe(2 * 1024 * 1024);
  });

  it('an attachment-sized file (over 2 MB) needs the larger cap callers pass for attachments', async () => {
    const data = new Uint8Array(randomBytes(3 * 1024 * 1024));
    const ref = await refOf(data);
    const url = await serve((_q, res) => res.writeHead(200, { 'content-length': data.length }).end(Buffer.from(data)));
    await expect(downloadBytes(ref, [url])).rejects.toThrow(/limit/);
    const got = await downloadBytes(ref, [url], { maxBytes: ATTACHMENT_MAX_DOWNLOAD_BYTES });
    expect(got.bytes.length).toBe(data.length);
    expect(got.rootVerified).toBe(true);
  });

  it('refuses a response whose stated length is over the cap, without reading it', async () => {
    let sent = 0;
    const url = await serve((_q, res) => {
      res.writeHead(200, { 'content-length': 5_000_000 });
      const timer = setInterval(() => {
        sent += 100_000;
        res.write(Buffer.alloc(100_000));
      }, 5);
      res.on('close', () => clearInterval(timer));
    });
    await expect(downloadBytes(await refOf(new Uint8Array(10)), [url], { maxBytes: 1000 })).rejects.toThrow(/limit/);
    expect(sent).toBeLessThan(5_000_000);
  });

  it('cuts off a body of unstated length once it passes the cap, and stops the gateway', async () => {
    let closed = false;
    let sent = 0;
    const url = await serve((_q, res) => {
      res.writeHead(200); // chunked, endless
      const timer = setInterval(() => {
        sent += 50_000;
        res.write(Buffer.alloc(50_000));
      }, 2);
      res.on('close', () => {
        closed = true;
        clearInterval(timer);
      });
    });
    await expect(downloadBytes(await refOf(new Uint8Array(10)), [url], { maxBytes: 120_000 })).rejects.toThrow(/over the 120000-byte limit/);
    await expect.poll(() => closed, { timeout: 2000 }).toBe(true); // the connection was cancelled, not drained
    expect(sent).toBeLessThan(2_000_000);
  });

  it('an oversized gateway is skipped and the next gateway can still answer', async () => {
    const data = new Uint8Array(randomBytes(5000));
    const big = await serve((_q, res) => res.writeHead(200, { 'content-length': 9_000_000 }).end());
    const good = await serve((_q, res) => res.writeHead(200).end(Buffer.from(data)));
    const got = await downloadBytes(await refOf(data), [big, good], { maxBytes: 100_000 });
    expect(got.from).toBe(good);
  });

  it('still rejects bytes whose root does not match, within the cap', async () => {
    const url = await serve((_q, res) => res.writeHead(200).end(Buffer.from('not the data you asked for')));
    await expect(downloadBytes(await refOf(new Uint8Array(randomBytes(500))), [url])).rejects.toThrow(/mismatch/);
  });

  it('aborting the signal stops a hanging download at once and tries no further gateway', async () => {
    let secondHit = false;
    const hang = await serve(() => undefined); // never answers
    const second = await serve((_q, res) => {
      secondHit = true;
      res.end();
    });
    const ac = new AbortController();
    const started = Date.now();
    const result = downloadBytes(await refOf(new Uint8Array(10)), [hang, second], { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(result).rejects.toThrow(/aborted/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(secondHit).toBe(false);
  });

  it('an already-aborted signal fails before any request', async () => {
    let hit = false;
    const url = await serve((_q, res) => {
      hit = true;
      res.end();
    });
    const ac = new AbortController();
    ac.abort();
    await expect(downloadBytes(await refOf(new Uint8Array(10)), [url], { signal: ac.signal })).rejects.toThrow(/aborted/);
    expect(hit).toBe(false);
  });

  it('aborting mid-body stops reading', async () => {
    let closed = false;
    const url = await serve((_q, res) => {
      res.writeHead(200);
      const timer = setInterval(() => res.write(Buffer.alloc(1000)), 5);
      res.on('close', () => {
        closed = true;
        clearInterval(timer);
      });
    });
    const ac = new AbortController();
    const result = downloadBytes(await refOf(new Uint8Array(10)), [url], { signal: ac.signal, maxBytes: 10_000_000 });
    setTimeout(() => ac.abort(), 80);
    await expect(result).rejects.toThrow(/aborted/);
    await expect.poll(() => closed, { timeout: 2000 }).toBe(true);
  });
});

describe('downloadBytes verifyRoot', () => {
  // A public gateway's /bytes can return a reference that differs from the locally computed
  // Swarm root for files over 4 KB (R13). Only free-mode captures may skip the root check.
  it('verifies the root by default, and an explicit true behaves the same', async () => {
    const url = await serve((_q, res) => res.writeHead(200).end(Buffer.from('other bytes')));
    const ref = await refOf(new Uint8Array(randomBytes(6000)));
    await expect(downloadBytes(ref, [url])).rejects.toThrow(/mismatch/);
    await expect(downloadBytes(ref, [url], { verifyRoot: true })).rejects.toThrow(/mismatch/);
    await expect(downloadBytes(ref, [url], {})).rejects.toThrow(/mismatch/);
  });

  it('verifyRoot:false returns the gateway bytes without comparing the root', async () => {
    const served = new Uint8Array(randomBytes(6000));
    const url = await serve((_q, res) => res.writeHead(200).end(Buffer.from(served)));
    const someOtherRef = await refOf(new Uint8Array(randomBytes(6000)));
    const got = await downloadBytes(someOtherRef, [url], { verifyRoot: false });
    expect(Buffer.from(got.bytes).equals(Buffer.from(served))).toBe(true);
    expect(got.from).toBe(url);
    expect(got.rootVerified).toBe(false);
  });

  it('reports rootVerified:true when the root was checked', async () => {
    const data = new Uint8Array(randomBytes(5000));
    const url = await serve((_q, res) => res.writeHead(200).end(Buffer.from(data)));
    expect((await downloadBytes(await refOf(data), [url])).rootVerified).toBe(true);
  });

  it('only a literal false skips the check (undefined, 0 and "" do not)', async () => {
    const url = await serve((_q, res) => res.writeHead(200).end(Buffer.from('other bytes')));
    const ref = await refOf(new Uint8Array(randomBytes(5000)));
    for (const v of [undefined, 0, '', null] as unknown[]) {
      await expect(downloadBytes(ref, [url], { verifyRoot: v as boolean })).rejects.toThrow(/mismatch/);
    }
  });

  it('keeps every other limit with verifyRoot:false: size cap, status, bad reference, abort', async () => {
    const big = await serve((_q, res) => res.writeHead(200, { 'content-length': 9_000_000 }).end());
    const gone = await serve((_q, res) => res.writeHead(404).end());
    const ref = await refOf(new Uint8Array(10));
    await expect(downloadBytes(ref, [big], { verifyRoot: false, maxBytes: 1000 })).rejects.toThrow(/limit/);
    await expect(downloadBytes(ref, [gone], { verifyRoot: false })).rejects.toThrow(/404/);
    await expect(downloadBytes('0x1234', [gone], { verifyRoot: false })).rejects.toThrow(/invalid swarm reference/);
    const ac = new AbortController();
    ac.abort();
    await expect(downloadBytes(ref, [gone], { verifyRoot: false, signal: ac.signal })).rejects.toThrow(/aborted/);
  });

  it('a gateway that fails is skipped and the next one answers, with the check still off', async () => {
    const data = new Uint8Array(randomBytes(300));
    const gone = await serve((_q, res) => res.writeHead(500).end());
    const good = await serve((_q, res) => res.writeHead(200).end(Buffer.from(data)));
    const got = await downloadBytes(await refOf(new Uint8Array(10)), [gone, good], { verifyRoot: false });
    expect(got.from).toBe(good);
  });
});
