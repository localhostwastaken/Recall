import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { privateKeyToAccount } from 'viem/accounts';
import { sha256, toBytes } from 'viem';
import { buildEvidence, bytesToBase64, CAPTURE_TYPES, runChecks, WITNESS_DOMAIN, type Statement } from '@recall/evidence';
import { evidenceItems, indexMetadataMatches, type Capture } from '../src/reader/evidenceView';
import { EvidencePanel } from '../src/reader/EvidencePanel';
import { StatusBadge } from '../src/ui/StatusBadge';
import { parseHash } from '../src/router';

// Synthetic, locally signed evidence. It is never included in the application.
const account = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`);
const zero = `0x${'0'.repeat(64)}` as const;
const body = 'Applications close on 15 December.';
const response = (text = body) => toBytes(`HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${toBytes(text).length}\r\n\r\n${text}`);

async function fixture() {
  const sent = toBytes('GET /notice HTTP/1.1\r\nHost: example.org\r\nAccept-Encoding: identity\r\n\r\n');
  const recv = response();
  const statement: Statement = { serverName: 'example.org', connTime: 1n, signedAt: 2n, sentSha256: sha256(sent), recvSha256: sha256(recv), sentLen: sent.length, recvLen: recv.length, tlsVersion: 12, nonce: zero };
  const signature = await account.signTypedData({ domain: WITNESS_DOMAIN, types: CAPTURE_TYPES, primaryType: 'Capture', message: statement });
  return buildEvidence({ statement, signature, signer: account.address, sent, recv });
}

describe('reader presentation of real verification outcomes', () => {
  it('keeps source, chain and permission unknown even when all implemented checks pass', async () => {
    const report = await runChecks(await fixture(), { pinnedWitnesses: [account.address] });
    const items = evidenceItems(report);
    expect(items.slice(0, 3).map(x => x.status)).toEqual(['pass', 'pass', 'pass']);
    expect(items.slice(3).map(x => x.status)).toEqual(['unknown', 'unknown', 'unknown']);
    const html = renderToStaticMarkup(<EvidencePanel report={report} />);
    expect(html).toContain('Not proven');
    expect(html).toContain('Not checked');
  });

  it('shows an unpinned but valid signature as an unknown witness', async () => {
    const report = await runChecks(await fixture(), { pinnedWitnesses: [] });
    expect(report.facts?.bodySha256).toBe(sha256(toBytes(body)));
    expect(evidenceItems(report)[2]).toMatchObject({ status: 'unknown', label: 'Unknown witness' });
    const html = renderToStaticMarkup(<EvidencePanel report={report} />);
    expect(html).toContain('Unknown witness');
    expect(html).toContain('does not pin that witness as trusted');
  });

  it('retains a failed integrity result for a tampered transcript and has no reading facts', async () => {
    const evidence = await fixture();
    evidence.transcript.recv = bytesToBase64(response(body.replace('15', '12')));
    const report = await runChecks(evidence, { pinnedWitnesses: [account.address] });
    expect(report.A.status).toBe('fail');
    expect(report.facts).toBeUndefined();
    expect(evidenceItems(report)[0].status).toBe('fail');
    expect(renderToStaticMarkup(<EvidencePanel report={report} />)).toContain('Failed');
  });

  it('does not downgrade an invalid signature to unknown', async () => {
    const evidence = await fixture();
    evidence.signer = '0x0000000000000000000000000000000000000000';
    const report = await runChecks(evidence, { pinnedWitnesses: [] });
    expect(evidenceItems(report)[2].status).toBe('fail');
    expect(report.facts).toBeUndefined();
  });

  it('keeps missing evidence unavailable, distinct from unimplemented checks and not applicable', () => {
    expect(evidenceItems().slice(0, 3).map(x => x.status)).toEqual(['unavailable', 'unavailable', 'unavailable']);
    expect(evidenceItems()[3].status).toBe('unknown');
    expect(renderToStaticMarkup(<StatusBadge status="unavailable" />)).toContain('Unavailable');
    expect(renderToStaticMarkup(<StatusBadge status="not-applicable" />)).toContain('Not applicable');
  });

  it('flags differing index metadata without changing the evidence check results', async () => {
    const report = await runChecks(await fixture(), { pinnedWitnesses: [account.address] });
    const facts = report.facts!;
    const row: Capture = { kind: 'capture', entityKey: zero, owner: account.address, expiresAtBlock: 10n, urlHash: facts.urlHash, bodySha256: facts.bodySha256, serverName: facts.serverName, witness: facts.witness, signedAt: facts.signedAt, httpStatus: facts.httpStatus, batchId: zero, evidenceRef: zero, canonicalUrl: facts.canonicalUrl };
    expect(indexMetadataMatches(row, report)).toBe(true);
    expect(indexMetadataMatches({ ...row, bodySha256: zero }, report)).toBe(false);
    expect(report.A.status).toBe('pass');
  });
});

describe('existing product routes', () => {
  it('retains landing, reader, settings and storage destinations', () => {
    expect(parseHash('#/')).toEqual({ name: 'home' });
    expect(parseHash('#/reader')).toEqual({ name: 'reader' });
    expect(parseHash('#/settings')).toEqual({ name: 'settings' });
    expect(parseHash('#/storage')).toEqual({ name: 'storage' });
  });
});
