import { isAddress, type Address, type Hex } from 'viem';
import { getSettings } from './settings';

/** Why a message to the extension failed. */
export class ExtError extends Error {
  constructor(
    readonly kind: 'no-id' | 'unavailable' | 'unreachable' | 'timeout' | 'rejected',
    message: string,
  ) {
    super(message);
    this.name = 'ExtError';
  }
}

type ChromeRuntime = {
  sendMessage(extensionId: string, message: unknown, callback: (response: unknown) => void): void;
  lastError?: { message?: string };
};

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * `chrome.runtime.sendMessage(extensionId, msg)`. Pages can only do this when the extension
 * lists the page's origin in `externally_connectable` (http://localhost:5173 in dev builds).
 * The extension ID comes from settings.
 */
function send<T>(msg: unknown, opts: { extensionId?: string; timeoutMs?: number } = {}): Promise<T> {
  const extensionId = opts.extensionId ?? getSettings().extensionId;
  return new Promise<T>((resolve, reject) => {
    if (!extensionId) return reject(new ExtError('no-id', 'No extension ID is set.'));
    const runtime = (globalThis as unknown as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime;
    if (!runtime?.sendMessage) {
      return reject(new ExtError('unavailable', 'This browser cannot reach the Recall extension from this page.'));
    }
    const timer = setTimeout(
      () => reject(new ExtError('timeout', 'The Recall extension did not answer.')),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    try {
      runtime.sendMessage(extensionId, msg, (response) =>
        done(() => {
          const lastError = runtime.lastError;
          if (lastError) return reject(new ExtError('unreachable', lastError.message ?? 'Extension not reachable.'));
          const err = (response as { error?: unknown } | undefined)?.error;
          if (err) return reject(new ExtError('rejected', typeof err === 'string' ? err : 'The extension refused the request.'));
          resolve(response as T);
        }),
      );
    } catch (err) {
      // A malformed extension ID throws synchronously.
      done(() => reject(new ExtError('unreachable', err instanceof Error ? err.message : String(err))));
    }
  });
}

export const ext = { send };

/** The address of the extension's stamp key; it owns the batches the page buys. */
export async function getStampAddress(opts?: { extensionId?: string }): Promise<Address> {
  const res = await send<{ address?: string }>({ type: 'recall.getStampAddress' }, opts);
  if (!res?.address || !isAddress(res.address)) throw new ExtError('rejected', 'The extension returned no stamp address.');
  return res.address;
}

/**
 * Asks the extension who it is: the stamp address and, when it says so, its version. Settings
 * uses it to show "Connected · v<x>". An older extension answers without a version.
 */
export async function getExtensionInfo(opts?: { extensionId?: string }): Promise<{ address: Address; version?: string }> {
  const res = await send<{ address?: string; version?: unknown }>({ type: 'recall.getStampAddress' }, opts);
  if (!res?.address || !isAddress(res.address)) throw new ExtError('rejected', 'The extension returned no stamp address.');
  const version = typeof res.version === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(res.version) ? res.version : undefined;
  return { address: res.address, ...(version ? { version } : {}) };
}

export type PoolEntry = { batchId: Hex; used: boolean };

/** Hands bought batches to the extension's pool. */
export async function addBatches(batchIds: Hex[], opts?: { extensionId?: string }): Promise<PoolEntry[]> {
  const res = await send<{ pool: PoolEntry[] }>({ type: 'recall.addBatches', batchIds }, { timeoutMs: 15_000, ...opts });
  return res.pool;
}
