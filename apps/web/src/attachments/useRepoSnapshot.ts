import type { VerifiedFacts } from '@recall/evidence';
import { arkivPublic, listAttachments, type ListedAttachment } from '@recall/net';
import { useEffect, useMemo, useState } from 'react';
import type { Hex } from 'viem';
import { getNetConfig } from '../net';
import { attachmentClaimsFit, computeCode, downloadCode, repoOf, snapshotDiffers, type CodeComputed, type GitHubBranch } from './git';

/** At most this many tarballs are downloaded for one capture (anyone can write a record). */
const MAX_CHECKED = 2;

export type SnapshotState =
  | { phase: 'downloading'; received: number; total: number | null }
  | { phase: 'checking' }
  /** Hash-anchored: everything was recomputed here and agrees. */
  | { phase: 'ok'; computed: CodeComputed; bytes: Uint8Array }
  | { phase: 'mismatch'; differs: string[] }
  | { phase: 'unavailable'; reason: string };

export type RepoSnapshotItem = { record: ListedAttachment; state: SnapshotState };

export type RepoSnapshots =
  | { phase: 'none' }
  | { phase: 'loading'; branch: GitHubBranch }
  | { phase: 'error'; branch: GitHubBranch; reason: string }
  | { phase: 'ready'; branch: GitHubBranch; items: RepoSnapshotItem[]; ignored: number };

/**
 * The repository snapshots attached to a verified GitHub branch capture. `verifiedFacts` must be
 * the facts of a capture whose checks passed (null otherwise): nothing is listed for anything else.
 * Each tarball is downloaded (capped), its tree recomputed here and compared with the notarized
 * commit and with its record; only then is it "ok".
 */
export function useRepoSnapshot(captureKey: Hex | null | undefined, verifiedFacts: VerifiedFacts | null | undefined): RepoSnapshots {
  const branch = useMemo(() => repoOf(verifiedFacts), [verifiedFacts]);
  const [state, setState] = useState<RepoSnapshots>({ phase: 'none' });
  const branchKey = branch ? `${branch.owner}/${branch.repo}@${branch.branch}#${branch.commitSha}` : '';

  useEffect(() => {
    if (!branch || !captureKey) {
      setState({ phase: 'none' });
      return;
    }
    const parent = { captureKey, branch };
    const ac = new AbortController();
    let live = true;
    const set = (s: RepoSnapshots) => live && setState(s);
    set({ phase: 'loading', branch });
    void (async () => {
      const cfg = getNetConfig();
      let rows: ListedAttachment[];
      try {
        rows = (await listAttachments(arkivPublic(cfg), captureKey)).rows;
      } catch (e) {
        set({ phase: 'error', branch, reason: e instanceof Error ? e.message : String(e) });
        return;
      }
      // Records that can't describe this capture are not downloaded; one per tarball.
      const seen = new Set<string>();
      const fit = rows.filter((r) => {
        if (!attachmentClaimsFit(r, parent)) return false;
        const k = `${r.evidenceRef.toLowerCase()}:${r.sha256.toLowerCase()}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const chosen = fit.slice(0, MAX_CHECKED);
      let items: RepoSnapshotItem[] = chosen.map((record) => ({ record, state: { phase: 'downloading', received: 0, total: null } }));
      const ignored = rows.length - chosen.length;
      const update = (i: number, s: SnapshotState) => {
        items = items.map((it, j) => (j === i ? { ...it, state: s } : it));
        set({ phase: 'ready', branch, items, ignored });
      };
      set({ phase: 'ready', branch, items, ignored });
      for (let i = 0; i < chosen.length; i++) {
        const record = chosen[i]!;
        let bytes: Uint8Array;
        try {
          let last = 0;
          bytes = (
            await downloadCode(record.evidenceRef, record.batchId, cfg.swarm.downloadUrls, {
              signal: ac.signal,
              onProgress: (received, total) => {
                // About every 256 KB, so a 15 MB download doesn't re-render thousands of times.
                if (received - last < 256 * 1024 && received !== total) return;
                last = received;
                update(i, { phase: 'downloading', received, total: total ?? Number(record.size) });
              },
            })
          ).bytes;
        } catch (e) {
          if (!live) return;
          update(i, { phase: 'unavailable', reason: e instanceof Error ? e.message : String(e) });
          continue;
        }
        update(i, { phase: 'checking' });
        // Let the "Checking…" state paint before the (synchronous) tree recomputation.
        await new Promise((r) => setTimeout(r, 30));
        if (!live) return;
        let computed: CodeComputed;
        try {
          computed = await computeCode(bytes);
        } catch (e) {
          update(i, { phase: 'mismatch', differs: [`code (it can't be read as a git snapshot: ${e instanceof Error ? e.message : String(e)})`] });
          continue;
        }
        const differs = snapshotDiffers(record, parent, computed);
        update(i, differs.length === 0 ? { phase: 'ok', computed, bytes } : { phase: 'mismatch', differs });
      }
    })();
    return () => {
      live = false;
      ac.abort();
    };
    // branchKey stands for `branch` (a new object per facts object).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureKey, branchKey]);

  return state;
}
