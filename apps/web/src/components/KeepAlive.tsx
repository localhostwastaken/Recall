import { Hourglass } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatBzzCeil, formatDay, formatXdaiCeil } from '../format';
import {
  arkivChainId,
  isFree,
  keptUntil,
  problemOf,
  readEnds,
  readQuote,
  stepExtend,
  stepTopUp,
  type Ends,
  type KeepAliveTarget,
  type Problem,
  type Quote,
} from '../keepalive/flow';
import { getNetConfig } from '../net';
import { MonoValue } from '../ui/MonoValue';
import { Notice } from '../ui/Notice';
import { Segmented } from '../ui/Segmented';
import { Steps, type StepState } from '../ui/Steps';
import { CHAIN_NAMES } from '../wallet';
import { TechnicalDetails } from '../verify/CheckPanel';
import './keepalive.css';

type Which = 'swarm' | 'arkiv';
type View =
  | { kind: 'form' }
  | { kind: 'busy'; which: Which }
  /** Step 1 is done and confirmed by a re-read; the person starts step 2 themselves. */
  | { kind: 'between' }
  | { kind: 'problem'; which: Which; problem: Problem }
  | { kind: 'done'; ends: Ends; nothingSent: boolean };

type QuoteState = { state: 'loading' } | { state: 'error' } | { state: 'ready'; quote: Quote };

const day = (d: Date | null) => (d ? formatDay(d) : 'unknown');

/**
 * "Keep alive…": anyone can pay to extend the Swarm storage (xBZZ on Gnosis) and the Arkiv record
 * (on Arkiv). Two wallet steps, each confirmed by a re-read of its chain before anything is
 * claimed. A capture on free gateway storage gets step 2 only.
 */
export function KeepAlive({
  target,
  subject = 'capture',
  onChanged,
}: {
  target: KeepAliveTarget;
  subject?: 'capture' | 'confirmation';
  /** Called after each wallet step has settled, so the page can read check E again. */
  onChanged: () => void | Promise<void>;
}) {
  const cfg = useMemo(getNetConfig, []);
  const freeStorage = isFree(target);
  const arkivName = CHAIN_NAMES[arkivChainId(cfg)];
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef(false);
  const runToken = useRef(0);

  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<7 | 30>(7);
  const [view, setView] = useState<View>({ kind: 'form' });
  /** Set once step 1 is confirmed by a re-read; `ends` is the batch's re-read end date. */
  const [stepOne, setStepOne] = useState<{ ends: Date | null } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [quote, setQuote] = useState<QuoteState>({ state: 'loading' });
  const [quoteTry, setQuoteTry] = useState(0);
  const [noticeSeq, setNoticeSeq] = useState(0);

  const busy = view.kind === 'busy';
  const keys = target.entityKeys.join(',');
  // Step 1 is off for free storage, and for a batch id that names no usable batch on Gnosis (a
  // record's batch id is only a claim, so the batch is read before anything is priced or paid).
  const swarmQuote = quote.state === 'ready' ? quote.quote.swarm : null;
  const noBatch = swarmQuote !== null && (swarmQuote.kind === 'missing' || swarmQuote.kind === 'unsupported');
  const free = freeStorage || noBatch;
  const active: KeepAliveTarget = free ? { ...target, batchId: null } : target;

  // The native dialog is opened and closed from React state.
  useEffect(() => {
    openRef.current = open;
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // What it would cost, and where it would end. Public reads only. Not re-read once step 1 is done.
  useEffect(() => {
    if (!open || stepOne) return;
    let live = true;
    setQuote({ state: 'loading' });
    readQuote(cfg, target, days).then(
      (q) => live && setQuote({ state: 'ready', quote: q }),
      () => live && setQuote({ state: 'error' }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, days, quoteTry, target.batchId, keys, stepOne]);

  const openDialog = () => {
    runToken.current++;
    setView({ kind: 'form' });
    setStepOne(null);
    setLeaving(false);
    setOpen(true);
  };

  const close = () => {
    // Steps already confirmed in the wallet stay done; a run still in flight just stops reporting here.
    runToken.current++;
    setLeaving(false);
    setOpen(false);
  };

  const run = async (which: Which) => {
    const token = ++runToken.current;
    const live = () => runToken.current === token && openRef.current;
    let approved = false;
    setView({ kind: 'busy', which });
    setLeaving(false);
    try {
      if (which === 'swarm') {
        const r = await stepTopUp(cfg, target.batchId!, days, () => {
          approved = true;
        });
        if (r.kind !== 'done') {
          if (live()) {
            setNoticeSeq((n) => n + 1);
            setView({
              kind: 'problem',
              which,
              problem: r.kind === 'short' ? { kind: 'short', need: r.need } : { kind: 'no-batch', unsupported: r.unsupported },
            });
          }
          return;
        }
        // Only what the chain says now counts, never what the top-up meant to do.
        const ends = await readEnds(cfg, active);
        void onChanged();
        if (!live()) return;
        setStepOne({ ends: ends.swarm });
        setView({ kind: 'between' });
      } else {
        const r = await stepExtend(cfg, active.entityKeys, days);
        const ends = await readEnds(cfg, active);
        void onChanged();
        if (!live()) return;
        setNoticeSeq((n) => n + 1);
        setView({ kind: 'done', ends, nothingSent: !r.sent });
      }
    } catch (err) {
      const problem = problemOf(err, approved);
      // A failure that is not a refusal may have changed something; read it again.
      if (problem.kind === 'failed') void onChanged();
      if (!live()) return;
      setNoticeSeq((n) => n + 1);
      setView({ kind: 'problem', which, problem });
    }
  };

  // ---- Copy and state of the steps ----
  const stepLabels = free ? [`Extend record (${arkivName})`] : ['Top up storage (Gnosis)', `Extend record (${arkivName})`];
  const total = stepLabels.length;
  const problemWhich = view.kind === 'problem' ? view.which : null;
  const swarmState: StepState = stepOne
    ? 'done'
    : problemWhich === 'swarm'
      ? 'failed'
      : view.kind === 'busy' && view.which === 'swarm'
        ? 'active'
        : view.kind === 'form'
          ? 'active'
          : 'waiting';
  const arkivState: StepState =
    view.kind === 'done'
      ? 'done'
      : problemWhich === 'arkiv'
        ? 'failed'
        : (view.kind === 'busy' && view.which === 'arkiv') || view.kind === 'between' || (view.kind === 'form' && free)
          ? 'active'
          : 'waiting';
  const steps = free
    ? [{ label: stepLabels[0]!, state: arkivState }]
    : [
        { label: stepLabels[0]!, state: swarmState },
        { label: stepLabels[1]!, state: arkivState },
      ];
  const stepNo = (which: Which) => (free || which === 'swarm' ? 1 : 2);

  const ready = quote.state === 'ready' ? quote.quote : null;
  const expired = swarmQuote?.kind === 'ok' && swarmQuote.expired;
  const canStart = ready !== null && !expired;
  const showQuote = view.kind === 'form' || (view.kind === 'problem' && view.which === 'swarm');
  const thisStep: Which = free || stepOne ? 'arkiv' : 'swarm';

  const subjectWord = subject === 'confirmation' ? 'confirmation' : 'capture';

  type Primary = { label: string; disabled: boolean; busy?: true; onClick: () => void };
  const primary: Primary | null = (() => {
    switch (view.kind) {
      case 'form':
        return { label: `Start: step ${stepNo(thisStep)} of ${total}`, disabled: !canStart, onClick: () => void run(thisStep) };
      case 'busy':
        return { label: 'Confirm in MetaMask…', disabled: true, busy: true, onClick: () => undefined };
      case 'between':
        return { label: `Continue: step 2 of ${total}`, disabled: false, onClick: () => void run('arkiv') };
      case 'done':
        return { label: 'Done', disabled: false, onClick: close };
      case 'problem':
        return null;
    }
  })();

  const statusText =
    view.kind === 'busy'
      ? view.which === 'swarm'
        ? 'Confirm in MetaMask: connect, switch to Gnosis, approve xBZZ if asked, then top up.'
        : `Confirm in MetaMask: connect, switch to ${arkivName}, then extend.`
      : '';

  return (
    <>
      <button ref={triggerRef} type="button" className="btn btn-secondary" onClick={openDialog}>
        <Hourglass size={16} strokeWidth={1.75} aria-hidden="true" />
        Keep alive…
      </button>

      <dialog
        ref={dialogRef}
        className="ka-dialog"
        aria-labelledby={titleId}
        onCancel={(e) => {
          // Esc while a wallet step is pending asks first.
          if (busy) {
            e.preventDefault();
            setLeaving(true);
          }
        }}
        onClose={() => {
          runToken.current++;
          setOpen(false);
          triggerRef.current?.focus();
        }}
      >
        {open ? (
          <div className="ka-body">
            <h2 className="ka-title" id={titleId}>
              Keep this {subjectWord} available
            </h2>
            <p className="ka-lede">
              Anyone can pay to keep evidence online.{' '}
              {free ? 'This extends the Arkiv record.' : 'This extends the Swarm storage and the Arkiv record.'}
              {subject === 'confirmation' ? ' A confirmation is kept alive through the capture it confirms: its storage and both records.' : ''}
            </p>
            {free ? (
              <p className="ka-lede">
                {freeStorage
                  ? "This capture used the gateway's free storage, which can't be extended."
                  : swarmQuote?.kind === 'unsupported'
                    ? "This capture's storage batch isn't one Recall created (unexpected size). Storage can't be extended."
                    : "This capture's storage batch wasn't found on Gnosis. Storage can't be extended."}
              </p>
            ) : null}

            <Segmented
              legend="Extend by"
              value={days}
              options={[
                { value: 7, label: '7 days' },
                { value: 30, label: '30 days' },
              ]}
              onChange={setDays}
              disabled={busy || view.kind === 'between' || view.kind === 'done' || stepOne !== null}
            />

            {showQuote ? (
              <div className="ka-quote" aria-live="polite">
                {quote.state === 'loading' ? (
                  <span className="muted">Reading the price and the current end dates…</span>
                ) : quote.state === 'error' ? (
                  <span>
                    Couldn&apos;t read the price or the current end dates.{' '}
                    <button type="button" className="link-btn" onClick={() => setQuoteTry((n) => n + 1)}>
                      Try again
                    </button>
                  </span>
                ) : (
                  <>
                    {quote.quote.swarm?.kind === 'ok' ? (
                      <span className="ka-quote-line">
                        Storage batch: <MonoValue value={target.batchId!} /> · depth {quote.quote.swarm.depth}
                      </span>
                    ) : null}
                    <span className="ka-quote-line">
                      {quote.quote.swarm?.kind === 'ok' ? (
                        <>
                          Storage: {formatBzzCeil(quote.quote.swarm.total)} xBZZ on Gnosis · network fees ~
                          {formatXdaiCeil(quote.quote.swarm.fee)} xDAI ·{' '}
                        </>
                      ) : null}
                      Arkiv fee shown in MetaMask
                    </span>
                    <span className="ka-quote-line">
                      New end dates: {quote.quote.swarm?.kind === 'ok' ? <>Swarm {day(quote.quote.swarm.endsAt)} · </> : null}Arkiv{' '}
                      {quote.quote.arkiv.nothingToAdd
                        ? 'already at the longest the network allows'
                        : `${day(quote.quote.arkiv.endsAt)}${quote.quote.arkiv.capped ? ' (the longest the network allows)' : ''}`}
                    </span>
                  </>
                )}
              </div>
            ) : null}

            {expired ? (
              <Notice kind="warn" title="The storage has already expired">
                The Swarm storage for this {subjectWord} has run out, so it can&apos;t be topped up. Download the evidence file to keep a copy.
              </Notice>
            ) : null}

            <Steps steps={steps} />
            {!free && (view.kind === 'form' || (view.kind === 'busy' && view.which === 'swarm') || problemWhich === 'swarm') ? (
              <p className="ka-note">MetaMask may ask twice: approve xBZZ, then top up.</p>
            ) : null}
            {statusText ? (
              <p className="ka-status" role="status">
                {statusText}
              </p>
            ) : null}

            {view.kind === 'between' && stepOne ? (
              <Notice
                key={`between-${noticeSeq}`}
                kind="info"
                title={stepOne.ends ? `Storage extended to ${formatDay(stepOne.ends)}.` : 'Storage topped up.'}
              >
                {stepOne.ends
                  ? `Step 2 of ${total} extends the record on ${arkivName}.`
                  : `The new end date could not be read just now; check Storage on the capture page. Step 2 of ${total} extends the record on ${arkivName}.`}
              </Notice>
            ) : null}

            {view.kind === 'problem' ? (
              <ProblemNotice
                key={`problem-${noticeSeq}`}
                which={view.which}
                problem={view.problem}
                stepNo={stepNo(view.which)}
                storageEnds={stepOne ? stepOne.ends : undefined}
                onRetry={() => void run(view.which)}
              />
            ) : null}

            {view.kind === 'done' ? (
              <DoneNotice key={`done-${noticeSeq}`} ends={view.ends} free={free} nothingSent={view.nothingSent} />
            ) : null}

            {leaving ? (
              <Notice
                kind="warn"
                title="Leave?"
                actions={
                  <>
                    <button type="button" className="btn btn-secondary" onClick={close}>
                      Leave
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={() => setLeaving(false)}>
                      Stay
                    </button>
                  </>
                }
              >
                Steps already confirmed in MetaMask stay done.
              </Notice>
            ) : null}

            <div className="ka-actions">
              {view.kind !== 'done' ? (
                <button type="button" className="btn btn-secondary" onClick={() => (busy ? setLeaving(true) : close())}>
                  {view.kind === 'problem' ? 'Close' : 'Cancel'}
                </button>
              ) : null}
              {primary ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={primary.disabled}
                  aria-busy={primary.busy}
                  onClick={primary.onClick}
                >
                  {primary.label}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}

function DoneNotice({ ends, free, nothingSent }: { ends: Ends; free: boolean; nothingSent: boolean }) {
  const until = keptUntil(ends, free);
  if (!until) {
    // Both wallet steps went through, but the chains could not be read: nothing is claimed in green.
    return (
      <Notice kind="warn" title="Both steps are done, but the new end dates could not be read." focus>
        Storage on the capture page shows them once they can be read.
      </Notice>
    );
  }
  return (
    <Notice kind="success" title={`Kept alive until ${formatDay(until)}.`} focus>
      {free ? '' : `Swarm storage until ${formatDay(ends.swarm!)} · `}Arkiv record until {formatDay(ends.arkiv!)}.
      {nothingSent ? ' The record was already at the longest the network allows, so only the storage was extended.' : ''}
    </Notice>
  );
}

function ProblemNotice({
  which,
  problem,
  stepNo,
  storageEnds,
  onRetry,
}: {
  which: Which;
  problem: Problem;
  stepNo: number;
  /** Set when step 1 is done: the re-read end date of the storage (null if it could not be read). */
  storageEnds: Date | null | undefined;
  onRetry: () => void;
}) {
  if (problem.kind === 'no-wallet') {
    return <Notice kind="error" title="MetaMask not found. Install it, then reload this page." focus />;
  }
  if (problem.kind === 'no-batch') {
    return (
      <Notice
        kind="error"
        title={
          problem.unsupported
            ? "This capture's storage batch isn't one Recall created (unexpected size). Storage can't be extended."
            : "This capture's storage batch wasn't found on Gnosis. Storage can't be extended."
        }
        focus
      />
    );
  }
  if (problem.kind === 'short') {
    return (
      <Notice
        kind="error"
        title={`Not enough xBZZ. You need ${formatBzzCeil(problem.need)} xBZZ on Gnosis.`}
        focus
        actions={
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            Try again
          </button>
        }
      />
    );
  }
  const partial = which === 'arkiv' && storageEnds !== undefined;
  const approvedNote =
    which === 'swarm' && problem.approved ? ' The xBZZ approval was already confirmed and stays; it moves no funds.' : '';
  const title = partial
    ? storageEnds
      ? `Storage extended to ${formatDay(storageEnds)}. The record wasn't extended yet.`
      : "Storage extended. The record wasn't extended yet."
    : problem.kind === 'cancelled'
      ? `Step ${stepNo} cancelled in MetaMask. Nothing more was charged.`
      : `Step ${stepNo} failed.`;
  const body =
    problem.kind === 'cancelled'
      ? partial
        ? `Step 2 cancelled in MetaMask. Nothing more was charged.`
        : approvedNote.trim() || undefined
      : `${problem.message.replace(/\.$/, '')}.${approvedNote}`;
  return (
    <Notice
      kind={partial ? 'warn' : 'error'}
      title={title}
      focus
      actions={
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          {partial ? 'Retry step 2' : 'Try again'}
        </button>
      }
    >
      {body}
      {problem.kind === 'failed' ? <TechnicalDetails text={problem.technical} /> : null}
    </Notice>
  );
}
