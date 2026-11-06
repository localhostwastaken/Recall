import { describe, expect, it } from 'vitest';
import { isLikelyNetworkFailure } from '../../src/recall/errors';
import { GITHUB_UNREADABLE, SNAPSHOT_MISMATCH } from '../../src/recall/gitRepo';
import { NO_BATCH, UPLOAD_BUSY } from '../../src/recall/pendingUpload';

// The strings below are the ones the code produces (ProveManager, the worker, chunkPush,
// swarmUpload, repoSnapshot, @recall/net) or that the browser raises under them.

describe('isLikelyNetworkFailure: what a slow or broken network looks like', () => {
  it.each([
    // the tlsn worker and ProveManager (MPC setup is 90 s, the request 60 s)
    'setupProver timed out after 90000ms for prover-1',
    'sendRequest timed out after 60000ms for prover-1',
    'Verification response timed out after 60000ms for prover: prover-1',
    'WebSocket connection failed',
    'WebSocket connection failed: wss://w.trycloudflare.com/proxy?token=a.example&sessionId=x',
    'the witness closed the session before registering it',
    'the witness closed the session without a result',
    'Session WebSocket not open for prover: prover-1',
    'Reveal config send failed for prover prover-1: verifier connection was closed',
    'WebSocket is closed',
    'Verification failed: Run failed: internal error: mpc-tls execution failed caused by: I/O error: unexpected end of file',
    // fetch, in the three engines
    'Failed to fetch',
    'Load failed',
    'NetworkError when attempting to fetch resource.',
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_CONNECTION_RESET',
    'Fetch failed: net::ERR_NETWORK_CHANGED',
    'read ECONNRESET',
    'connect ETIMEDOUT 203.0.113.7:443',
    // uploads: chunk pushes, the gateway, the extension's own limits
    'POST /chunks: HTTP 502 Bad Gateway',
    'POST /chunks: HTTP 503 Service Unavailable',
    'POST /chunks: HTTP 504',
    'POST /chunks: HTTP 429 slow down',
    'the upload to Swarm failed: Bad Gateway: <html>502</html>',
    'the upload to Swarm failed: Request aborted',
    'the upload to Swarm failed: the upload did not finish within 120 s',
    'the upload did not finish within 120 s',
    'free upload failed: 503',
    `download of 0x${'ab'.repeat(32)} failed: https://gw.example: 502; https://gw2.example: 504`,
    'the code did not download within 60 s',
    'the code could not be downloaded (HTTP 503)',
    'the storage batches could not be checked on Gnosis',
  ])('%s', (text) => {
    expect(isLikelyNetworkFailure(text)).toBe(true);
    expect(isLikelyNetworkFailure(new Error(text))).toBe(true);
  });

  it('reads the name and the cause of an error object (fetch and viem wrap the real reason)', () => {
    expect(isLikelyNetworkFailure(new DOMException('signal timed out', 'TimeoutError'))).toBe(true);
    expect(
      isLikelyNetworkFailure(new DOMException('The operation was aborted.', 'AbortError')),
    ).toBe(true);
    expect(
      isLikelyNetworkFailure(
        new TypeError('fetch failed', { cause: new Error('connect ETIMEDOUT') }),
      ),
    ).toBe(true);
    const viemLike = Object.assign(
      new Error(
        'HTTP request failed.\n\nStatus: 503\nURL: https://rpc.example\nDetails: Service Unavailable',
      ),
      {
        shortMessage: 'HTTP request failed.',
      },
    );
    expect(isLikelyNetworkFailure(viemLike)).toBe(true);
    expect(
      isLikelyNetworkFailure(
        Object.assign(new Error('x'), {
          name: 'TimeoutError',
          shortMessage: 'The request took too long to respond.',
        }),
      ),
    ).toBe(true);
  });
});

describe('isLikelyNetworkFailure: real failures are never relabelled', () => {
  it.each([
    // the witness's own verdicts, even when a timeout word is near
    'recall: cookies/auth not allowed',
    'recall: host mismatch',
    'recall: maxRecvData too large (limit 65536)',
    'recall: witness busy, try again shortly',
    'recall: prover did not connect in time',
    'prover error: proving rejected by verifier caused by: recall: commitments not allowed)',
    // checks, mismatches, size, the witness's signature
    "A check failed. Don't rely on this capture.",
    'page too large (over 64 KB)',
    'page too large (98.2 KB > 64 KB)',
    'the witness returned no signature',
    'the witness signed a different nonce',
    'the witness signed a different server name',
    'capture failed: transcript unavailable',
    'the evidence could not be checked: the checks did not finish within 15 s',
    SNAPSHOT_MISMATCH,
    GITHUB_UNREADABLE,
    'the repository snapshot in the extension does not match the checked one',
    'the repository is too large (over 25 MB)',
    // the upload node's own answers, and our own states
    'the node refused the upload (status 403)',
    'POST /chunks: HTTP 500 down',
    'free upload failed: 500',
    'the upload to Swarm failed: a bucket of this batch is full',
    'no storage batch has enough time left',
    NO_BATCH,
    UPLOAD_BUSY,
    'capture cancelled',
    'upload cancelled',
    'GitHub is rate-limiting requests; try again later',
    'GitHub answered HTTP 500',
    'the witness is offline',
    '',
  ])('%s', (text) => {
    expect(isLikelyNetworkFailure(text)).toBe(false);
  });

  it('a hex hash holding 429 or 503 is not an HTTP status', () => {
    expect(
      isLikelyNetworkFailure(
        `reference mismatch (returned bytes do not hash to 0x${'4294'.repeat(16)})`,
      ),
    ).toBe(false);
    expect(isLikelyNetworkFailure(new Error('signedAt 1793800503 is in the future'))).toBe(false);
    expect(isLikelyNetworkFailure(undefined)).toBe(false);
    expect(isLikelyNetworkFailure(null)).toBe(false);
  });
});
