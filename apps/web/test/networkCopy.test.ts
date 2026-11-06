import { describe, expect, it } from 'vitest';
import { isLikelyNetworkFailure } from '@recall/net';
import { UPLOAD_NETWORK_COPY, publishNetworkCopy } from '../src/networkCopy';

describe('network failure wording', () => {
  it('the upload: the capture is kept, try again on a stronger connection', () => {
    expect(UPLOAD_NETWORK_COPY.title).toBe("The upload couldn't finish on this connection");
    expect(UPLOAD_NETWORK_COPY.body).toBe('Your capture is kept. Try the upload again on a stronger connection.');
    expect(UPLOAD_NETWORK_COPY.retryLabel).toBe('Try upload again');
  });

  it('the publish: "nothing was written" only before the wallet sent the transaction', () => {
    expect(publishNetworkCopy(false)).toEqual({
      title: "Couldn't reach the network to publish",
      body: 'Nothing was written. Try again.',
    });
    const after = publishNetworkCopy(true);
    expect(after.title).toBe("Couldn't reach the network to publish");
    expect(after.body).not.toMatch(/Nothing was written/);
    expect(after.body).toMatch(/may already have been written/);
  });
});

// The reasons the publish page gets: the extension's upload reason, this page's own wait limit,
// the gateway download that checks the upload, and viem's errors for the Arkiv write and reads.
describe('what the publish page treats as a network failure', () => {
  it.each([
    'the upload to Swarm failed: POST /chunks: HTTP 502 Bad Gateway',
    'the upload to Swarm failed: the upload did not finish within 120 s',
    'the upload did not finish in time',
    'The uploaded code couldn\'t be downloaded to check it: download of 0xab failed: https://gw.example: 504',
    'Timed out while waiting for transaction with hash "0x1234" to be confirmed.',
    'The request took too long to respond.',
    'HTTP request failed.\n\nStatus: 503\nURL: https://rpc.example\nDetails: Service Unavailable',
    'Failed to fetch',
  ])('%s', (text) => {
    expect(isLikelyNetworkFailure(new Error(text))).toBe(true);
  });

  it.each([
    'the upload to Swarm failed: POST /chunks: HTTP 500 down',
    'the node refused the upload (status 403)',
    'the repository snapshot in the extension does not match the checked one',
    'User rejected the request.',
    'MetaMask not found. Install it, then reload this page.',
    'Another record from this account was written at the same moment',
    'another key than predicted',
    'the upload did not start',
  ])('not: %s', (text) => {
    expect(isLikelyNetworkFailure(new Error(text))).toBe(false);
  });
});
