// Runs one capture in the offscreen document: MPC-TLS against the witness, which
// verifies the session and signs the EIP-712 statement; the result is an evidence file.
import { buildEvidence, statementFromJson } from '@recall/evidence';
import { ProveManager } from '../offscreen/ProveManager';
import { RECALL_DEV } from './build';
import {
  CAPTURE_HANDLERS,
  MAX_RECV_DATA,
  MAX_SENT_DATA,
  captureTarget,
  classifyFailure,
  precheckSize,
  proxyUrlFor,
  randomNonce,
  requestHeaders,
  revealPlan,
  tooLarge,
  type CaptureFailure,
  type CaptureOutcome,
  type CaptureOverrides,
  type CaptureStep,
} from './captureParts';

export type { CaptureOverrides, CaptureOutcome, CaptureFailure, CaptureStep } from './captureParts';

export type CaptureOptions = {
  witnessUrl: string;
  maxRecvData?: number;
  /** Dev builds only; ignored in release builds. */
  overrides?: CaptureOverrides;
  onStep?: (step: CaptureStep) => void;
  signal?: AbortSignal;
};

let manager: Promise<ProveManager> | undefined;

/** The offscreen document's one ProveManager (owns the tlsn-wasm worker). */
export function proveManager(): Promise<ProveManager> {
  manager ??= (async () => {
    const pm = new ProveManager();
    await pm.init();
    return pm;
  })();
  return manager;
}

const cancelled = (): CaptureFailure => ({ error: 'capture cancelled', code: 'cancelled' });

/**
 * Captures `url` through the witness at `witnessUrl`. Mode MPC, both directions fully
 * revealed, a fresh 32-byte nonce. Resolves with the evidence file, or with the
 * witness's rejection message (verbatim) / a classified error. Never throws.
 */
export async function captureUrl(url: string, opts: CaptureOptions): Promise<CaptureOutcome> {
  const overrides = RECALL_DEV ? opts.overrides : undefined;
  const maxRecvData = opts.maxRecvData ?? MAX_RECV_DATA;
  const target = captureTarget(url);
  if (!(target instanceof URL)) return target;
  let witness: URL;
  try {
    witness = new URL(opts.witnessUrl);
    if (witness.protocol !== 'http:' && witness.protocol !== 'https:') throw new Error();
  } catch {
    return {
      error: 'the witness address in settings is not an http(s) URL',
      code: 'witness_offline',
    };
  }

  opts.onStep?.(1);
  const size = await precheckSize(target.href, maxRecvData);
  if (!size.ok) return tooLarge(size.size, maxRecvData);
  if (opts.signal?.aborted) return cancelled();

  // The mode is fixed here, never read from session data or settings: MPC. Only the
  // dev-build test override may ask for Proxy, to prove the witness refuses it.
  const mode = overrides?.mode === 'Proxy' ? 'Proxy' : 'Mpc';
  const host = target.hostname;
  const nonce = randomNonce();
  let pm: ProveManager;
  let proverId: string;
  try {
    pm = await proveManager();
    proverId = await pm.newProver(host, maxRecvData, MAX_SENT_DATA, mode);
  } catch (err) {
    return classifyFailure(err, null);
  }
  const onAbort = () => void pm.abort(proverId);
  opts.signal?.addEventListener('abort', onAbort);
  try {
    // The only session data the witness gets is ours: the nonce it signs.
    const sessionData = { nonce };
    const verifierWsUrl = await pm.openSession(
      proverId,
      witness.href,
      maxRecvData,
      MAX_SENT_DATA,
      sessionData,
    );
    opts.onStep?.(2);
    await pm.setupProver(proverId, verifierWsUrl);

    const sessionId = pm.getSessionId(proverId);
    if (!sessionId) throw new Error('the witness session was lost');
    // Proxy mode routes the server traffic through the witness itself (refused by it).
    const proxyUrl = mode === 'Proxy' ? undefined : proxyUrlFor(witness.href, host, sessionId);
    await pm.sendRequest(proverId, proxyUrl, {
      url: target.href,
      method: 'GET',
      headers: requestHeaders(target, navigator.userAgent, overrides),
    });

    const computed = await pm.computeReveal(proverId, CAPTURE_HANDLERS);
    const plan = revealPlan(computed, pm.getRecvBytes(proverId).length, overrides);
    await pm.sendRevealConfig(proverId, {
      sent: plan.sentWithHandlers,
      recv: plan.recvWithHandlers,
    });
    await pm.reveal(proverId, { sent: plan.sent, recv: plan.recv }, plan.commit);

    const response = await pm.getResponse(proverId);
    const attestation = response?.attestation;
    // A session without the witness's signature is not a capture.
    if (!attestation) throw new Error('the witness returned no signature');
    const statement = statementFromJson(attestation.message);
    if (statement.nonce.toLowerCase() !== nonce)
      throw new Error('the witness signed a different nonce');
    if (statement.serverName.toLowerCase() !== host)
      throw new Error('the witness signed a different server name');

    const evidence = buildEvidence({
      statement,
      signature: attestation.signature,
      signer: attestation.signer,
      sent: pm.getSentBytes(proverId),
      recv: pm.getRecvBytes(proverId),
      capturedUrl: target.href,
    });
    return { evidence };
  } catch (err) {
    if (opts.signal?.aborted) return cancelled();
    return classifyFailure(err, await pm.witnessError(proverId, 2_000));
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    await pm.cleanupProver(proverId);
  }
}
