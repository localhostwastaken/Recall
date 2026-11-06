import { ConfirmationSchema, arkivPublic, readArkivExpiry } from '@recall/net';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { hexToBytes, type Address, type Hex } from 'viem';
import { KeepAlive } from '../components/KeepAlive';
import { formatDay, formatUtc } from '../format';
import { getNetConfig } from '../net';
import { MonoValue } from '../ui/MonoValue';
import { Notice } from '../ui/Notice';
import { VerdictLine, TechnicalDetails } from '../verify/CheckPanel';
import { useVerifiedCapture, verifyRecordEvidence } from '../verify/useVerifiedCapture';
import { isVerifiedReport, verdictOf, type VerifiedReport } from '../verify/verify';

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
        else setLoad({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
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

  // "Still unchanged" needs both records to have passed A to C, to be about the same address and
  // the same bytes, and the confirmation to come after the capture (the timeline's rules).
  const parentFacts = parent.facts;
  const ownFacts = own?.facts ?? null;
  const confirms =
    isVerifiedReport(own) &&
    isVerifiedReport(parent.report) &&
    !!parent.record &&
    !!ownFacts &&
    !!parentFacts &&
    ownFacts.urlHash.toLowerCase() === parentFacts.urlHash.toLowerCase() &&
    ownFacts.bodySha256.toLowerCase() === parentFacts.bodySha256.toLowerCase() &&
    ownFacts.signedAt >= parentFacts.signedAt;

  const settled = own !== null && (parent.phase !== 'loading' && parent.report !== null);
  const verdict = verdictOf(own);
  const refresh = useCallback(async () => {
    await Promise.all([parent.refreshStorage(), readOwn()]);
  }, [parent.refreshStorage, readOwn]);

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
          {parent.storage.phase === 'pending' ? 'checking…' : parent.storage.check.detail}{' '}
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
      {settled && !confirms ? (
        <p className="ka-hint">
          Keep-alive is offered only for a confirmation that passed checks A to C and belongs to a capture that passed them too.
        </p>
      ) : null}
    </>
  );
}

