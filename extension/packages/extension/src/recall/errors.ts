// Tells a failure caused by a slow or unstable network from every other failure, so the popup
// can say "your connection" instead of showing a raw error. The matching itself is shared with
// the web app's publish page (packages/net/src/network.ts); this is its home in the extension.
// A witness verdict ("recall: ...") and a failed check are never network failures.
export { isLikelyNetworkFailure } from '@recall/net/network';
