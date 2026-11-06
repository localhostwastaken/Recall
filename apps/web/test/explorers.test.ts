import { LOCAL, liveConfig, type NetConfig } from '@recall/net';
import { describe, expect, it } from 'vitest';
import {
  arkivAddressUrl,
  arkivEntityUrl,
  attachmentLinks,
  gnosisTxUrl,
  recordLinks,
  swarmBytesUrl,
} from '../src/explorers';

const KEY = '0x617c879872510fe0c67931aa7530413172ac402bbb0f97f048dca046fee24436';
const REF = '0xAB' + 'cd'.repeat(31);
const TX = '0x' + '12'.repeat(32);
const OWNER = '0x2dB5' + '0'.repeat(32) + 'A503';
const live = liveConfig({});

describe('explorer links', () => {
  it('point at the Arkiv explorer, the first Swarm gateway and Gnosisscan on the live network', () => {
    expect(arkivEntityUrl(live, KEY)).toBe(`https://rabdi.explorer.arkiv.network/entity/${KEY}`);
    expect(arkivAddressUrl(live, OWNER)).toBe(`https://rabdi.explorer.arkiv.network/address/${OWNER}`);
    expect(gnosisTxUrl(live, TX)).toBe(`https://gnosisscan.io/tx/${TX}`);
    expect(swarmBytesUrl(live, REF)).toBe(`https://download.gateway.ethswarm.org/bytes/ab${'cd'.repeat(31)}`);
  });

  it('are never shown on the local devnet (no explorers configured)', () => {
    expect(arkivEntityUrl(LOCAL, KEY)).toBeNull();
    expect(arkivAddressUrl(LOCAL, OWNER)).toBeNull();
    expect(gnosisTxUrl(LOCAL, TX)).toBeNull();
    expect(swarmBytesUrl(LOCAL, REF)).toBeNull();
    expect(recordLinks(LOCAL, { entityKey: KEY, evidenceRef: REF, owner: OWNER })).toEqual([]);
    expect(attachmentLinks(LOCAL, { entityKey: KEY, evidenceRef: REF })).toEqual([]);
  });

  it('use the first download gateway the person set, without a trailing slash', () => {
    const cfg: NetConfig = { ...live, swarm: { ...live.swarm, downloadUrls: ['https://my.gateway/', 'https://bzz.link'] } };
    expect(swarmBytesUrl(cfg, REF)).toBe(`https://my.gateway/bytes/ab${'cd'.repeat(31)}`);
  });

  it('refuse values that are not a key, a hash, an address or a real Swarm reference', () => {
    expect(arkivEntityUrl(live, '0x1234')).toBeNull();
    expect(arkivEntityUrl(live, undefined)).toBeNull();
    expect(arkivAddressUrl(live, KEY)).toBeNull();
    expect(gnosisTxUrl(live, null)).toBeNull();
    expect(swarmBytesUrl(live, '0x' + '0'.repeat(64))).toBeNull();
    expect(swarmBytesUrl(live, 'not-a-ref')).toBeNull();
    expect(swarmBytesUrl(live, `${REF}/../x`)).toBeNull();
  });

  it('ignore an explorer base that is not http(s)', () => {
    const cfg: NetConfig = { ...live, explorers: { arkiv: 'javascript:alert(1)', gnosis: 'ftp://x' } };
    expect(arkivEntityUrl(cfg, KEY)).toBeNull();
    expect(gnosisTxUrl(cfg, TX)).toBeNull();
    expect(swarmBytesUrl(cfg, REF)).toBeNull();
  });

  it('list the record links in order, leaving out the ones that cannot be built', () => {
    expect(recordLinks(live, { entityKey: KEY, evidenceRef: REF, owner: OWNER }).map((l) => l.label)).toEqual([
      'Record on Arkiv explorer',
      'Evidence file on Swarm',
      'Publisher on Arkiv explorer',
    ]);
    expect(recordLinks(live, { entityKey: KEY }).map((l) => l.label)).toEqual(['Record on Arkiv explorer']);
    expect(attachmentLinks(live, { entityKey: KEY, evidenceRef: REF }).map((l) => l.label)).toEqual([
      'Code record on Arkiv explorer',
      'Code archive on Swarm',
    ]);
  });
});
