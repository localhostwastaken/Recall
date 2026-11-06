// Offscreen document: the repository snapshot of a notarized GitHub branch (R46, level 1).
// Downloads codeload's tar.gz of the commit (no cookies, size and time capped), recomputes its
// git tree id, which must equal the tree GitHub's notarized answer named, hashes the bytes and
// keeps them in IndexedDB under the captureId. Runs here, not in the service worker, so the
// heavy inflate and hashing never block it. Fails closed.
import { gitTreeFromTarGz } from '@recall/evidence';
import { putAttachment } from './attachmentStore';
import {
  REPO_DOWNLOAD_TIMEOUT_MS,
  REPO_MAX_BYTES,
  GITHUB_HOSTS,
  SNAPSHOT_MISMATCH,
  codeloadUrl,
  readCappedBody,
  sha256Hex,
} from './gitRepo';

/** Service worker -> offscreen: download and check one snapshot. Answered with the result. */
export type OffscreenRepoSnapshot = {
  type: 'recall.offscreen.repoSnapshot';
  /** The capture job id (a cancel of the job aborts the download). */
  id: string;
  captureId: string;
  owner: string;
  repo: string;
  commitSha: string;
  treeSha: string;
};

export type RepoSnapshotResult =
  | { ok: true; size: number; sha256: `0x${string}`; files: number }
  | { ok: false; error: string };

/** Offscreen -> service worker while downloading (keeps the job's step alive). */
export type RepoProgressMessage = { type: 'recall.repo.progress'; id: string; step: 4 | 5 };

export type SnapshotDeps = {
  fetch: typeof fetch;
  store: typeof putAttachment;
  onStep?: (step: 4 | 5) => void;
};

export async function repoSnapshot(
  req: OffscreenRepoSnapshot,
  signal: AbortSignal,
  deps: Partial<SnapshotDeps> = {},
): Promise<RepoSnapshotResult> {
  const f = deps.fetch ?? ((...a) => fetch(...a));
  const store = deps.store ?? putAttachment;
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  signal.addEventListener('abort', stop);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, REPO_DOWNLOAD_TIMEOUT_MS);
  try {
    deps.onStep?.(4);
    const url = codeloadUrl(req, req.commitSha);
    const res = await f(url, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      // codeload answers the tarball itself; a redirect is refused, never followed elsewhere.
      redirect: 'error',
      signal: ctl.signal,
    });
    if (res.url && new URL(res.url).hostname !== GITHUB_HOSTS.codeload) {
      return { ok: false, error: 'GitHub sent the code from an unexpected address' };
    }
    if (!res.ok) return { ok: false, error: `the code could not be downloaded (HTTP ${res.status})` };
    const bytes = await readCappedBody(res, REPO_MAX_BYTES, stop);
    if (signal.aborted) return { ok: false, error: 'capture cancelled' };
    deps.onStep?.(5);
    // Let the step message go out before the synchronous inflate and hashing.
    await new Promise((r) => setTimeout(r, 0));
    let tree: { treeSha: string; files: number };
    try {
      tree = gitTreeFromTarGz(bytes);
    } catch (err) {
      return { ok: false, error: `${SNAPSHOT_MISMATCH} (${err instanceof Error ? err.message : String(err)})` };
    }
    if (tree.treeSha !== req.treeSha) return { ok: false, error: SNAPSHOT_MISMATCH };
    const sha256 = await sha256Hex(bytes);
    if (signal.aborted) return { ok: false, error: 'capture cancelled' };
    await store(req.captureId, { bytes, sha256, at: Date.now() });
    return { ok: true, size: bytes.length, sha256, files: tree.files };
  } catch (err) {
    if (signal.aborted) return { ok: false, error: 'capture cancelled' };
    if (timedOut) {
      return { ok: false, error: `the code did not download within ${REPO_DOWNLOAD_TIMEOUT_MS / 1000} s` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}
