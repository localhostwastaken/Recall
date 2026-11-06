import { beforeAll, describe, expect, it } from 'vitest';
import { sha256, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { runChecks } from '../src/checks';
import { urlHash } from '../src/url';
import { CAPTURE_REQUEST_HEADERS, CAPTURE_USER_AGENT } from '../src/request';
import type { EvidenceFile } from '../src/evidence';
import {
  FIXTURE_HOST,
  TEST_SIGNER,
  bytesEqual,
  fixtureFile,
  makeEvidence,
  nodeBody,
  record,
  recordRaw,
  requestBytes,
  type Recording,
} from './helpers';

const enc = new TextEncoder();
const pinned = [TEST_SIGNER];

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

const flip = (b64: string, at: number): string => {
  const raw = Buffer.from(b64, 'base64');
  raw[at] ^= 0x01;
  return raw.toString('base64');
};

/** Replaces the first occurrence of an ASCII needle in the recorded bytes (byte-level, body untouched). */
const replaceAscii = (rec: Recording, needle: string, repl: string): Recording => {
  const at = Buffer.from(rec.recv).indexOf(needle);
  expect(at).toBeGreaterThan(-1);
  const out = Buffer.concat([
    Buffer.from(rec.recv.subarray(0, at)),
    Buffer.from(repl),
    Buffer.from(rec.recv.subarray(at + needle.length)),
  ]);
  return { sent: rec.sent, recv: new Uint8Array(out) };
};

describe('runChecks A–C on real captures', () => {
  it('a genuine Content-Length capture passes A, B and C and yields facts', async () => {
    const e = await makeEvidence(notice);
    const r = await runChecks(e, { pinnedWitnesses: pinned });
    expect(r.A.status).toBe('pass');
    expect(r.B.status).toBe('pass');
    expect(r.C.status).toBe('pass');
    expect(r.D).toBeUndefined();
    const f = r.facts!;
    expect(f).toBeDefined();
    expect(f.canonicalUrl).toBe('https://notice.recall.test/notice');
    expect(f.urlHash).toBe(urlHash('https://notice.recall.test/notice'));
    expect(f.serverName).toBe(FIXTURE_HOST);
    expect(f.httpStatus).toBe(200);
    expect(f.contentType).toBe('text/html; charset=utf-8');
    expect(f.witness).toBe(TEST_SIGNER);
    expect(f.signedAt).toBe(BigInt(e.statement.signedAt));
    expect(f.bodySha256).toBe(sha256(f.body));
    // the fixture serves version 1 or 2 (other suites may flip it between our calls)
    expect([fixtureFile('v1.html'), fixtureFile('v2.html')].some((x) => bytesEqual(x, f.body))).toBe(true);
  });

  it('a genuine chunked capture passes and the facts body has no chunk framing', async () => {
    const r = await runChecks(await makeEvidence(chunked), { pinnedWitnesses: pinned });
    expect([r.A.status, r.B.status, r.C.status]).toEqual(['pass', 'pass', 'pass']);
    expect(bytesEqual(r.facts!.body, await nodeBody('/chunked'))).toBe(true);
    expect(r.facts!.canonicalUrl).toBe('https://notice.recall.test/chunked');
  });

  it('the 100 KB page and the PDF pass', async () => {
    const rb = await runChecks(await makeEvidence(big), { pinnedWitnesses: pinned });
    expect([rb.A.status, rb.B.status, rb.C.status]).toEqual(['pass', 'pass', 'pass']);
    expect(rb.facts!.body.length).toBeGreaterThan(100_000);
    const rp = await runChecks(await makeEvidence(pdf), { pinnedWitnesses: pinned });
    expect([rp.A.status, rp.B.status, rp.C.status]).toEqual(['pass', 'pass', 'pass']);
    expect(rp.facts!.contentType).toBe('application/pdf');
  });

  it('the witness-signed serverName stays verbatim while the host comparison and URL are lower-cased (R17)', async () => {
    const rec = await recordRaw(requestBytes('/notice', 'Notice.Recall.Test:443'));
    const e = await makeEvidence(rec, { serverName: 'notice.RECALL.test' });
    const r = await runChecks(e, { pinnedWitnesses: pinned });
    expect(r.B.status).toBe('pass');
    expect(r.facts!.serverName).toBe('notice.RECALL.test');
    expect(r.facts!.canonicalUrl).toBe('https://notice.recall.test/notice');
  });

  it('keeps the query string verbatim in the canonical URL', async () => {
    const rec = await record('/notice?a=1&b=%20');
    const r = await runChecks(await makeEvidence(rec), { pinnedWitnesses: pinned });
    expect(r.facts!.canonicalUrl).toBe('https://notice.recall.test/notice?a=1&b=%20');
  });
});

describe('check A', () => {
  it('fails when one recv byte is flipped, and facts are withheld', async () => {
    const e = await makeEvidence(notice);
    const bad: EvidenceFile = { ...e, transcript: { ...e.transcript, recv: flip(e.transcript.recv, notice.recv.length - 5) } };
    const r = await runChecks(bad, { pinnedWitnesses: pinned });
    expect(r.A.status).toBe('fail');
    expect(r.A.detail).toMatch(/recv/);
    expect(r.facts).toBeUndefined();
  });

  it('fails when one sent byte is flipped', async () => {
    const e = await makeEvidence(notice);
    const bad: EvidenceFile = { ...e, transcript: { ...e.transcript, sent: flip(e.transcript.sent, 5) } };
    const r = await runChecks(bad, { pinnedWitnesses: pinned });
    expect(r.A.status).toBe('fail');
    expect(r.A.detail).toMatch(/sent/);
    expect(r.facts).toBeUndefined();
  });

  it('fails on a length mismatch even when the hash is of the shorter bytes', async () => {
    const e = await makeEvidence(notice, { override: { recvLen: notice.recv.length + 1 } });
    const r = await runChecks(e, { pinnedWitnesses: pinned });
    expect(r.A.status).toBe('fail');
    expect(r.A.detail).toMatch(/length/);
  });

  it('fails on bad base64 or an invalid statement without throwing', async () => {
    const e = await makeEvidence(notice);
    const r1 = await runChecks({ ...e, transcript: { sent: '***', recv: e.transcript.recv } }, { pinnedWitnesses: pinned });
    expect(r1.A.status).toBe('fail');
    const r2 = await runChecks({ ...e, statement: { ...e.statement, nonce: '0x12' as Hex } }, { pinnedWitnesses: pinned });
    expect(r2.A.status).toBe('fail');
    expect(r2.B.status).toBe('fail');
    expect(r2.C.status).toBe('fail');
    expect(r2.facts).toBeUndefined();
  });
});

describe('check B', () => {
  it('fails for a truncated response (the witness signed what it saw) and withholds facts', async () => {
    const trunc: Recording = { sent: notice.sent, recv: notice.recv.slice(0, -10) };
    const r = await runChecks(await makeEvidence(trunc), { pinnedWitnesses: pinned });
    expect(r.A.status).toBe('pass');
    expect(r.B.status).toBe('fail');
    expect(r.B.detail).toMatch(/incomplete/);
    expect(r.C.status).toBe('pass');
    expect(r.facts).toBeUndefined();
  });

  it('fails for a truncated chunked response', async () => {
    const trunc: Recording = { sent: chunked.sent, recv: chunked.recv.slice(0, -10) };
    const r = await runChecks(await makeEvidence(trunc), { pinnedWitnesses: pinned });
    expect(r.B.status).toBe('fail');
  });

  it('fails when the response has a Content-Encoding other than identity', async () => {
    const gz = replaceAscii(notice, 'Content-Encoding: identity', 'Content-Encoding: gzip');
    expect(gz.recv.length).not.toBe(notice.recv.length);
    const r = await runChecks(await makeEvidence(gz), { pinnedWitnesses: pinned });
    expect(r.A.status).toBe('pass');
    expect(r.B.status).toBe('fail');
    expect(r.B.detail).toMatch(/Content-Encoding/i);
    expect(r.facts).toBeUndefined();
  });

  it('passes with Content-Encoding identity and with the header absent', async () => {
    // /notice carries `Content-Encoding: identity`; /chunked carries no Content-Encoding at all
    expect(new TextDecoder().decode(notice.recv)).toMatch(/Content-Encoding: identity/i);
    expect(new TextDecoder().decode(chunked.recv)).not.toMatch(/Content-Encoding/i);
    for (const rec of [notice, chunked]) {
      const r = await runChecks(await makeEvidence(rec), { pinnedWitnesses: pinned });
      expect(r.B.status).toBe('pass');
    }
  });

  it('fails when the request carries a Cookie or Authorization header', async () => {
    for (const h of ['Cookie: session=abc', 'Authorization: Bearer x', 'cookie: a=1']) {
      const sent = enc.encode(
        `GET /notice HTTP/1.1\r\nHost: ${FIXTURE_HOST}\r\n${h}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`,
      );
      const rec = await recordRaw(sent);
      const r = await runChecks(await makeEvidence(rec), { pinnedWitnesses: pinned });
      expect(r.A.status).toBe('pass');
      expect(r.B.status).toBe('fail');
      expect(r.B.detail).toMatch(/cookie|authorization/i);
      expect(r.facts).toBeUndefined();
    }
  });

  it('fails when Host differs from the signed serverName', async () => {
    const rec = await recordRaw(requestBytes('/notice', 'other.example'));
    const r = await runChecks(await makeEvidence(rec), { pinnedWitnesses: pinned });
    expect(r.B.status).toBe('fail');
    expect(r.B.detail).toMatch(/host/i);
    const r2 = await runChecks(await makeEvidence(notice, { serverName: 'other.example' }), {
      pinnedWitnesses: pinned,
    });
    expect(r2.B.status).toBe('fail');
  });

  it('fails for request lines the witness would reject (R16)', async () => {
    const cases = [
      `GET https://evil.example/notice HTTP/1.1\r\nHost: ${FIXTURE_HOST}\r\nConnection: close\r\n\r\n`,
      `POST /notice HTTP/1.1\r\nHost: ${FIXTURE_HOST}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      `GET /notice HTTP/1.1\r\nHost: ${FIXTURE_HOST}\r\nHost: ${FIXTURE_HOST}\r\nConnection: close\r\n\r\n`,
      `GET /notice HTTP/1.1\r\nHost: ${FIXTURE_HOST}:8443\r\nConnection: close\r\n\r\n`,
    ];
    for (const c of cases) {
      const rec = await recordRaw(enc.encode(c)).catch(() => ({ sent: enc.encode(c), recv: new Uint8Array(0) }));
      const r = await runChecks(await makeEvidence(rec), { pinnedWitnesses: pinned });
      expect(r.B.status, c).toBe('fail');
      expect(r.B.detail, c).toMatch(/malformed request/);
      expect(r.facts).toBeUndefined();
    }
  });
});

describe('check B request-header allowlist and partial content (R20)', () => {
  const withHeaders = (extra: string[], target = '/notice'): Uint8Array =>
    enc.encode(
      [`GET ${target} HTTP/1.1`, `Host: ${FIXTURE_HOST}`, ...extra, 'Connection: close', '', ''].join('\r\n'),
    );
  const checkB = async (sent: Uint8Array) => {
    const rec = await recordRaw(sent);
    return runChecks(await makeEvidence(rec), { pinnedWitnesses: pinned });
  };

  it('Range header rejected', async () => {
    const r = await checkB(withHeaders(['Range: bytes=0-9']));
    expect(r.A.status).toBe('pass');
    expect(r.B.status).toBe('fail');
    expect(r.B.detail).toContain('Range');
    expect(r.facts).toBeUndefined();
  });

  it('X-Original-URL rejected', async () => {
    const r = await checkB(withHeaders(['X-Original-URL: /admin']));
    expect(r.B.status).toBe('fail');
    expect(r.B.detail).toContain('X-Original-URL');
    expect(r.facts).toBeUndefined();
  });

  it('every other header that can change the response is rejected, case-insensitively named', async () => {
    for (const h of [
      'X-Rewrite-URL: /admin',
      'X-HTTP-Method-Override: DELETE',
      'X-Forwarded-For: 10.0.0.1',
      'X-Forwarded-Host: evil.example',
      'Forwarded: for=10.0.0.1',
      'If-None-Match: "x"',
      'If-Modified-Since: Sat, 01 Jan 2000 00:00:00 GMT',
      'If-Range: "x"',
      'Cookie: a=1',
      'authorization: Bearer x',
      'Referer: https://evil.example/',
      'Origin: https://evil.example',
      'Upgrade: websocket',
      'Content-Length: 0',
      'rAnGe: bytes=5-',
    ]) {
      const r = await checkB(withHeaders([h]));
      expect(r.B.status, h).toBe('fail');
      expect(r.B.detail.toLowerCase(), h).toContain(h.split(':')[0].toLowerCase());
      expect(r.facts, h).toBeUndefined();
    }
  });

  it('Accept-Encoding gzip rejected', async () => {
    for (const v of ['gzip', 'gzip, identity', 'br', '*']) {
      const r = await checkB(withHeaders([`Accept-Encoding: ${v}`]));
      expect(r.B.status, v).toBe('fail');
      expect(r.B.detail, v).toContain('Accept-Encoding');
    }
  });

  /** A capture's request with the fixed headers, `change` applied (a value, or null to leave one out). */
  const capture = (change: Record<string, string | null> = {}, extra: string[] = []): Uint8Array => {
    const fixed = { ...CAPTURE_REQUEST_HEADERS, ...change } as Record<string, string | null>;
    return enc.encode(
      [
        'GET /notice HTTP/1.1',
        `Host: ${FIXTURE_HOST}`,
        ...Object.entries(fixed).flatMap(([k, v]) => (v === null ? [] : [`${k}: ${v}`])),
        ...extra,
        '',
        '',
      ].join('\r\n'),
    );
  };

  it('the exact capture headers are accepted, in any order and with lower-case names', async () => {
    const r = await checkB(capture());
    expect(r.B.status, r.B.detail).toBe('pass');
    expect(r.facts).toBeDefined();
    expect(r.facts!.canonicalUrl).toBe('https://notice.recall.test/notice');
    // hyper (the prover's HTTP client) writes lower-case names in its own order.
    const lower = enc.encode(
      [
        'GET /notice HTTP/1.1',
        `connection: ${CAPTURE_REQUEST_HEADERS.Connection}`,
        `user-agent: ${CAPTURE_USER_AGENT}`,
        `accept: ${CAPTURE_REQUEST_HEADERS.Accept}`,
        `host: ${FIXTURE_HOST}`,
        `accept-language: ${CAPTURE_REQUEST_HEADERS['Accept-Language']}`,
        'accept-encoding: identity',
        '',
        '',
      ].join('\r\n'),
    );
    expect((await checkB(lower)).B.status).toBe('pass');
  });

  it('a different User-Agent, Accept-Language or Accept fails: it can pick another variant of the page', async () => {
    for (const [name, value] of [
      ['User-Agent', 'Mozilla/5.0 (Recall test)'],
      ['User-Agent', `${CAPTURE_USER_AGENT} Mobile`],
      ['Accept-Language', 'fr-FR,fr;q=0.9'],
      ['Accept', 'application/json'],
      ['Accept', 'text/html,*/*;q=0.8'],
      ['Connection', 'keep-alive'],
      ['Accept-Encoding', 'IDENTITY'],
    ] as const) {
      const r = await checkB(capture({ [name]: value }));
      expect(r.A.status).toBe('pass');
      expect(r.B.status, `${name}: ${value}`).toBe('fail');
      expect(r.B.detail, `${name}: ${value}`).toContain(name);
      expect(r.facts).toBeUndefined();
    }
  });

  it('a fixed header that is missing or sent twice fails', async () => {
    for (const name of Object.keys(CAPTURE_REQUEST_HEADERS)) {
      const r = await checkB(capture({ [name]: null }));
      expect(r.B.status, `without ${name}`).toBe('fail');
      expect(r.B.detail, `without ${name}`).toContain(name);
    }
    const twice = await checkB(capture({}, [`Accept-Language: ${CAPTURE_REQUEST_HEADERS['Accept-Language']}`]));
    expect(twice.B.status).toBe('fail');
    expect(twice.B.detail).toContain('Accept-Language');
  });

  it('206 response fails B', async () => {
    // a real capture with its status line changed to 206, then signed
    const partial = replaceAscii(notice, 'HTTP/1.1 200 OK', 'HTTP/1.1 206 Partial Content');
    const r = await runChecks(await makeEvidence(partial), { pinnedWitnesses: pinned });
    expect(r.A.status).toBe('pass');
    expect(r.B.status).toBe('fail');
    expect(r.B.detail).toMatch(/206|partial/i);
    expect(r.facts).toBeUndefined();
  });

  it('Content-Range fails B', async () => {
    // a real capture with a Content-Range header inserted (status stays 200), then signed
    const ranged = replaceAscii(notice, 'HTTP/1.1 200 OK\r\n', 'HTTP/1.1 200 OK\r\nContent-Range: bytes 0-9/100\r\n');
    const r = await runChecks(await makeEvidence(ranged), { pinnedWitnesses: pinned });
    expect(r.A.status).toBe('pass');
    expect(r.B.status).toBe('fail');
    expect(r.B.detail).toMatch(/Content-Range|partial/i);
    expect(r.facts).toBeUndefined();
  });
});

describe('check C', () => {
  it('warns for a valid signature from an unpinned witness, keeping facts', async () => {
    const e = await makeEvidence(notice, { key: generatePrivateKey() });
    const r = await runChecks(e, { pinnedWitnesses: pinned });
    expect(r.A.status).toBe('pass');
    expect(r.B.status).toBe('pass');
    expect(r.C.status).toBe('warn');
    expect(r.C.detail).toContain('unknown witness');
    expect(r.C.detail).toContain(e.signer);
    expect(r.facts).toBeDefined();
    expect(r.facts!.witness).toBe(e.signer);
  });

  it('warns when no witness is pinned and matches pinned addresses case-insensitively', async () => {
    const e = await makeEvidence(notice);
    expect((await runChecks(e, { pinnedWitnesses: [] })).C.status).toBe('warn');
    const lower = TEST_SIGNER.toLowerCase() as `0x${string}`;
    expect((await runChecks(e, { pinnedWitnesses: [lower] })).C.status).toBe('pass');
  });

  it('fails for a corrupted signature', async () => {
    const e = await makeEvidence(notice);
    const sig = e.signature;
    const corruptions: Hex[] = [
      (sig.slice(0, 10) + (sig[10] === 'a' ? 'b' : 'a') + sig.slice(11)) as Hex, // inside r
      (sig.slice(0, 80) + (sig[80] === 'a' ? 'b' : 'a') + sig.slice(81)) as Hex, // inside s
      `0x${'00'.repeat(65)}`,
      '0x1234' as Hex,
    ];
    for (const bad of corruptions) {
      const r = await runChecks({ ...e, signature: bad }, { pinnedWitnesses: pinned });
      expect(r.C.status, bad).toBe('fail');
      expect(r.facts).toBeUndefined();
    }
  });

  it('fails when the recovered address is not the stated signer', async () => {
    const e = await makeEvidence(notice);
    const other = privateKeyToAccount(generatePrivateKey()).address;
    const r = await runChecks({ ...e, signer: other }, { pinnedWitnesses: [other, TEST_SIGNER] });
    expect(r.C.status).toBe('fail');
    expect(r.facts).toBeUndefined();
  });

  it('fails when the statement was altered after signing', async () => {
    const e = await makeEvidence(notice);
    const r = await runChecks(
      { ...e, statement: { ...e.statement, signedAt: (BigInt(e.statement.signedAt) + 1n).toString() } },
      { pinnedWitnesses: pinned },
    );
    expect(r.C.status).toBe('fail');
    expect(r.facts).toBeUndefined();
  });
});

describe('check D', () => {
  it('passes when the user file equals the captured body, fails when it differs', async () => {
    const e = await makeEvidence(notice);
    const facts = (await runChecks(e, { pinnedWitnesses: pinned })).facts!;
    const body = [fixtureFile('v1.html'), fixtureFile('v2.html')].find((x) => bytesEqual(x, facts.body))!;
    expect(body).toBeDefined();
    const ok = await runChecks(e, { pinnedWitnesses: pinned, userFileBytes: body });
    expect(ok.D?.status).toBe('pass');
    const mutated = body.slice();
    mutated[0] ^= 1;
    const bad = await runChecks(e, { pinnedWitnesses: pinned, userFileBytes: mutated });
    expect(bad.D?.status).toBe('fail');
    expect(bad.facts).toBeDefined(); // D does not gate facts
    const empty = await runChecks(e, { pinnedWitnesses: pinned, userFileBytes: new Uint8Array(0) });
    expect(empty.D?.status).toBe('fail');
  });

  it('is unavailable when the body is not trustworthy (A or B failed)', async () => {
    const trunc: Recording = { sent: notice.sent, recv: notice.recv.slice(0, -10) };
    const r = await runChecks(await makeEvidence(trunc), { pinnedWitnesses: pinned, userFileBytes: new Uint8Array([1]) });
    expect(r.B.status).toBe('fail');
    expect(r.D?.status).toBe('unavailable');
    const e = await makeEvidence(notice);
    const badA = { ...e, transcript: { ...e.transcript, recv: flip(e.transcript.recv, 3) } };
    const r2 = await runChecks(badA, { pinnedWitnesses: pinned, userFileBytes: new Uint8Array([1]) });
    expect(r2.D?.status).toBe('unavailable');
  });
});
