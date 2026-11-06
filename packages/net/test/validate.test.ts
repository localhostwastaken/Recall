import { describe, expect, it } from 'vitest';
import { ADDRESS_ERROR, URL_ERROR, checkAddress, checkUrl, isSafeUrl } from '../src/validate';

describe('checkUrl', () => {
  it('accepts https URLs, and http only for localhost and 127.0.0.1', () => {
    for (const ok of [
      'https://rpc.gnosischain.com',
      'https://download.gateway.ethswarm.org/',
      'https://rpc.rabdi.db-chain.testnet.arkiv.network',
      'http://localhost:8545',
      'http://127.0.0.1:1633',
      'http://localhost',
      'https://example.org:8443/path',
    ]) {
      expect(checkUrl(ok).ok, ok).toBe(true);
    }
  });

  it('rejects other schemes, plain http, credentials and junk', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'file:///etc/passwd',
      'ws://localhost:8545',
      'wss://rpc.example',
      'ftp://example.org',
      'http://example.org',
      'http://localhost.evil.example',
      'http://127.0.0.1.evil.example',
      'http://192.168.0.1:8545',
      'https://user:pass@example.org',
      'https://user@example.org',
      'example.org',
      'localhost:8545',
      '//example.org',
      'https://',
      'https:// spaced.example',
      '',
      '   ',
    ]) {
      expect(checkUrl(bad).ok, bad).toBe(false);
    }
  });

  it('trims, and drops trailing slashes from plain addresses', () => {
    expect(checkUrl('  https://rpc.gnosischain.com/  ')).toEqual({ ok: true, value: 'https://rpc.gnosischain.com' });
    expect(checkUrl('https://a.example/path/')).toEqual({ ok: true, value: 'https://a.example/path' });
    expect(checkUrl('http://localhost:1633///')).toEqual({ ok: true, value: 'http://localhost:1633' });
  });

  it('isSafeUrl is the boolean form', () => {
    expect(isSafeUrl('https://a.example')).toBe(true);
    expect(isSafeUrl('javascript:1')).toBe(false);
    expect(isSafeUrl(42)).toBe(false);
    expect(isSafeUrl(undefined)).toBe(false);
  });

  it('has the brief copy', () => {
    expect(URL_ERROR).toBe('Enter a full address starting with https://');
  });
});

describe('checkAddress', () => {
  const sum = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
  const lower = sum.toLowerCase();

  it('accepts lower-case and correctly checksummed addresses, returning the checksummed form', () => {
    expect(checkAddress(lower)).toEqual({ ok: true, value: sum });
    expect(checkAddress(sum)).toEqual({ ok: true, value: sum });
    expect(checkAddress(`  ${sum}  `)).toEqual({ ok: true, value: sum });
  });

  it('rejects a mixed-case address with a wrong checksum', () => {
    const bad = sum.replace('3C44', '3c44'); // flips the case of two letters
    expect(bad).not.toBe(sum);
    expect(checkAddress(bad).ok).toBe(false);
  });

  it('rejects wrong lengths, missing 0x and non-hex', () => {
    for (const bad of [
      '',
      '0x',
      '0x1234',
      sum.slice(0, -1),
      `${sum}0`,
      sum.slice(2),
      sum.replace('0x', '0X'),
      `0x${'g'.repeat(40)}`,
      'vitalik.eth',
      `${sum} ${sum}`,
    ]) {
      expect(checkAddress(bad).ok, bad).toBe(false);
    }
  });

  it('has the brief copy', () => {
    expect(ADDRESS_ERROR).toBe('Enter a 0x address (42 characters).');
  });
});
