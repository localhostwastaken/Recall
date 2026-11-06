// Recomputes a repository tarball's git tree hash off the main thread (R46), so the page stays
// responsive while 15 MB are inflated and hashed. Same function as on the main thread.
import { gitTreeFromTarGz } from '@recall/evidence';

self.onmessage = (e: MessageEvent<Uint8Array>) => {
  try {
    self.postMessage({ ok: true, tree: gitTreeFromTarGz(e.data) });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
