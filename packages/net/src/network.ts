// Tells a failure caused by a slow or broken network from every other failure, so the pages can
// say "your connection" instead of showing a raw error. Used by the extension (popup) and the
// web app (publish page). It only looks at the error text: it is a hint for wording, never a
// decision about security. A witness verdict ("recall: ...") is never a network failure.

/** How many `cause`s deep the text of an error is read (viem and fetch wrap the real reason). */
const CAUSE_DEPTH = 4;

/** The name, message and details of an error and of its causes, as one string. */
function textOf(e: unknown): string {
  if (typeof e === 'string') return e;
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < CAUSE_DEPTH && cur !== null && cur !== undefined; i++) {
    if (typeof cur !== 'object') {
      parts.push(String(cur));
      break;
    }
    const o = cur as Record<string, unknown>;
    for (const k of ['name', 'message', 'shortMessage', 'details', 'code'] as const) {
      const v = o[k];
      if (typeof v === 'string' || typeof v === 'number') parts.push(String(v));
    }
    cur = o.cause;
  }
  return parts.join('\n');
}

/** 502, 503, 504 and 429 as HTTP statuses: "HTTP 502", "Status: 503", "failed: 504", "gw: 429". */
const GATEWAY_STATUS = /(?:\bHTTP(?:\/[\d.]+)?\s*|\bstatus(?: code)?:?\s*|:\s)(?:502|503|504|429)(?!\d)/i;

const NETWORK_PATTERNS: RegExp[] = [
  // Timeouts and aborts: fetch's own, the worker's ("setupProver timed out after 90000ms"),
  // viem's ("The request took too long to respond"), Bee's ("Request aborted"), and the
  // extension's own limits on an upload or a code download.
  /\b(?:TimeoutError|AbortError)\b/,
  /\btime(?:d)?[ -]?out\b/i,
  /\btook too long\b/i,
  /\brequest aborted\b/i,
  /\bthe upload did not (?:finish|complete)\b/i,
  /\bthe code did not download\b/i,
  // A WebSocket that failed or was closed under a capture ("WebSocket connection failed",
  // "the witness closed the session before registering it", "WebSocket is closed").
  /\bweb ?socket\b/i,
  /\bclosed the session\b/i,
  /\bverifier connection was closed\b/i,
  // A fetch that never got an answer: Chrome, Firefox and Safari wording.
  /\bfailed to fetch\b/i,
  /\bfetch failed\b/i,
  /\bload failed\b/i,
  /\bnetworkerror\b/i,
  /\bnetwork (?:error|request failed)\b/i,
  /\bnetwork connection was lost\b/i,
  /\binternet connection appears to be offline\b/i,
  // Chrome's net::ERR_*, and Node-style socket codes.
  /\bnet::ERR_[A-Z_]+/,
  /\bERR_(?:INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_[A-Z_]+|TIMED_OUT|NAME_NOT_RESOLVED|EMPTY_RESPONSE|SOCKET_NOT_CONNECTED)\b/,
  /\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b/,
  /\bsocket hang up\b/i,
  /\bconnection (?:reset|closed|lost|refused)\b/i,
  /\bbroken pipe\b/i,
  // tlsn-wasm when the witness connection drops mid-MPC.
  /\bunexpected end of file\b/i,
  // A busy or failing gateway or RPC.
  GATEWAY_STATUS,
  /\b(?:bad gateway|service unavailable|gateway time-?out|too many requests)\b/i,
  // Every storage batch's lifetime read failed (the Gnosis RPC did not answer).
  /\bcould not be checked on gnosis\b/i,
];

/**
 * Whether `err` (an error, or the reason as text) most likely comes from a slow or unstable
 * network: a timeout, an abort, a failed fetch, a WebSocket that closed or failed,
 * `net::ERR_*`, a reset or timed out socket, or a gateway answering 502, 503, 504 or 429.
 *
 * A witness verdict ("recall: ...") is a decision, not a network problem, so it is never
 * matched; neither are failed checks, mismatches or a page that is too large.
 */
export function isLikelyNetworkFailure(err: unknown): boolean {
  const text = textOf(err);
  if (!text || /\brecall: /.test(text)) return false;
  return NETWORK_PATTERNS.some((re) => re.test(text));
}
