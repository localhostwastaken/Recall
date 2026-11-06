import { ConfirmationSchema, arkivPublic, readArkivExpiry } from '@recall/net';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { hexToBytes, type Address, type Hex } from 'viem';
import { KeepAlive } from '../components/KeepAlive';
import { errorText } from '../errors';
import { formatDay, formatUtc } from '../format';
import { getNetConfig } from '../net';
import { MonoValue } from '../ui/MonoValue';
import { Notice } from '../ui/Notice';
import { buildTimeline } from '../timeline/model';
import { useTimeline } from '../timeline/useTimeline';
import { VerdictLine, TechnicalDetails } from '../verify/CheckPanel';
import { useVerifiedCapture, verifyRecordEvidence } from '../verify/useVerifiedCapture';
import { isVerifiedReport, verdictOf, type VerifiedReport } from '../verify/verify';
import type { VerifiedFacts } from '@recall/evidence';

type Row = {
  captureKey: Hex;
  urlHash: Hex;
  bodySha256: Hex;
  witness: Address;
  signedAt: bigint;
  evidence: Uint8Array;
};

type Load =
  | { phase: 'loading' }
  | { phase: 'other' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; row: Row };

/**
 * The page of a `recall.v1.confirmation` record (`#/c/:key` falls through to it when the key is
 * not a capture): "the witness saw the same bytes again on <date>". It has no checks of its own
 * beyond A to C of its inline evidence, and it points at the capture it confirms. Its one action
 * is the keep-alive, which pays for the PARENT capture's storage and extends both records.
 * `fallback` is shown when the key turns out not to be a confirmation either.
 */
export function ConfirmationRecord({ entityKey, fallback }: { entityKey: Hex; fallback: ReactNode }) {
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  useEffect(() => {
    let alive = true;
    setLoad({ phase: 'loading' });
    (async () => {
      try {
        const e = await arkivPublic(getNetConfig()).getEntity(entityKey, ConfirmationSchema);
        const ev = e.evidence.value as Hex | Uint8Array;
        if (alive) {
          setLoad({
            phase: 'ready',
            row: {
              captureKey: e.captureKey.value,
              urlHash: e.urlHash.value,
              bodySha256: e.bodySha256.value,
              witness: e.witness.value as Address,
              signedAt: e.signedAt.value,
              evidence: typeof ev === 'string' ? hexToBytes(ev) : ev,
            },
          });
        }
      } catch (err) {
        if (!alive) return;
        const name = (err as { name?: string })?.name;
        if (name === 'SchemaMismatchError' || name === 'NoEntityFoundError') setLoad({ phase: 'other' });
        else setLoad({ phase: 'error', message: errorText(err) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [entityKey]);

  if (load.phase === 'other') return <>{fallback}</>;
  if (load.phase === 'loading') {
    return (
      <>
        <h1 tabIndex={-1}>Confirmation</h1>
        <p className="muted" role="status">
          Loading the record from Arkiv…
        </p>
      </>
    );
  }
  if (load.phase === 'error') {
    return (
      <>
        <h1 tabIndex={-1}>Confirmation</h1>
        <Notice kind="error" title="Couldn't reach Arkiv.">
          The record could not be read. Check your connection and the Arkiv endpoint, then try again.
          <TechnicalDetails text={load.message} />
        </Notice>
      </>
    );
  }
  return <ConfirmationView entityKey={entityKey} row={load.row} />;
}

const lower = (h: string) => h.toLowerCase();
/** The same witness signing the same bytes of the same address at the same second. */
const sameObservation = (a: VerifiedFacts, b: VerifiedFacts): boolean =>
  lower(a.urlHash) === lower(b.urlHash) &&
  lower(a.witness) === lower(b.witness) &&
  a.signedAt === b.signedAt &&
  lower(a.bodySha256) === lower(b.bodySha256);

/** Where the timeline's own rules put this confirmation. */
type Placement =
  | { kind: 'checking' }
  | { kind: 'placed' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'not-checked' }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

function ConfirmationView({ entityKey, row }: { entityKey: Hex; row: Row }) {
  const cfg = useMemo(getNetConfig, []);
  const parent = useVerifiedCapture(row.captureKey);
  const [own, setOwn] = useState<VerifiedReport | null>(null);
  useEffect(() => {
    let alive = true;
    void verifyRecordEvidence(row, row.evidence).then((r) => alive && setOwn(r));
    return () => {
      alive = false;
    };
  }, [row]);

  // The record's own expiry, read live (and again after a keep-alive).
  const [ownEnds, setOwnEnds] = useState<Date | null | 'pending'>('pending');
  const readOwn = useCallback(async () => {
    setOwnEnds('pending');
    try {
      const [e] = await readArkivExpiry(arkivPublic(cfg), [entityKey]);
      const seconds = Number(e!.expiresAtBlock - e!.currentBlock) * e!.blockSeconds;
      setOwnEnds(Number.isFinite(seconds) && seconds > 0 ? new Date(Date.now() + seconds * 1000) : null);
    } catch {
      setOwnEnds(null);
    }
  }, [cfg, entityKey]);
  useEffect(() => {
    void readOwn();
  }, [readOwn]);

  // "Still unchanged" is the timeline's claim, so it is the timeline's rules that decide it: the
  // address's records are listed and checked, and this confirmation counts only if the timeline
  // puts it under the capture it names (same bytes, signed AFTER that capture, and before any newer
  // version). Equal times, other bytes and a dated-after-a-newer-version record are all refused there.
  const t = useTimeline(row.urlHash);
  const tl = useMemo(
    () => buildTimeline(t.rows, t.checked, t.notStarted),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t.rows, t.version, t.notStarted],
  );
  const parentFacts = parent.facts;
  const ownFacts = own?.facts ?? null;
  const placement = useMemo((): Placement => {
    if (t.phase === 'loading') return { kind: 'checking' };
    if (t.phase === 'error') return { kind: 'unreadable' };
    const mine = lower(entityKey);
    const underParent = tl.versions.some(
      (v) =>
        (lower(v.entityKey) === lower(row.captureKey) || (!!parentFacts && sameObservation(v.facts, parentFacts))) &&
        v.confirmations.some((c) => lower(c.entityKey) === mine || (!!ownFacts && sameObservation(c.facts, ownFacts))),
    );
    if (underParent) return { kind: 'placed' };
    const refused = tl.unverified.find((u) => lower(u.entityKey) === mine);
    if (refused) return { kind: 'rejected', reason: refused.reason };
    if (tl.pending.some((p) => lower(p.entityKey) === mine)) return { kind: 'checking' };
    if (tl.unchecked.some((p) => lower(p.entityKey) === mine)) return { kind: 'not-checked' };
    return { kind: 'absent' };
  }, [t.phase, tl, entityKey, row.captureKey, parentFacts, ownFacts]);

  const confirms =
    isVerifiedReport(own) && isVerifiedReport(parent.report) && !!parent.record && placement.kind === 'placed';

  const verdict = verdictOf(own);
  const refresh = useCallback(async () => {
    await Promise.all([parent.refreshStorage(), readOwn()]);
  }, [parent.refreshStorage, readOwn]);

  // Why there is no keep-alive, once that is known (and "checking" while it is not).
  const parentDone = parent.phase !== 'loading' && (parent.phase !== 'ready' || parent.report !== null);
  const waiting = own === null || !parentDone || placement.kind === 'checking';
  const why = ((): ReactNode => {
    if (confirms) return null;
    if (waiting) return 'Checking this confirmation and the capture it names…';
    if (parent.phase === 'missing') {
      return "The capture it confirms isn't on Arkiv (it may have expired or never existed), so there is nothing here to keep alive. If you have its evidence file, drop it on the home page.";
    }
    if (parent.phase === 'not-capture') return "The record it names isn't a Recall capture, so there is nothing here to keep alive.";
    if (parent.phase === 'error') {
      return (
        <>
          Couldn&apos;t read the capture it confirms from Arkiv.{' '}
          <button type="button" className="link-btn" onClick={parent.retry}>
            Try again
          </button>
        </>
      );
    }
    if (placement.kind === 'rejected') return `Not counted as a confirmation: ${placement.reason}.`;
    if (placement.kind === 'not-checked') return "This address has many records and this one hasn't been checked yet. Open its timeline to check more.";
    if (placement.kind === 'unreadable') return "Couldn't list the records of this address, so this confirmation could not be placed. Try again in a moment.";
    return 'Keep-alive is offered only for a confirmation that passed checks A to C and that the timeline counts under a capture that passed them too.';
  })();

  return (
    <>
      <h1 tabIndex={-1}>{ownFacts ? `Confirmation of ${ownFacts.serverName}` : 'Confirmation'}</h1>
      <VerdictLine verdict={verdict} />
      {confirms && ownFacts ? (
        <p>
          Still unchanged on {formatUtc(ownFacts.signedAt)}: the witness saw the same bytes from {ownFacts.serverName} again, as it
          did for the capture this confirms.
        </p>
      ) : null}
      <p>
        <a href={`#/c/${row.captureKey}`}>View the capture it confirms</a>
      </p>
      <section className="stack" aria-labelledby="conf-storage">
        <h2 className="section-title" id="conf-storage">
          Storage
        </h2>
        <p>
          This record on Arkiv until:{' '}
          {ownEnds === 'pending' ? 'checking…' : ownEnds ? formatDay(ownEnds) : 'not checked'}
        </p>
        <p>
          The capture it confirms:{' '}
          {parent.phase === 'missing' || parent.phase === 'not-capture'
            ? 'not found'
            : parent.storage.phase === 'pending'
              ? 'checking…'
              : parent.storage.check.detail}{' '}
          {parent.record ? <MonoValue value={parent.record.batchId} /> : null}
        </p>
      </section>
      <div className="page-actions">
        {confirms && parent.record ? (
          <KeepAlive
            subject="confirmation"
            target={{ entityKeys: [entityKey, row.captureKey], batchId: parent.record.batchId }}
            onChanged={refresh}
          />
        ) : null}
      </div>
      {why ? (
        <p className="ka-hint" role="status">
          {why}
        </p>
      ) : null}
    </>
  );
}
