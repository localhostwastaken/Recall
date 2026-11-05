import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ca = fs.readFileSync(path.join(here, '..', '.certs', 'ca.pem'));
const servername = 'notice.recall.test';

interface Resp {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  protocol: string | null;
}

// Raw HTTP/1.1 over tls so headers (chunked, encoding) are seen untouched.
function request(method: string, p: string, opts: { body?: string; acceptEncoding?: string } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    let protocol: string | null = null;
    const sock = tls.connect({ host: '127.0.0.1', port: 443, servername, ca }, () => {
      protocol = sock.getProtocol();
      const payload = opts.body ?? '';
      sock.write(
        `${method} ${p} HTTP/1.1\r\nHost: ${servername}\r\nAccept-Encoding: ${opts.acceptEncoding ?? 'gzip, br'}\r\n` +
          `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`,
      );
    });
    const chunks: Buffer[] = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('error', reject);
    sock.on('close', () => {
      const raw = Buffer.concat(chunks);
      const i = raw.indexOf('\r\n\r\n');
      const lines = raw.subarray(0, i).toString('latin1').split('\r\n');
      const headers: Record<string, string> = {};
      for (const l of lines.slice(1)) headers[l.slice(0, l.indexOf(':')).toLowerCase()] = l.slice(l.indexOf(':') + 1).trim();
      resolve({ status: Number(lines[0]!.split(' ')[1]), headers, body: raw.subarray(i + 4), protocol });
    });
  });
}

const setVersion = (v: unknown) => request('POST', '/__admin/version', { body: JSON.stringify({ v }) });

describe('notice fixture', () => {
  beforeAll(async () => {
    expect((await setVersion(1)).status).toBe(200);
  });
  afterAll(async () => {
    await setVersion(1);
  });

  it('negotiates TLSv1.2 with the test CA', async () => {
    const r = await request('GET', '/notice');
    expect(r.protocol).toBe('TLSv1.2');
    expect(r.status).toBe(200);
  });

  it('rejects a TLS1.3-only client', async () => {
    await expect(
      new Promise((resolve, reject) => {
        const s = tls.connect({ host: '127.0.0.1', port: 443, servername, ca, minVersion: 'TLSv1.3' }, () => resolve(s.getProtocol()));
        s.on('error', reject);
      }),
    ).rejects.toThrow();
  });

  it('version switch changes the notice and the pdf', async () => {
    const a = await request('GET', '/notice');
    expect(a.body.toString()).toContain('Mumbai Institute of Studies — Admissions Notice');
    expect(a.body.toString()).toContain('Deadline: 15 December');
    expect((await request('GET', '/notice.pdf')).body.toString('latin1')).toContain('Deadline: 15 December');
    expect((await setVersion(2)).status).toBe(200);
    expect((await request('GET', '/notice')).body.toString()).toContain('Deadline: 12 December');
    const p = await request('GET', '/notice.pdf');
    expect(p.headers['content-type']).toBe('application/pdf');
    expect(p.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(p.body.toString('latin1')).toContain('Deadline: 12 December');
  });

  it('rejects invalid versions with 400', async () => {
    for (const v of [3, '1', null]) expect((await setVersion(v)).status).toBe(400);
    expect((await request('POST', '/__admin/version', { body: 'nope' })).status).toBe(400);
  });

  it('/chunked uses Transfer-Encoding: chunked', async () => {
    const r = await request('GET', '/chunked');
    expect(r.headers['transfer-encoding']).toBe('chunked');
    expect(r.headers['content-length']).toBeUndefined();
  });

  it('fixed routes use Content-Length, no compression, Connection: close', async () => {
    for (const p of ['/notice', '/notice.pdf', '/big', '/script']) {
      const r = await request('GET', p, { acceptEncoding: 'gzip, deflate, br' });
      expect(r.headers['content-length'], p).toBe(String(r.body.length));
      expect(r.headers['transfer-encoding'], p).toBeUndefined();
      expect(['identity', undefined], p).toContain(r.headers['content-encoding']);
      expect(r.headers['connection'], p).toBe('close');
    }
  });

  it('/big is at least 100 KB', async () => {
    expect((await request('GET', '/big')).body.length).toBeGreaterThanOrEqual(100_000);
  });

  it('/script sets window.__ran=1', async () => {
    expect((await request('GET', '/script')).body.toString()).toMatch(/<script>[^<]*window\.__ran=1/);
  });
});
