import {
  hashTypedData,
  isHex,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';

export const WITNESS_DOMAIN = { name: 'Recall Witness', version: '1' } as const;

export const CAPTURE_TYPES = {
  Capture: [
    { name: 'serverName', type: 'string' },
    { name: 'connTime', type: 'uint64' },
    { name: 'signedAt', type: 'uint64' },
    { name: 'sentSha256', type: 'bytes32' },
    { name: 'recvSha256', type: 'bytes32' },
    { name: 'sentLen', type: 'uint32' },
    { name: 'recvLen', type: 'uint32' },
    { name: 'tlsVersion', type: 'uint8' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** connTime and signedAt are Unix seconds; tlsVersion is 12 for TLS 1.2 (13 reserved for 1.3). */
export type Statement = {
  serverName: string;
  connTime: bigint;
  signedAt: bigint;
  sentSha256: Hex;
  recvSha256: Hex;
  sentLen: number;
  recvLen: number;
  tlsVersion: number;
  nonce: Hex;
};

export type StatementJson = {
  serverName: string;
  connTime: string;
  signedAt: string;
  sentSha256: Hex;
  recvSha256: Hex;
  sentLen: number;
  recvLen: number;
  tlsVersion: number;
  nonce: Hex;
};

const typed = (s: Statement) => ({
  domain: WITNESS_DOMAIN,
  types: CAPTURE_TYPES,
  primaryType: 'Capture' as const,
  message: s,
});

export function hashStatement(s: Statement): Hex {
  return hashTypedData(typed(s));
}

export function recoverWitness(s: Statement, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ ...typed(s), signature });
}

export function statementToJson(s: Statement): StatementJson {
  return {
    serverName: s.serverName,
    connTime: s.connTime.toString(10),
    signedAt: s.signedAt.toString(10),
    sentSha256: s.sentSha256,
    recvSha256: s.recvSha256,
    sentLen: s.sentLen,
    recvLen: s.recvLen,
    tlsVersion: s.tlsVersion,
    nonce: s.nonce,
  };
}

const U64_MAX = (1n << 64n) - 1n;

function bad(msg: string): never {
  throw new Error(`invalid statement: ${msg}`);
}

function hex32(o: Record<string, unknown>, k: string): Hex {
  const v = o[k];
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v) || !isHex(v)) {
    bad(`${k} must be 0x + 64 hex chars`);
  }
  return (v as string).toLowerCase() as Hex;
}

function u64(o: Record<string, unknown>, k: string): bigint {
  const v = o[k];
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) bad(`${k} must be a decimal string`);
  const n = BigInt(v as string);
  if (n > U64_MAX) bad(`${k} exceeds uint64`);
  return n;
}

function uint(o: Record<string, unknown>, k: string, max: number): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) {
    bad(`${k} must be an integer in 0..${max}`);
  }
  return v as number;
}

export function statementFromJson(json: unknown): Statement {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) bad('not an object');
  const o = json as Record<string, unknown>;
  if (typeof o.serverName !== 'string' || o.serverName.length === 0) bad('serverName');
  return {
    serverName: o.serverName,
    connTime: u64(o, 'connTime'),
    signedAt: u64(o, 'signedAt'),
    sentSha256: hex32(o, 'sentSha256'),
    recvSha256: hex32(o, 'recvSha256'),
    sentLen: uint(o, 'sentLen', 0xffffffff),
    recvLen: uint(o, 'recvLen', 0xffffffff),
    tlsVersion: uint(o, 'tlsVersion', 255),
    nonce: hex32(o, 'nonce'),
  };
}
