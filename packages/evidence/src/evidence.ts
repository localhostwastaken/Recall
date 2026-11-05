import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { statementFromJson, statementToJson, type Statement, type StatementJson } from './statement';
import { parseRequest } from './http';
import { canonicalUrl } from './url';

export type EvidenceFile = {
  schema: 'recall.evidence.v1';
  statement: StatementJson;
  signature: Hex;
  signer: Address;
  /** Base64 of the fully revealed TLS plaintext in each direction. */
  transcript: { sent: string; recv: string };
  /** Unverified hints for humans; display and indexing use only verified facts. */
  meta: { capturedUrl: string; size: number };
};

export function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(s: string): Uint8Array {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('invalid base64');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type BuildEvidenceInput = {
  statement: Statement;
  signature: Hex;
  signer: Address;
  sent: Uint8Array;
  recv: Uint8Array;
  /** The URL the user captured. Defaults to the one derived from the request. */
  capturedUrl?: string;
};

/** `meta.size` is the number of response transcript bytes (what the capture size cap counts). */
export function buildEvidence(i: BuildEvidenceInput): EvidenceFile {
  let capturedUrl = i.capturedUrl;
  if (capturedUrl === undefined) {
    try {
      capturedUrl = canonicalUrl(`https://${i.statement.serverName}${parseRequest(i.sent).target}`);
    } catch {
      capturedUrl = '';
    }
  }
  return {
    schema: 'recall.evidence.v1',
    statement: statementToJson(i.statement),
    signature: i.signature,
    signer: i.signer,
    transcript: { sent: bytesToBase64(i.sent), recv: bytesToBase64(i.recv) },
    meta: { capturedUrl, size: i.recv.length },
  };
}

/** JSON that starts with `{"schema"`: the public gateway blocks content that looks like HTML. */
export function encodeEvidence(e: EvidenceFile): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schema: e.schema,
      statement: e.statement,
      signature: e.signature,
      signer: e.signer,
      transcript: { sent: e.transcript.sent, recv: e.transcript.recv },
      meta: { capturedUrl: e.meta.capturedUrl, size: e.meta.size },
    }),
  );
}

const bad = (m: string): never => {
  throw new Error(`invalid evidence file: ${m}`);
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function base64Field(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string' || v.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) {
    bad(`transcript.${k} must be base64`);
  }
  return v as string;
}

/** Parses and validates an evidence file. Throws on any malformed field. */
export function decodeEvidence(b: Uint8Array): EvidenceFile {
  let o: unknown;
  try {
    o = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b));
  } catch {
    return bad('not JSON');
  }
  if (!isObject(o)) bad('not an object');
  const e = o as Record<string, unknown>;
  if (e.schema !== 'recall.evidence.v1') bad('unknown schema');
  const statement = statementToJson(statementFromJson(e.statement));
  if (typeof e.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(e.signature)) {
    bad('signature must be 65 bytes of hex');
  }
  if (typeof e.signer !== 'string' || !isAddress(e.signer, { strict: false })) bad('signer');
  if (!isObject(e.transcript)) bad('transcript');
  const t = e.transcript as Record<string, unknown>;
  if (!isObject(e.meta)) bad('meta');
  const meta = e.meta as Record<string, unknown>;
  if (typeof meta.capturedUrl !== 'string') bad('meta.capturedUrl');
  if (typeof meta.size !== 'number' || !Number.isSafeInteger(meta.size) || meta.size < 0) bad('meta.size');
  return {
    schema: 'recall.evidence.v1',
    statement,
    signature: (e.signature as string).toLowerCase() as Hex,
    signer: getAddress(e.signer as string),
    transcript: { sent: base64Field(t, 'sent'), recv: base64Field(t, 'recv') },
    meta: { capturedUrl: meta.capturedUrl as string, size: meta.size as number },
  };
}
