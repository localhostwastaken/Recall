import { Copy, Download } from 'lucide-react';
import { useMemo } from 'react';
import type { RepoSnapshotItem, RepoSnapshots, SnapshotState } from '../attachments/useRepoSnapshot';
import { codeFileName, GIT_CONTENT_TYPE, type GitHubBranch } from '../attachments/git';
import { saveBytes } from '../download';
import { attachmentLinks } from '../explorers';
import { formatBytes } from '../format';
import { getNetConfig } from '../net';
import { StatusBadge, type Status } from '../ui/StatusBadge';
import { useToast } from '../ui/Toast';
import { TechnicalDetails } from '../verify/CheckPanel';
import { OutsideLinkList } from './OutsideLinks';
import './repoSnapshot.css';

const BADGE: Record<SnapshotState['phase'], { status: Status; label: string }> = {
  downloading: { status: 'pending', label: 'Checking…' },
  checking: { status: 'pending', label: 'Checking…' },
  ok: { status: 'pass', label: 'Hash-anchored' },
  mismatch: { status: 'fail', label: "Doesn't match" },
  unavailable: { status: 'unavailable', label: "Couldn't download" },
};

/**
 * The badge of a snapshot card. A record by another account that doesn't match is neutral: anyone
 * can write a record naming any capture, so it says nothing about this capture or its creator.
 */
export function snapshotBadge(item: Pick<RepoSnapshotItem, 'own' | 'state'>): { status: Status; label: string } {
  if (!item.own && item.state.phase === 'mismatch') return { status: 'unavailable', label: 'Not used' };
  return BADGE[item.state.phase];
}

/** A commit as its first 7 digits; the full id is in the title and the copy button. */
export function CommitId({ sha }: { sha: string }) {
  const toast = useToast();
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(sha);
      toast('Copied');
    } catch {
      toast('Copy is blocked in this browser. Select the value instead.');
    }
  };
  return (
    <span className="mono-value-wrap">
      <span className="mono" title={sha} aria-label={`commit ${sha}`}>
        {sha.slice(0, 7)}
      </span>
      <button type="button" className="icon-btn" aria-label={`Copy commit ${sha}`} onClick={onCopy}>
        <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="exhibit-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

function SnapshotCard({ branch, item, index }: { branch: GitHubBranch; item: RepoSnapshotItem; index: number }) {
  const { record, state } = item;
  const badge = snapshotBadge(item);
  const titleId = `repo-snapshot-title-${index}`;
  const size = state.phase === 'ok' ? state.computed.size : Number(record.size);
  // The code record and the archive in the outside tools' own pages (live only).
  const links = useMemo(
    () => attachmentLinks(getNetConfig(), { entityKey: record.entityKey, evidenceRef: record.evidenceRef }),
    [record.entityKey, record.evidenceRef],
  );
  return (
    <section className="exhibit repo-snapshot" aria-labelledby={titleId} data-phase={state.phase}>
      <div className="repo-snapshot-head">
        <h2 className="exhibit-title" id={titleId}>
          Repository snapshot
        </h2>
        <StatusBadge status={badge.status} label={badge.label} />
      </div>
      <p className="repo-snapshot-copy">
        Recall notarized GitHub&apos;s answer for this branch.
        {state.phase === 'ok' ? ' This code is exactly the commit it named.' : null}
      </p>
      <dl className="exhibit-list">
        <Row label="Repository">
          <span className="mono">
            {branch.owner}/{branch.repo}
          </span>
        </Row>
        <Row label="Branch">
          <span className="mono">{branch.branch}</span>
        </Row>
        <Row label="Commit">
          <CommitId sha={branch.commitSha} />
        </Row>
        <Row label="Files">
          {state.phase === 'ok' ? <span className="tabular">{state.computed.files.toLocaleString('en')}</span> : <span className="muted">Counted after the check</span>}
        </Row>
        <Row label="Size">
          <span className="mono">{formatBytes(size)}</span>
        </Row>
      </dl>

      <div className="repo-snapshot-status" aria-live="polite">
        {state.phase === 'downloading' ? (
          <label className="repo-snapshot-progress">
            <span>
              Downloading the code to check it
              {state.received > 0 ? `: ${mb(state.received)}${state.total ? ` of ${mb(state.total)}` : ''} MB` : '…'}
            </span>
            <progress max={state.total ?? undefined} value={state.total ? Math.min(state.received, state.total) : undefined} />
          </label>
        ) : state.phase === 'checking' ? (
          <p className="muted">Recomputing the git tree hash of the code in this browser…</p>
        ) : state.phase === 'ok' ? (
          <p className="repo-snapshot-ok">
            Checked in this browser: the code&apos;s git tree hash is the one GitHub reported for commit {branch.commitSha.slice(0, 7)}, and
            its record agrees.
          </p>
        ) : state.phase === 'mismatch' && !item.own ? (
          <p className="muted">
            A record from another account names this capture, but its code doesn&apos;t match (the {state.differs.join(', ')}{' '}
            differ{state.differs.length === 1 ? 's' : ''}), so it isn&apos;t used. Anyone can write such a record.
          </p>
        ) : state.phase === 'mismatch' ? (
          <p className="repo-snapshot-bad" role="alert">
            The downloaded code doesn&apos;t match this capture: the {state.differs.join(', ')} differ{state.differs.length === 1 ? 's' : ''}.
            Don&apos;t rely on it.
          </p>
        ) : (
          <p className="muted">
            The code couldn&apos;t be downloaded from the Swarm gateways, so it wasn&apos;t checked.
            <TechnicalDetails text={state.reason} />
          </p>
        )}
      </div>

      <div className="page-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={state.phase !== 'ok'}
          onClick={() => state.phase === 'ok' && saveBytes(state.bytes, codeFileName(branch), GIT_CONTENT_TYPE)}
        >
          <Download size={16} strokeWidth={1.75} aria-hidden="true" />
          Download code (.tar.gz)
        </button>
        <OutsideLinkList links={links} />
      </div>
      {state.phase === 'ok' ? <GitCheck branch={branch} /> : null}
    </section>
  );
}

/** The shell line that rebuilds the git tree hash of a downloaded snapshot with the person's own git. */
export function gitCheckCommand(branch: GitHubBranch): string {
  return `mkdir recall-check && tar xzf ${codeFileName(branch)} -C recall-check --strip-components=1 && cd recall-check && git init -q && git add -A -f && git write-tree`;
}

/** "Don't trust this page": the same tree-hash check, done with plain git on the downloaded file. */
function GitCheck({ branch }: { branch: GitHubBranch }) {
  const toast = useToast();
  const command = gitCheckCommand(branch);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast('Copied');
    } catch {
      toast('Copy is blocked in this browser. Select the command instead.');
    }
  };
  return (
    <details className="repo-git-check">
      <summary>Check it with your own git</summary>
      <p>Download the code, then run this in the folder where it was saved:</p>
      <div className="repo-git-cmd">
        <code className="mono">{command}</code>
        <button type="button" className="icon-btn" aria-label="Copy the command" onClick={onCopy}>
          <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <p>
        Git must print <span className="mono repo-git-tree">{branch.treeSha}</span>, the tree hash GitHub reported for commit{' '}
        {branch.commitSha.slice(0, 7)} in the notarized capture. No Recall code is involved.
      </p>
    </details>
  );
}

/** The "Repository snapshot" cards of a GitHub branch capture (R46). Nothing for other captures. */
export function RepoSnapshot({ snapshots }: { snapshots: RepoSnapshots }) {
  if (snapshots.phase === 'none') return null;
  if (snapshots.phase === 'loading') {
    return (
      <p className="muted repo-snapshot-note" role="status">
        <StatusBadge status="pending" label="Looking for a snapshot of the code…" />
      </p>
    );
  }
  if (snapshots.phase === 'error') {
    return (
      <p className="muted repo-snapshot-note">
        The repository snapshot records couldn&apos;t be read from Arkiv.
        <TechnicalDetails text={snapshots.reason} />
      </p>
    );
  }
  return (
    <>
      {snapshots.items.map((item, i) => (
        <SnapshotCard key={item.record.entityKey} branch={snapshots.branch} item={item} index={i} />
      ))}
      {snapshots.items.length === 0 ? (
        <p className="muted repo-snapshot-note">No snapshot of the code was published with this capture.</p>
      ) : null}
      {snapshots.ignored > 0 ? (
        <p className="muted repo-snapshot-note">
          {snapshots.ignored === 1 ? 'One other record names' : `${snapshots.ignored} other records name`} this capture. Anyone can
          write one; {snapshots.ignored === 1 ? "it doesn't fit this capture or repeats one above, so it isn't" : "they don't fit this capture or repeat one above, so they aren't"} shown.
        </p>
      ) : null}
    </>
  );
}
