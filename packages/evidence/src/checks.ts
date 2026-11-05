import { sha256, type Address, type Hex } from 'viem';
import { recoverWitness, statementFromJson, type Statement } from './statement';
import { headerValue, headerValues, parseRequest, parseResponse } from './http';
import { canonicalUrl, urlHash } from './url';
import { base64ToBytes, type EvidenceFile } from './evidence';

export type CheckResult = { status: 'pass' | 'fail' | 'warn' | 'unavailable'; detail: string };

export type VerifiedFacts = {
  canonicalUrl: string;
  urlHash: Hex;
  /** Exactly as signed by the witness (not lower-cased). */
  serverName: string;
  httpStatus: number;
  bodySha256: Hex;
  body: Uint8Array;
  contentType?: string;
  signedAt: bigint;
  witness: Address;
};

export type CheckOptions = {
  pinnedWitnesses: readonly Address[];
  /** A file the user holds; check D compares its hash with the captured body. */
  userFileBytes?: Uint8Array;
};

export type CheckReport = {
  A: CheckResult;
  B: CheckResult;
  C: CheckResult;
  D?: CheckResult;
  facts?: VerifiedFacts;
};

/**
 * Request headers a capture may send (ruling R20). Anything else could change
 * WHAT the server returns (Range, If-*, X-Original-URL, X-HTTP-Method-Override,
 * Forwarded, cookies, auth ...) while the evidence claims the plain URL.
 * `Accept-Encoding`, when present, must be exactly `identity`.
 */
export const ALLOWED_REQUEST_HEADERS = [
  'Host',
  'Accept',
  'Accept-Encoding',
  'Accept-Language',
  'User-Agent',
  'Connection',
] as const;
const ALLOWED_LOWER = new Set(ALLOWED_REQUEST_HEADERS.map((h) => h.toLowerCase()));

const ok = (detail: string): CheckResult => ({ status: 'pass', detail });
const no = (detail: string): CheckResult => ({ status: 'fail', detail });
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function checkA(s: Statement, sent: Uint8Array, recv: Uint8Array): CheckResult {
  for (const [name, bytes, len, hash] of [
    ['sent', sent, s.sentLen, s.sentSha256],
    ['recv', recv, s.recvLen, s.recvSha256],
  ] as const) {
    if (bytes.length !== len) {
      return no(`${name} length is ${bytes.length}, the statement says ${len}`);
    }
    if (sha256(bytes) !== hash) return no(`${name} sha256 does not match the statement`);
  }
  return ok(`transcript matches the signed hashes (${sent.length} sent, ${recv.length} received bytes)`);
}

type Parsed = {
  canonicalUrl: string;
  httpStatus: number;
  body: Uint8Array;
  bodySha256: Hex;
  contentType?: string;
};

function checkB(s: Statement, sent: Uint8Array, recv: Uint8Array): { result: CheckResult; parsed?: Parsed } {
  let req;
  try {
    req = parseRequest(sent);
  } catch (e) {
    return { result: no(msg(e)) };
  }
  const extra = req.headers.find(([n]) => !ALLOWED_LOWER.has(n.toLowerCase()));
  if (extra) {
    return {
      result: no(
        `the request header ${extra[0]} is not allowed (only ${ALLOWED_REQUEST_HEADERS.join(', ')})`,
      ),
    };
  }
  const enc = req.headers.find(([n, v]) => n.toLowerCase() === 'accept-encoding' && v.toLowerCase() !== 'identity');
  if (enc) return { result: no(`the request Accept-Encoding is ${enc[1]}, it must be identity`) };
  if (req.host.toLowerCase() !== s.serverName.toLowerCase()) {
    return { result: no(`Host ${req.host} does not match the signed server name ${s.serverName}`) };
  }
  let url: string;
  try {
    url = canonicalUrl(`https://${s.serverName}${req.target}`);
  } catch (e) {
    return { result: no(msg(e)) };
  }
  let res;
  try {
    res = parseResponse(recv);
  } catch (e) {
    return { result: no(msg(e)) };
  }
  if (res.status === 206 || headerValue(res.headers, 'content-range') !== undefined) {
    return { result: no('the response is partial content (206 or Content-Range), not the whole page') };
  }
  if (!res.complete) {
    return { result: no('the response is incomplete (its length is not proven by its framing)') };
  }
  const bad = headerValues(res.headers, 'content-encoding').find((v) => v.trim().toLowerCase() !== 'identity');
  if (bad !== undefined) {
    return { result: no(`the response has Content-Encoding: ${bad}, so the body is not the raw page`) };
  }
  const parsed: Parsed = {
    canonicalUrl: url,
    httpStatus: res.status,
    body: res.body,
    bodySha256: sha256(res.body),
    contentType: headerValue(res.headers, 'content-type'),
  };
  return {
    result: ok(`GET ${url} returned ${res.status} with a complete ${res.body.length}-byte body`),
    parsed,
  };
}

async function checkC(
  s: Statement,
  e: EvidenceFile,
  pinned: readonly Address[],
): Promise<{ result: CheckResult; witness?: Address }> {
  let recovered: Address;
  try {
    recovered = await recoverWitness(s, e.signature);
  } catch (err) {
    return { result: no(`invalid signature: ${msg(err)}`) };
  }
  if (recovered.toLowerCase() !== String(e.signer).toLowerCase()) {
    return { result: no(`the signature recovers to ${recovered}, not the stated signer ${e.signer}`) };
  }
  if (pinned.some((p) => p.toLowerCase() === recovered.toLowerCase())) {
    return { result: ok(`signed by pinned witness ${recovered}`), witness: recovered };
  }
  return {
    result: { status: 'warn', detail: `unknown witness ${recovered}` },
    witness: recovered,
  };
}

/**
 * Runs the offline checks on an evidence file.
 * A: transcript hashes and lengths match the statement. B: the request (only
 * allowlisted headers) and response (whole, not 206) are well-formed and
 * consistent with the signed server name.
 * C: the EIP-712 signature recovers to the stated signer, who is pinned (else
 * `warn`). D: a user-held file's hash equals the captured body's.
 * `facts` is present only if A and B pass and C is not a failure.
 */
export async function runChecks(e: EvidenceFile, opts: CheckOptions): Promise<CheckReport> {
  let statement: Statement;
  try {
    statement = statementFromJson(e.statement);
  } catch (err) {
    const f = no(msg(err));
    return { A: f, B: f, C: f };
  }

  let sent: Uint8Array | undefined;
  let recv: Uint8Array | undefined;
  try {
    sent = base64ToBytes(e.transcript.sent);
    recv = base64ToBytes(e.transcript.recv);
  } catch {
    sent = recv = undefined;
  }

  const A = sent && recv ? checkA(statement, sent, recv) : no('transcript is not valid base64');
  const b = sent && recv ? checkB(statement, sent, recv) : { result: no('transcript is not valid base64') };
  const c = await checkC(statement, e, opts.pinnedWitnesses);
  const report: CheckReport = { A, B: b.result, C: c.result };

  const trusted = A.status === 'pass' && b.result.status === 'pass' && b.parsed !== undefined;
  if (opts.userFileBytes !== undefined) {
    if (trusted) {
      report.D =
        sha256(opts.userFileBytes) === b.parsed!.bodySha256
          ? ok('the file is byte for byte the captured body')
          : no('the file differs from the captured body');
    } else {
      report.D = { status: 'unavailable', detail: 'checks A and B must pass before a file can be compared' };
    }
  }

  if (trusted && c.result.status !== 'fail' && c.witness) {
    const p = b.parsed!;
    report.facts = {
      canonicalUrl: p.canonicalUrl,
      urlHash: urlHash(p.canonicalUrl),
      serverName: statement.serverName,
      httpStatus: p.httpStatus,
      bodySha256: p.bodySha256,
      body: p.body,
      ...(p.contentType !== undefined ? { contentType: p.contentType } : {}),
      signedAt: statement.signedAt,
      witness: c.witness,
    };
  }
  return report;
}
