import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import vector from './vectors/statement-v1.json';
import {
  CAPTURE_TYPES,
  WITNESS_DOMAIN,
  hashStatement,
  recoverWitness,
  statementFromJson,
  statementToJson,
} from '../src/statement';

const v = vector as any;
const stmt = () => statementFromJson(v.statement);

describe('statement', () => {
  it('vector digest and signature are reproduced', async () => {
    expect(hashStatement(stmt())).toBe(v.digest);
    const account = privateKeyToAccount(v.privateKey);
    expect(account.address).toBe(v.signer);
    const sig = await account.signTypedData({
      domain: WITNESS_DOMAIN,
      types: CAPTURE_TYPES,
      primaryType: 'Capture',
      message: stmt(),
    });
    expect(sig).toBe(v.signature);
    expect(await recoverWitness(stmt(), v.signature)).toBe(v.signer);
  });

  it('any field change changes the recovered signer', async () => {
    const s = { ...stmt(), recvSha256: `0x${'ab'.repeat(32)}` as const };
    expect(await recoverWitness(s, v.signature)).not.toBe(v.signer);
  });

  it('json round trip matches the vector shape', () => {
    expect(statementToJson(stmt())).toEqual(v.statement);
  });

  it('rejects malformed json and normalises hex case', () => {
    const j = v.statement;
    expect(() => statementFromJson({ ...j, sentSha256: '0x12' })).toThrow();
    expect(() => statementFromJson({ ...j, sentLen: 1.5 })).toThrow();
    expect(() => statementFromJson({ ...j, connTime: 5 })).toThrow();
    expect(() => statementFromJson({ ...j, nonce: undefined })).toThrow();
    expect(() => statementFromJson({ ...j, tlsVersion: 300 })).toThrow();
    expect(() => statementFromJson(null)).toThrow();
    const up = statementFromJson({ ...j, nonce: '0x' + 'AB'.repeat(32) });
    expect(up.nonce).toBe('0x' + 'ab'.repeat(32));
  });
});
