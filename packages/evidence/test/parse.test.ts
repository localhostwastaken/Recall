import { beforeAll, describe, expect, it } from 'vitest';
import { keccak256, sha256, toBytes } from 'viem';
import { parseRequest, parseResponse } from '../src/http';
import { canonicalUrl, urlHash } from '../src/url';
import { decodeEvidence, encodeEvidence } from '../src/evidence';
import {
  bytesEqual,
  fixtureFile,
  makeEvidence,
  nodeBody,
  record,
  requestBytes,
  type Recording,
} from './helpers';

const enc = new TextEncoder();
const dec = new TextDecoder();
const req = (requestLine: string, headers = 'Host: notice.recall.test\r\n') =>
  enc.encode(`${requestLine}\r\n${headers}\r\n`);

let notice: Recording;
let chunked: Recording;
let big: Recording;
let pdf: Recording;

beforeAll(async () => {
  [notice, chunked, big, pdf] = await Promise.all([
    record('/notice'),
    record('/chunked'),
    record('/big'),
    record('/notice.pdf'),
  ]);
});

describe('parseRequest', () => {
  it('parses the real fixture request', () => {
    const r = parseRequest(notice.sent);
    expect(r.method).toBe('GET');
    expect(r.target).toBe('/notice');
    expect(r.host).toBe('notice.recall.test');
    expect(r.headers).toEqual([
      ['Host', 'notice.recall.test'],
      ['Accept-Encoding', 'identity'],
      ['Connection', 'close'],
    ]);
  });

  it('accepts an optional :443 suffix and keeps the target verbatim', () => {
    const r = parseRequest(req('GET /a/../b?x=%20&y=1 HTTP/1.1', 'Host: Notice.Recall.Test:443\r\n'));
    expect(r.host).toBe('Notice.Recall.Test');
    expect(r.target).toBe('/a/../b?x=%20&y=1');
  });

  it('rejects absolute-form, authority-form, asterisk and other bad targets (R16)', () => {
    for (const line of [
      'GET https://evil.example/notice HTTP/1.1',
      'GET http://notice.recall.test/notice HTTP/1.1',
      'GET notice.recall.test:443 HTTP/1.1',
      'GET * HTTP/1.1',
      'GET notice HTTP/1.1',
      'GET //evil.example/notice HTTP/1.1',
      'GET /\\evil.example/notice HTTP/1.1',
      'GET /noticeé HTTP/1.1',
      'GET /notice#frag HTTP/1.1',
    ]) {
      expect(() => parseRequest(req(line)), line).toThrow();
    }
  });

  it('rejects non-GET methods and other protocol versions (R16)', () => {
    for (const line of [
      'POST /notice HTTP/1.1',
      'HEAD /notice HTTP/1.1',
      'get /notice HTTP/1.1',
      'CONNECT notice.recall.test:443 HTTP/1.1',
      'GET /notice HTTP/1.0',
      'GET /notice HTTP/2',
      'GET  /notice HTTP/1.1',
      'GET /notice  HTTP/1.1',
      'GET /notice HTTP/1.1 extra',
      'GET /notice',
    ]) {
      expect(() => parseRequest(req(line)), line).toThrow();
    }
  });

  it('rejects missing, duplicate and wrong-port Host headers (R16)', () => {
    const line = 'GET /notice HTTP/1.1';
    expect(() => parseRequest(req(line, 'Accept: */*\r\n'))).toThrow();
    expect(() =>
      parseRequest(req(line, 'Host: notice.recall.test\r\nHost: notice.recall.test\r\n')),
    ).toThrow();
    expect(() => parseRequest(req(line, 'Host: notice.recall.test\r\nhost: other.example\r\n'))).toThrow();
    for (const h of [
      'Host: x:8443\r\n',
      'Host: notice.recall.test:80\r\n',
      'Host: notice.recall.test:0443\r\n',
      'Host: notice.recall.test:443:443\r\n',
      'Host: notice.recall.test:\r\n',
      'Host: notice.recall.test :443\r\n',
      'Host: \r\n',
    ]) {
      expect(() => parseRequest(req(line, h)), h).toThrow();
    }
  });

  it('rejects obs-fold, bare LF, lines without a colon and bad header names (R16)', () => {
    const line = 'GET /notice HTTP/1.1';
    for (const h of [
      'Host: notice.recall.test\r\nX-A: b\r\n Cookie: a=1\r\n',
      'Host: notice.recall.test\r\nX-A: b\r\n\tCookie: a=1\r\n',
      'Host: notice.recall.test\r\nX-A: b\nCookie: a=1\r\n',
      'Host: notice.recall.test\r\nX-Broken\r\n',
      'Host: notice.recall.test\r\nCookie : a=1\r\n',
      'Host: notice.recall.test\r\n: b\r\n',
      'Host: notice.recall.test\r\nX-A: b\0c\r\n',
    ]) {
      expect(() => parseRequest(req(line, h)), JSON.stringify(h)).toThrow();
    }
  });

  it('rejects an unterminated head, a request body and Transfer-Encoding', () => {
    expect(() => parseRequest(enc.encode('GET /a HTTP/1.1\r\nHost: notice.recall.test\r\n'))).toThrow();
    expect(() =>
      parseRequest(enc.encode('GET /a HTTP/1.1\r\nHost: notice.recall.test\r\n\r\nGET /b HTTP/1.1\r\n\r\n')),
    ).toThrow();
    expect(() =>
      parseRequest(req('GET /a HTTP/1.1', 'Host: notice.recall.test\r\nTransfer-Encoding: chunked\r\n')),
    ).toThrow();
    expect(() => parseRequest(new Uint8Array([0x47, 0x45, 0x54, 0xff, 0x0d, 0x0a, 0x0d, 0x0a]))).toThrow();
  });

  it('still returns Cookie/Authorization headers so that check B can reject them', () => {
    const r = parseRequest(req('GET /a HTTP/1.1', 'Host: notice.recall.test\r\nCookie: a=1\r\n'));
    expect(r.headers).toContainEqual(['Cookie', 'a=1']);
  });
});

describe('parseResponse', () => {
  it('parses a real Content-Length response', async () => {
    const r = parseResponse(notice.recv);
    expect(r.status).toBe(200);
    expect(r.complete).toBe(true);
    const len = r.headers.find(([k]) => k.toLowerCase() === 'content-length')?.[1];
    expect(Number(len)).toBe(r.body.length);
    const ct = r.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    expect(ct).toBe('text/html; charset=utf-8');
    // the fixture serves version 1 or 2 (other suites may flip it)
    expect([fixtureFile('v1.html'), fixtureFile('v2.html')].some((f) => bytesEqual(f, r.body))).toBe(true);
  });

  it('parses a real chunked response and de-chunks the body', async () => {
    const r = parseResponse(chunked.recv);
    expect(r.status).toBe(200);
    expect(r.complete).toBe(true);
    expect(r.headers.find(([k]) => k.toLowerCase() === 'transfer-encoding')?.[1]).toBe('chunked');
    expect(dec.decode(r.body)).toBe(
      '<!doctype html><html><body><h1>Mumbai Institute of Studies — Admissions Notice</h1>' +
        '<p>chunked response</p></body></html>',
    );
    // the transcript really carries chunk framing, and Node's own parser agrees
    expect(chunked.recv.length).toBeGreaterThan(r.body.length + 100);
    expect(dec.decode(chunked.recv)).toContain('\r\n0\r\n\r\n');
    expect(bytesEqual(r.body, await nodeBody('/chunked'))).toBe(true);
  });

  it('parses the ~100 KB /big page', async () => {
    const r = parseResponse(big.recv);
    expect(r.status).toBe(200);
    expect(r.complete).toBe(true);
    expect(r.body.length).toBeGreaterThan(100_000);
    expect(bytesEqual(r.body, await nodeBody('/big'))).toBe(true);
  });

  it('parses the binary PDF body byte for byte', () => {
    const r = parseResponse(pdf.recv);
    expect(r.complete).toBe(true);
    expect(r.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1]).toBe('application/pdf');
    expect([fixtureFile('v1.pdf'), fixtureFile('v2.pdf')].some((f) => bytesEqual(f, r.body))).toBe(true);
  });

  it('a truncated response is incomplete (Content-Length, chunked and in the head)', () => {
    expect(parseResponse(notice.recv.slice(0, -10)).complete).toBe(false);
    expect(parseResponse(chunked.recv.slice(0, -10)).complete).toBe(false);
    expect(parseResponse(chunked.recv.slice(0, -5)).complete).toBe(false); // final 0-chunk missing
    expect(parseResponse(big.recv.slice(0, 30_000)).complete).toBe(false);
    const inHead = parseResponse(notice.recv.slice(0, 20));
    expect(inHead.complete).toBe(false);
    expect(inHead.body.length).toBe(0);
    expect(parseResponse(new Uint8Array(0)).complete).toBe(false);
  });

  it('a chunk extension (1a;foo=bar) and a trailer parse to the correct body', () => {
    const head = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n';
    const abc = 'abcdefghijklmnopqrstuvwxyz'; // 26 bytes = 0x1a
    const r = parseResponse(enc.encode(`${head}1a;foo=bar\r\n${abc}\r\n5\r\nhello\r\n0\r\nX-Trailer: v\r\n\r\n`));
    expect(r.complete).toBe(true);
    expect(dec.decode(r.body)).toBe(`${abc}hello`);
    // with uppercase hex and an extension on the last chunk as well
    const r2 = parseResponse(enc.encode(`${head}1A;a=b;c\r\n${abc}\r\n0;done\r\n\r\n`));
    expect(r2.complete).toBe(true);
    expect(dec.decode(r2.body)).toBe(abc);
    // a cut inside the trailer section is incomplete, not an error
    const cut = parseResponse(enc.encode(`${head}1a;foo=bar\r\n${abc}\r\n0\r\nX-Trailer: v\r\n`));
    expect(cut.complete).toBe(false);
    expect(dec.decode(cut.body)).toBe(abc);
  });

  it('a real chunked capture with an extension and a trailer added still de-chunks to the same body', async () => {
    const text = Buffer.from(chunked.recv);
    const first = text.indexOf('\r\n\r\n') + 4;
    const sizeEnd = text.indexOf('\r\n', first);
    const last = text.lastIndexOf('0\r\n\r\n');
    expect(last).toBeGreaterThan(sizeEnd);
    const edited = Buffer.concat([
      text.subarray(0, sizeEnd),
      Buffer.from(';foo=bar'),
      text.subarray(sizeEnd, last),
      Buffer.from('0\r\nX-Trailer: v\r\n\r\n'),
    ]);
    const r = parseResponse(new Uint8Array(edited));
    expect(r.complete).toBe(true);
    expect(bytesEqual(r.body, await nodeBody('/chunked'))).toBe(true);
  });

  it('trailing bytes after the response and malformed framing throw', () => {
    expect(() => parseResponse(new Uint8Array([...notice.recv, 0x41]))).toThrow();
    const head = (h: string) => enc.encode(`HTTP/1.1 200 OK\r\n${h}\r\n\r\n`);
    const cat = (a: Uint8Array, s: string) => new Uint8Array([...a, ...enc.encode(s)]);
    expect(() => parseResponse(cat(head('Transfer-Encoding: chunked'), 'zz\r\nabc\r\n0\r\n\r\n'))).toThrow();
    expect(() => parseResponse(cat(head('Transfer-Encoding: chunked'), '3\r\nabcXX0\r\n\r\n'))).toThrow();
    expect(() => parseResponse(head('Content-Length: abc'))).toThrow();
    expect(() => parseResponse(head('Content-Length: 1\r\nContent-Length: 2'))).toThrow();
    expect(() => parseResponse(head('Content-Length: 1\r\nTransfer-Encoding: chunked'))).toThrow();
    expect(() => parseResponse(head('Transfer-Encoding: gzip, chunked'))).toThrow();
    expect(() => parseResponse(enc.encode('NOPE 200 OK\r\n\r\n'))).toThrow();
    expect(() => parseResponse(enc.encode('HTTP/1.1 200 OK\r\nX-Broken\r\n\r\n'))).toThrow();
    expect(() => parseResponse(enc.encode('HTTP/1.1 200 OK\r\nX-A: b\r\n c\r\n\r\n'))).toThrow();
  });

  it('a body with no framing is reported incomplete (close-delimited cannot be proven whole)', () => {
    const r = parseResponse(enc.encode('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html>'));
    expect(r.status).toBe(200);
    expect(r.complete).toBe(false);
    const nc = parseResponse(enc.encode('HTTP/1.1 304 Not Modified\r\nETag: "x"\r\n\r\n'));
    expect(nc.status).toBe(304);
    expect(nc.complete).toBe(true);
    expect(nc.body.length).toBe(0);
  });
});

describe('canonicalUrl and urlHash', () => {
  it('canonicalUrl normalises', () => {
    expect(canonicalUrl('HTTPS://Notice.Recall.Test:443/notice?a=1#x')).toBe(
      'https://notice.recall.test/notice?a=1',
    );
    expect(canonicalUrl('https://notice.recall.test')).toBe('https://notice.recall.test/');
    expect(canonicalUrl('https://notice.recall.test?q=A')).toBe('https://notice.recall.test/?q=A');
  });

  it('keeps path and query verbatim (no dot-segment or percent-encoding rewrites)', () => {
    expect(canonicalUrl('https://Example.COM/A/../B%2f%7e?Q=%7E&x=A#frag')).toBe(
      'https://example.com/A/../B%2f%7e?Q=%7E&x=A',
    );
    expect(canonicalUrl('https://example.com/p?')).toBe('https://example.com/p?');
  });

  it('keeps a non-443 port and drops an explicit 443', () => {
    expect(canonicalUrl('https://example.com:8443/x')).toBe('https://example.com:8443/x');
    expect(canonicalUrl('https://example.com:/x')).toBe('https://example.com/x');
  });

  it('rejects anything but https and ambiguous authorities', () => {
    for (const raw of [
      'http://notice.recall.test/notice',
      'ftp://notice.recall.test/',
      'notice.recall.test/notice',
      '//notice.recall.test/notice',
      'https:///notice',
      'https://user@notice.recall.test/notice',
      'https://user:pw@notice.recall.test/notice',
      'https://notice.recall.test:abc/notice',
      'https://notice recall.test/notice',
      'https://notice.recall.test/no tice',
      'https://notice.recall.test\\@evil.example/',
      'https://notice.recall.test/a\\b',
      'https://notice.recall.test/a\nb',
      '',
    ]) {
      expect(() => canonicalUrl(raw), JSON.stringify(raw)).toThrow();
    }
  });

  it('urlHash is keccak256 of the canonical URL bytes', () => {
    const c = 'https://notice.recall.test/notice';
    expect(urlHash(c)).toBe(keccak256(toBytes(c)));
    expect(urlHash(c)).toBe('0x' + urlHash(c).slice(2).toLowerCase());
    expect(urlHash(c)).toHaveLength(66);
  });
});

describe('evidence file', () => {
  it('round-trips and starts with {"schema" so the gateway does not mistake it for HTML', async () => {
    const e = await makeEvidence(notice);
    const bytes = encodeEvidence(e);
    expect(dec.decode(bytes.slice(0, 9))).toBe('{"schema"');
    const back = decodeEvidence(bytes);
    expect(back).toEqual(e);
    expect(e.schema).toBe('recall.evidence.v1');
    expect(e.meta.capturedUrl).toBe('https://notice.recall.test/notice');
    expect(e.meta.size).toBe(notice.recv.length);
    // transcript is base64 of the real bytes
    expect(sha256(new Uint8Array(Buffer.from(e.transcript.recv, 'base64')))).toBe(sha256(notice.recv));
  });

  it('encodes the same bytes whatever the key order of the input (statement keys too)', async () => {
    const e = await makeEvidence(notice);
    const bytes = encodeEvidence(e);
    // chrome.storage hands objects back with sorted keys; any other order must not matter.
    const reverse = <T extends object>(o: T): T =>
      Object.fromEntries(Object.entries(o).reverse()) as T;
    const sorted = <T extends object>(o: T): T =>
      Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))) as T;
    for (const shuffle of [reverse, sorted]) {
      const shuffled = shuffle({
        ...e,
        statement: shuffle(e.statement),
        transcript: shuffle(e.transcript),
        meta: shuffle(e.meta),
      });
      expect(Object.keys(shuffled.statement)).not.toEqual(Object.keys(e.statement));
      expect(bytesEqual(encodeEvidence(shuffled), bytes)).toBe(true);
    }
    // Extra keys never reach the file.
    const extra = { ...e, extra: 1, statement: { ...e.statement, extra: 2 } } as unknown as typeof e;
    expect(bytesEqual(encodeEvidence(extra), bytes)).toBe(true);
    // The canonical form is a fixed point.
    expect(bytesEqual(encodeEvidence(decodeEvidence(bytes)), bytes)).toBe(true);
  });

  it('round-trips the 100 KB transcript', async () => {
    const e = await makeEvidence(big);
    expect(decodeEvidence(encodeEvidence(e))).toEqual(e);
  });

  it('decodeEvidence rejects malformed files', async () => {
    const e = await makeEvidence(notice);
    const js = (o: unknown) => enc.encode(JSON.stringify(o));
    expect(() => decodeEvidence(enc.encode('not json'))).toThrow();
    expect(() => decodeEvidence(js(null))).toThrow();
    expect(() => decodeEvidence(js({ ...e, schema: 'recall.evidence.v2' }))).toThrow();
    expect(() => decodeEvidence(js({ ...e, statement: { ...e.statement, nonce: '0x12' } }))).toThrow();
    expect(() => decodeEvidence(js({ ...e, signature: '0x1234' }))).toThrow();
    expect(() => decodeEvidence(js({ ...e, signer: '0xnope' }))).toThrow();
    expect(() => decodeEvidence(js({ ...e, transcript: { ...e.transcript, sent: '***' } }))).toThrow();
    expect(() => decodeEvidence(js({ ...e, transcript: { recv: e.transcript.recv } }))).toThrow();
    expect(() => decodeEvidence(js({ ...e, meta: { capturedUrl: 1, size: 2 } }))).toThrow();
    expect(() => decodeEvidence(js({ ...e, meta: undefined }))).toThrow();
  });

  it('request bytes used by the helper are what the witness would accept', () => {
    expect(() => parseRequest(requestBytes('/notice'))).not.toThrow();
  });
});
