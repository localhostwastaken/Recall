// HTTP/1.1 transcript parsing for fully revealed TLS transcripts. The request
// rules mirror the witness (witness/src/gates.rs): anything the witness would
// refuse to sign must also be refused here (ruling R16).

export type Headers = [string, string][];

export type ParsedRequest = {
  method: string;
  target: string;
  /** The Host header without its optional `:443` suffix (case preserved). */
  host: string;
  headers: Headers;
};

export type ParsedResponse = {
  /** 0 when the transcript ends before the status line is complete. */
  status: number;
  headers: Headers;
  body: Uint8Array;
  /** True only when the framing (Content-Length or chunked) proves the body is whole. */
  complete: boolean;
};

const CR = 0x0d;
const LF = 0x0a;
const EMPTY = new Uint8Array(0);

function findHeadEnd(b: Uint8Array): number {
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === CR && b[i + 1] === LF && b[i + 2] === CR && b[i + 3] === LF) return i;
  }
  return -1;
}

function findCrlf(b: Uint8Array, from: number): number {
  for (let i = from; i + 1 < b.length; i++) {
    if (b[i] === CR && b[i + 1] === LF) return i;
  }
  return -1;
}

function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

/** RFC 9110 `tchar`. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// field-value: VCHAR / obs-text / SP / HTAB. Control bytes (except HTAB) are refused.
const BAD_VALUE = /[\u0000-\u0008\u000a-\u001f\u007f]/;

function parseHeaderLines(lines: string[], fail: (m: string) => never): Headers {
  const headers: Headers = [];
  for (const line of lines) {
    if (line.includes('\r') || line.includes('\n')) fail('bare CR or LF in a header line');
    if (line.startsWith(' ') || line.startsWith('\t')) fail('obsolete line folding');
    const colon = line.indexOf(':');
    if (colon < 0) fail('header line without a colon');
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (!TOKEN.test(name)) fail('invalid header name');
    if (BAD_VALUE.test(value)) fail('control byte in a header value');
    headers.push([name, value.replace(/^[ \t]+|[ \t]+$/g, '')]);
  }
  return headers;
}

const named = (headers: Headers, name: string): string[] =>
  headers.filter(([k]) => k.toLowerCase() === name).map(([, v]) => v);

/**
 * Parses the request a capture sent. Accepts only `GET SP origin-form SP HTTP/1.1`
 * with exactly one Host header (optional `:443` suffix) and no request body.
 * Throws on anything else. Cookie/Authorization headers are returned, not judged
 * here (check B rejects them).
 */
export function parseRequest(sent: Uint8Array): ParsedRequest {
  const fail = (m: string): never => {
    throw new Error(`malformed request: ${m}`);
  };
  const end = findHeadEnd(sent);
  if (end < 0) fail('unterminated head');
  let head: string;
  try {
    head = new TextDecoder('utf-8', { fatal: true }).decode(sent.subarray(0, end));
  } catch {
    return fail('head is not valid UTF-8');
  }
  const [requestLine, ...headerLines] = head.split('\r\n');

  const parts = requestLine.split(' ');
  if (parts.length !== 3) fail('request line must be exactly METHOD SP target SP version');
  const [method, target, version] = parts;
  if (method !== 'GET') fail('only GET is allowed');
  if (version !== 'HTTP/1.1') fail('only HTTP/1.1 is allowed');
  if (
    !target.startsWith('/') ||
    target.startsWith('//') ||
    /[\\#]/.test(target) ||
    !/^[\x21-\x7e]+$/.test(target)
  ) {
    fail('target must be an origin-form path');
  }

  const headers = parseHeaderLines(headerLines, fail);
  if (named(headers, 'transfer-encoding').length > 0) fail('Transfer-Encoding is not allowed');
  const lengths = named(headers, 'content-length');
  if (lengths.length > 1 || (lengths.length === 1 && !/^[0-9]+$/.test(lengths[0]))) {
    fail('invalid Content-Length');
  }
  const bodyLen = sent.length - (end + 4);
  if (bodyLen !== (lengths.length === 1 ? Number(lengths[0]) : 0)) fail('unexpected request body');

  const hosts = named(headers, 'host');
  if (hosts.length !== 1) fail('exactly one Host header is required');
  const host = hosts[0].endsWith(':443') ? hosts[0].slice(0, -4) : hosts[0];
  if (!/^[A-Za-z0-9._-]+$/.test(host)) fail('Host must be a bare host name (port 443 only)');

  return { method, target, host, headers };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

type Framed = { body: Uint8Array; complete: boolean };

function decodeChunked(recv: Uint8Array, start: number, fail: (m: string) => never): Framed {
  const parts: Uint8Array[] = [];
  let pos = start;
  const partial = (): Framed => ({ body: concat(parts), complete: false });
  for (;;) {
    const lineEnd = findCrlf(recv, pos);
    if (lineEnd < 0) return partial();
    const sizeLine = latin1(recv.subarray(pos, lineEnd));
    const m = /^([0-9A-Fa-f]{1,13})(;[^\r\n]*)?$/.exec(sizeLine);
    if (!m) return fail('invalid chunk size line');
    const size = parseInt(m[1], 16);
    pos = lineEnd + 2;
    if (size === 0) {
      // trailer section: header-ish lines until an empty line
      for (;;) {
        const te = findCrlf(recv, pos);
        if (te < 0) return partial();
        const line = latin1(recv.subarray(pos, te));
        pos = te + 2;
        if (line === '') {
          if (pos !== recv.length) fail('trailing bytes after the last chunk');
          return { body: concat(parts), complete: true };
        }
        if (!line.includes(':') || line.startsWith(' ') || line.startsWith('\t')) fail('invalid trailer');
      }
    }
    const dataEnd = pos + size;
    parts.push(recv.slice(pos, Math.min(dataEnd, recv.length)));
    if (dataEnd >= recv.length) return partial();
    // the chunk data must be followed by CRLF
    if (recv[dataEnd] !== CR) fail('chunk data not followed by CRLF');
    if (dataEnd + 1 >= recv.length) return partial();
    if (recv[dataEnd + 1] !== LF) fail('chunk data not followed by CRLF');
    pos = dataEnd + 2;
  }
}

/**
 * Parses a response transcript. Supports Content-Length and chunked framing.
 * A transcript cut short anywhere yields `complete: false`; a body whose end
 * the bytes cannot prove (no framing) is also reported incomplete.
 * Throws on malformed framing or trailing bytes after the response.
 */
export function parseResponse(recv: Uint8Array): ParsedResponse {
  const fail = (m: string): never => {
    throw new Error(`malformed response: ${m}`);
  };
  const end = findHeadEnd(recv);
  if (end < 0) return { status: 0, headers: [], body: EMPTY, complete: false };

  const [statusLine, ...headerLines] = latin1(recv.subarray(0, end)).split('\r\n');
  const sm = /^HTTP\/1\.[01] ([0-9]{3})(?: [^\r\n]*)?$/.exec(statusLine);
  if (!sm) fail('invalid status line');
  const status = Number(sm![1]);
  if (status < 200) fail('informational responses are not supported');
  const headers = parseHeaderLines(headerLines, fail);
  const start = end + 4;

  const noBody = status === 204 || status === 304;
  if (noBody) {
    if (recv.length !== start) fail('trailing bytes after a bodiless response');
    return { status, headers, body: EMPTY, complete: true };
  }

  const te = named(headers, 'transfer-encoding');
  const cl = named(headers, 'content-length');
  if (te.length > 0 && cl.length > 0) fail('both Transfer-Encoding and Content-Length');

  if (te.length > 0) {
    const codings = te.join(',').split(',').map((c) => c.trim().toLowerCase());
    if (codings.length !== 1 || codings[0] !== 'chunked') fail('unsupported Transfer-Encoding');
    return { status, headers, ...decodeChunked(recv, start, fail) };
  }

  if (cl.length > 0) {
    const values = cl.join(',').split(',').map((v) => v.trim());
    if (!values.every((v) => /^[0-9]{1,15}$/.test(v)) || new Set(values).size !== 1) {
      fail('invalid Content-Length');
    }
    const n = Number(values[0]);
    const avail = recv.length - start;
    if (avail > n) fail('trailing bytes after the response');
    return { status, headers, body: recv.slice(start), complete: avail === n };
  }

  // No framing: the body would run until the connection closes, which the
  // transcript cannot prove happened cleanly.
  return { status, headers, body: recv.slice(start), complete: false };
}

/** Case-insensitive first value of a header, or undefined. */
export function headerValue(headers: Headers, name: string): string | undefined {
  return named(headers, name.toLowerCase())[0];
}

export const headerValues = (headers: Headers, name: string): string[] => named(headers, name.toLowerCase());
