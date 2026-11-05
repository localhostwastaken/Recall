// TLS 1.2-only HTTPS fixture for Recall end-to-end tests. Erasable TS only
// (runs under node --experimental-strip-types).
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

const here = path.dirname(fileURLToPath(import.meta.url));
const certDir = process.env.CERT_DIR ?? path.join(here, '.certs');
const port = Number(process.env.PORT ?? 443);

const content = (name: string): Buffer => fs.readFileSync(path.join(here, 'content', name));
const html: Record<number, Buffer> = { 1: content('v1.html'), 2: content('v2.html') };
const pdf: Record<number, Buffer> = { 1: content('v1.pdf'), 2: content('v2.pdf') };
let version = 1;

const big = (() => {
  const row = '<p>Mumbai Institute of Studies — Admissions Notice. Filler paragraph for the large-page capture test.</p>\n';
  let body = '<!doctype html>\n<html><head><meta charset="utf-8"><title>Big</title></head><body>\n';
  while (Buffer.byteLength(body) < 100_500) body += row;
  return Buffer.from(body + '</body></html>\n');
})();

const script = Buffer.from(
  '<!doctype html>\n<html><head><meta charset="utf-8"><title>Script</title></head>' +
    '<body><p>script page</p><script>window.__ran=1</script></body></html>\n',
);

function send(res: ServerResponse, status: number, type: string, body: Buffer): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Content-Encoding': 'identity',
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 4096) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = https.createServer(
  {
    key: fs.readFileSync(path.join(certDir, 'server.key')),
    cert: fs.readFileSync(path.join(certDir, 'server.pem')),
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
  },
  async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const H = 'text/html; charset=utf-8';
    if (req.method === 'POST' && url === '/__admin/version') {
      let v: unknown;
      try {
        v = (JSON.parse(await readBody(req)) as { v?: unknown }).v;
      } catch {
        v = undefined;
      }
      if (v !== 1 && v !== 2) return send(res, 400, 'text/plain', Buffer.from('v must be 1 or 2\n'));
      version = v;
      return send(res, 200, 'application/json', Buffer.from(JSON.stringify({ v }) + '\n'));
    }
    if (req.method !== 'GET') return send(res, 405, 'text/plain', Buffer.from('method not allowed\n'));
    switch (url) {
      case '/notice':
        return send(res, 200, H, html[version]);
      case '/notice.pdf':
        return send(res, 200, 'application/pdf', pdf[version]);
      case '/big':
        return send(res, 200, H, big);
      case '/script':
        return send(res, 200, H, script);
      case '/chunked': {
        res.writeHead(200, {
          'Content-Type': H,
          'Transfer-Encoding': 'chunked',
          'Cache-Control': 'no-store',
          Connection: 'close',
        });
        res.write('<!doctype html><html><body><h1>Mumbai Institute of Studies — Admissions Notice</h1>');
        res.write('<p>chunked response</p></body></html>');
        return res.end();
      }
      default:
        return send(res, 404, 'text/plain', Buffer.from('not found\n'));
    }
  },
);

server.listen(port, () => console.log(`notice fixture listening on :${port} (TLSv1.2 only)`));
