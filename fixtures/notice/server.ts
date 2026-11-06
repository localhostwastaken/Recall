// TLS 1.2-only HTTPS fixture for Recall end-to-end tests. Erasable TS only
// (runs under node --experimental-strip-types).
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FIXTURE_OWNER, branchJson, buildFixtureRepos, repoJson, type FixtureRepo } from './gitRepo.ts';

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

// GitHub-like routes for the .git adapter (R46), on any fixture host (api.github.recall.test,
// codeload.github.recall.test or notice.recall.test):
//   GET /repos/recall-fixture/<demo|tampered>/branches/<b>    the branch JSON (commit + tree ids); any
//                                                             simple branch name <b> names the same commit
//   GET /repos/recall-fixture/<demo|tampered>                 { default_branch: "main" }
//   GET /recall-fixture/<demo|tampered>/tar.gz/<commit>        the codeload-style tarball
//   GET /recall-fixture/demo/tar.gz/<commit>/tampered          the demo commit with one file changed
// "tampered" names the honest tree in its JSON but serves a tarball that does not hash to it.
const git = buildFixtureRepos(path.join(here, 'content', 'repo'));
const repos: Record<string, FixtureRepo> = { [git.good.repo]: git.good, [git.tampered.repo]: git.tampered };
console.log(`git fixture: ${FIXTURE_OWNER}/${git.good.repo} commit ${git.good.commitSha} tree ${git.good.treeSha}`);

function sendWith(res: ServerResponse, type: string, body: Buffer, extra: Record<string, string>): void {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Content-Encoding': 'identity',
    'Cache-Control': 'no-store',
    Connection: 'close',
    ...extra,
  });
  res.end(body);
}

/** Serves a GitHub-like route, or returns false. */
function serveGit(req: IncomingMessage, res: ServerResponse, url: string): boolean {
  const host = (req.headers.host ?? 'api.github.recall.test').replace(/:\d+$/, '').toLowerCase();
  const api = /^\/repos\/([^/]+)\/([^/]+)(?:\/branches\/([A-Za-z0-9][A-Za-z0-9._-]{0,99}))?$/.exec(url);
  if (api && api[1] === FIXTURE_OWNER && repos[api[2]!]) {
    const r = repos[api[2]!]!;
    const body = api[3] ? branchJson(r, host, api[3]) : repoJson(r);
    sendWith(res, 'application/json; charset=utf-8', body, { 'Access-Control-Allow-Origin': '*' });
    return true;
  }
  const tgz = /^\/([^/]+)\/([^/]+)\/tar\.gz\/([0-9a-f]{40})(\/tampered)?$/.exec(url);
  if (tgz && tgz[1] === FIXTURE_OWNER && repos[tgz[2]!] && repos[tgz[2]!]!.commitSha === tgz[3]) {
    const r = repos[tgz[2]!]!;
    const body = tgz[4] ? (r === git.good ? git.tamperedTarGzOfGood : r.tarGz) : r.tarGz;
    sendWith(res, 'application/x-gzip', body, {
      'Content-Disposition': `attachment; filename=${r.repo}-${r.commitSha}.tar.gz`,
    });
    return true;
  }
  return false;
}

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
    if (serveGit(req, res, url)) return;
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
