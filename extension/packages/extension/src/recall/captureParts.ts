// Pure parts of a capture (no prover, no chrome APIs), so they can be unit tested.
import type { Commit } from 'tlsn-wasm';
import type { Handler } from '@tlsn/plugin-sdk';
import type { EvidenceFile } from '@recall/evidence';

/** Request bytes the prover may send (the witness allows up to 4096). */
export const MAX_SENT_DATA = 4096;
/** Response bytes the prover may receive: the 64 KB capture cap (witness MAX_RECV_DATA). */
export const MAX_RECV_DATA = 65536;

/**
 * Reveal both directions in full (`action: 'REVEAL'`, in the canonical object form
 * that tlsn-wasm and the witness deserialize). The witness refuses anything less.
 */
export const CAPTURE_HANDLERS: Handler[] = [
  { type: 'SENT', part: 'ALL', action: { kind: 'REVEAL' } },
  { type: 'RECV', part: 'ALL', action: { kind: 'REVEAL' } },
];

/**
 * Dev builds only: deliberately broken captures, used by the e2e tests to show that
 * the witness refuses each one. Release builds ignore them.
 */
export type CaptureOverrides = {
  mode?: 'Proxy';
  extraHeaders?: Record<string, string>;
  recvRevealEnd?: number;
  commit?: boolean;
  hostHeader?: string;
  /** Flips one received byte after signing, so check A fails (tests the upload gate). */
  tamperEvidence?: boolean;
};

export type CaptureErrorCode =
  | 'too_large'
  | 'tls'
  | 'witness_offline'
  | 'busy'
  | 'cancelled'
  | 'failed';

export type CaptureFailure = {
  error: string;
  code: CaptureErrorCode;
  /** too_large: the body size in bytes, when known. */
  size?: number;
};

export type CaptureOutcome = { evidence: EvidenceFile } | CaptureFailure;

export type CaptureStep = 1 | 2 | 3;

/** The capture target: https only, port 443 (the witness proxy dials only 443). */
export function captureTarget(raw: string): URL | CaptureFailure {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: 'this is not a web address', code: 'failed' };
  }
  if (u.protocol !== 'https:')
    return { error: 'only https:// pages can be captured', code: 'failed' };
  if (u.port !== '' && u.port !== '443') {
    return { error: 'only pages on the standard https port (443) can be captured', code: 'failed' };
  }
  if (u.username || u.password)
    return { error: 'addresses with a user name or password cannot be captured', code: 'failed' };
  // "example.org." is the same name as "example.org"; the witness signs the name
  // without the trailing dot, so the request and the statement use that form.
  if (u.hostname.endsWith('.')) u.hostname = u.hostname.replace(/\.+$/, '');
  if (!u.hostname || u.hostname.endsWith('.'))
    return { error: 'this is not a web address', code: 'failed' };
  u.hash = '';
  return u;
}

/**
 * The User-Agent every capture sends (ruling R26). Evidence is public and permanent,
 * so it must not carry the capturer's real browser and OS version; one fixed,
 * common desktop string also keeps captures by different people comparable.
 */
export const CAPTURE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * The request headers (ruling R20): only Host, Accept, Accept-Encoding: identity,
 * Accept-Language, User-Agent and Connection. No cookies, no auth, no Range. All
 * values are fixed, so nothing about the capturer's browser leaks into the evidence.
 */
export function requestHeaders(target: URL, overrides?: CaptureOverrides): Record<string, string> {
  return {
    Host: overrides?.hostHeader ?? target.hostname,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8',
    'Accept-Encoding': 'identity',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': CAPTURE_USER_AGENT,
    Connection: 'close',
    ...overrides?.extraHeaders,
  };
}

/** ws(s)://<witness>/proxy?token=<host>&sessionId=<id>: the witness relays to <host>:443. */
export function proxyUrlFor(witnessUrl: string, host: string, sessionId: string): string {
  const w = new URL(witnessUrl);
  const ws = w.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = w.pathname.replace(/\/+$/, '');
  const q = new URLSearchParams({ token: host, sessionId });
  return `${ws}//${w.host}${base}/proxy?${q.toString()}`;
}

/** 32 random bytes as 0x-hex: the witness signs it into the statement. */
export function randomNonce(): `0x${string}` {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

type Range = { start: number; end: number };
type RangeWithHandler = Range & { handler: Handler };

export type ComputedReveal = {
  sentRanges: Range[];
  recvRanges: Range[];
  sentRangesWithHandlers: RangeWithHandler[];
  recvRangesWithHandlers: RangeWithHandler[];
  commit?: Commit;
};

export type RevealPlan = {
  sent: Range[];
  recv: Range[];
  sentWithHandlers: RangeWithHandler[];
  recvWithHandlers: RangeWithHandler[];
  commit?: Commit;
};

/** What to reveal: everything, unless a dev override asks for a partial reveal or a commitment. */
export function revealPlan(
  c: ComputedReveal,
  recvLen: number,
  overrides?: CaptureOverrides,
): RevealPlan {
  const plan: RevealPlan = {
    sent: c.sentRanges,
    recv: c.recvRanges,
    sentWithHandlers: c.sentRangesWithHandlers,
    recvWithHandlers: c.recvRangesWithHandlers,
  };
  if (overrides?.recvRevealEnd !== undefined) {
    const end = Math.max(0, Math.min(overrides.recvRevealEnd, recvLen));
    const handler = CAPTURE_HANDLERS[1];
    plan.recv = [{ start: 0, end }];
    plan.recvWithHandlers = [{ start: 0, end, handler }];
  }
  if (overrides?.commit) {
    plan.commit = {
      sent: [],
      recv: [{ start: 0, end: Math.min(32, recvLen), algorithm: 'SHA256' }],
    };
  }
  return plan;
}

const KB = 1024;

/** "98.2 KB" (design brief size format). */
export function formatSize(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < KB * KB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${(bytes / (KB * KB)).toFixed(1)} MB`;
}

export function tooLarge(size: number | null, limit = MAX_RECV_DATA): CaptureFailure {
  const cap = formatSize(limit).replace('.0 ', ' ');
  return size === null
    ? { error: `page too large (over ${cap})`, code: 'too_large' }
    : { error: `page too large (${formatSize(size)} > ${cap})`, code: 'too_large', size };
}

export type SizeCheck = { ok: true } | { ok: false; size: number | null };

/**
 * Size pre-check, so a page over the cap fails in seconds instead of deep inside MPC.
 * GETs the page without cookies and counts the decoded body bytes (fetch always asks
 * for gzip, so Content-Length alone could undercount). Stops reading once the body
 * cannot fit next to the response head. Any network problem returns ok: the prover
 * still enforces the cap.
 */
export async function precheckSize(
  url: string,
  limit: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<SizeCheck> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
      signal: ctl.signal,
    });
    if (res.type === 'opaqueredirect' || !res.body) return { ok: true };
    let head = `HTTP/1.1 ${res.status} ${res.statusText}\r\n`.length + 2;
    res.headers.forEach((v, k) => (head += k.length + v.length + 4));
    const budget = limit - head;
    const encoding = (res.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
    const declared = (res.headers.get('content-length') ?? '').trim();
    const knownSize =
      encoding === 'identity' && /^\d{1,15}$/.test(declared) ? Number(declared) : null;
    if (knownSize !== null && knownSize > budget) {
      ctl.abort();
      return { ok: false, size: knownSize };
    }
    const reader = res.body.getReader();
    let read = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { ok: true };
      read += value.byteLength;
      if (read > budget) {
        ctl.abort();
        return { ok: false, size: knownSize };
      }
    }
  } catch {
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The witness's own words, e.g. "recall: host mismatch", out of a longer error text. */
export function witnessMessageIn(text: string): string | null {
  const m = /recall: [^"\n]*/.exec(text);
  if (!m) return null;
  let msg = m[0].trimEnd();
  // Drop closing brackets that belong to the wrapping error text, not to the message.
  const count = (c: string) => msg.split(c).length - 1;
  while (/[)\]]$/.test(msg) && count('(') + count('[') < count(')') + count(']'))
    msg = msg.slice(0, -1).trimEnd();
  return msg.replace(/[.,;:]+$/, '');
}

/** Witness messages that mean "try again shortly" (admission control and connect timeout). */
const WITNESS_BUSY = /witness busy|too many sessions|prover did not connect in time/;

/** Rejects with `message` if `p` has not settled after `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Maps a failed capture to one message and a code for the popup. The witness's
 * `recall: ...` message wins (verbatim), then the prover's error text.
 */
export function classifyFailure(err: unknown, witnessError: string | null): CaptureFailure {
  const raw = errText(err);
  const fromWitness =
    (witnessError ? witnessMessageIn(witnessError) : null) ?? witnessMessageIn(raw);
  if (fromWitness) {
    if (/maxRecvData too large/.test(fromWitness)) return { error: fromWitness, code: 'too_large' };
    if (WITNESS_BUSY.test(fromWitness)) return { error: fromWitness, code: 'busy' };
    return { error: fromWitness, code: 'failed' };
  }
  const text = witnessError ? `${witnessError} (${raw})` : raw;
  if (/WebSocket connection failed|closed the session before registering/i.test(raw)) {
    return { error: 'the witness is offline or unreachable', code: 'witness_offline' };
  }
  // tlsn-wasm: "attempted to receive more data than was configured, increase `max_recv`".
  if (
    /max_recv_data|max_recv\b|more data than was configured|exceeds? (the )?max|too much data|recv data limit/i.test(
      raw,
    )
  ) {
    return { error: 'page too large (over 64 KB)', code: 'too_large' };
  }
  if (/protocol ?version|PeerIncompatible|handshake ?failure|unsupported.*tls/i.test(raw)) {
    return { error: text, code: 'tls' };
  }
  return { error: text, code: 'failed' };
}
