import { XBZZ, batchTtlSeconds, buyBatch, costFor, waitBatchUsable } from '@recall/net';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPublicClient, erc20Abi, http, isAddress, type Address, type Hex } from 'viem';
import { addBatches, getStampAddress } from '../ext';
import { formatBzz, formatTtl, formatXdai } from '../format';
import { getNetConfig } from '../net';
import { getSettings } from '../settings';
import { Field } from '../ui/Field';
import { MonoValue, middle } from '../ui/MonoValue';
import { Notice } from '../ui/Notice';
import { Segmented } from '../ui/Segmented';
import { StatusBadge, type Status } from '../ui/StatusBadge';
import { chainFor, connectWallet, ensureChain, isUserRejection, walletFor, WalletError } from '../wallet';

/** One batch per capture; depth 17 is the capture default (design brief 4.7). */
const DEPTH = 17;
const MAX_BATCHES = 20;
const DEFAULT_BATCHES = 4;
/**
 * Gas for one batch: an xBZZ approval plus createBatch. Measured on the Gnosis fork at
 * 51k + 357k = 408k; rounded up so the fee preview errs on the high side.
 */
const GAS_PER_BATCH = 420_000n;
/** Bee needs about 12 blocks (1 to 2 minutes) before it accepts stamps for a new batch. */
const USABLE_TIMEOUT_MS = 4 * 60_000;

type SlotState = 'waiting' | 'buying' | 'bought' | 'ready' | 'cancelled' | 'failed';
type Slot = { state: SlotState; batchId?: Hex; ttl?: bigint | null };
type Phase = 'idle' | 'connecting' | 'buying' | 'waiting';
type Outcome =
  | { kind: 'success'; count: number; owner: Address; registered: boolean }
  | { kind: 'unconfirmed'; count: number }
  | { kind: 'cancelled'; bought: number; target: number }
  | { kind: 'failed'; bought: number; target: number; message: string }
  | { kind: 'short'; need: bigint }
  | { kind: 'no-wallet' };
/** `seq` makes a repeated outcome (cancelled twice) remount its notice, so focus moves again. */
type Shown = Outcome & { seq: number };
type Price = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; perBatch: bigint; gasPrice: bigint };
type ExtLink = { kind: 'checking' } | { kind: 'connected'; address: Address } | { kind: 'absent' };

const SLOT_VIEW: Record<SlotState, { status: Status; label: string }> = {
  waiting: { status: 'unavailable', label: 'Waiting' },
  buying: { status: 'pending', label: 'Buying…' },
  bought: { status: 'pending', label: 'Preparing…' },
  ready: { status: 'pass', label: 'Ready' },
  cancelled: { status: 'warn', label: 'Cancelled' },
  failed: { status: 'fail', label: 'Failed' },
};

const plural = (n: number) => `${n} ${n === 1 ? 'batch' : 'batches'}`;
const reason = (e: unknown) => (e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : String(e));

export function Storage() {
  const cfg = useMemo(getNetConfig, []);
  const pub = useMemo(
    () => createPublicClient({ chain: chainFor(100), transport: http(cfg.gnosis.rpcUrl) }),
    [cfg],
  );

  // Owner: the extension's stamp address when the extension answers, else typed by hand.
  const [extLink, setExtLink] = useState<ExtLink>(() => (getSettings().extensionId ? { kind: 'checking' } : { kind: 'absent' }));
  useEffect(() => {
    if (!getSettings().extensionId) return;
    let live = true;
    getStampAddress().then(
      (address) => live && setExtLink({ kind: 'connected', address }),
      () => live && setExtLink({ kind: 'absent' }),
    );
    return () => {
      live = false;
    };
  }, []);
  const [ownerText, setOwnerText] = useState('');
  const [ownerTouched, setOwnerTouched] = useState(false);
  const typedOwner = isAddress(ownerText.trim()) ? (ownerText.trim() as Address) : null;
  const owner = extLink.kind === 'connected' ? extLink.address : typedOwner;

  // Form.
  const [countText, setCountText] = useState(String(DEFAULT_BATCHES));
  const [countTouched, setCountTouched] = useState(false);
  const [days, setDays] = useState<7 | 30>(7);
  const count = /^\d+$/.test(countText.trim()) ? Number(countText.trim()) : NaN;
  const countValid = count >= 1 && count <= MAX_BATCHES;

  // Price from the Gnosis RPC (no wallet needed to see it).
  const [price, setPrice] = useState<Price>({ kind: 'loading' });
  const [priceTry, setPriceTry] = useState(0);
  useEffect(() => {
    let live = true;
    setPrice({ kind: 'loading' });
    Promise.all([costFor(pub, DEPTH, days), pub.getGasPrice()]).then(
      ([perBatch, gasPrice]) => live && setPrice({ kind: 'ready', perBatch, gasPrice }),
      () => live && setPrice({ kind: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [pub, days, priceTry]);

  // Purchase.
  const [phase, setPhase] = useState<Phase>('idle');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [outcome, setOutcome] = useState<Shown | null>(null);
  const outcomeSeq = useRef(0);
  const show = (o: Outcome | null) => setOutcome(o && { ...o, seq: ++outcomeSeq.current });
  const [extWarning, setExtWarning] = useState<string | null>(null);
  const [registered] = useState(() => new Set<Hex>());
  const running = phase !== 'idle';

  /** Buys every slot that has no batch yet, waits for usability, then tells the extension. */
  async function run(resume: boolean) {
    if (!owner || !countValid) return;
    const plan: Slot[] = resume ? slots.map((s) => (s.batchId ? s : { state: 'waiting' })) : Array.from({ length: count }, () => ({ state: 'waiting' }));
    const commit = () => setSlots(plan.map((s) => ({ ...s })));
    const boughtCount = () => plan.filter((s) => s.batchId).length;
    const target = plan.length;
    commit();
    show(null);
    setExtWarning(null);

    // 1. Wallet on Gnosis with enough xBZZ.
    setPhase('connecting');
    let wallet: ReturnType<typeof walletFor>;
    try {
      const { address } = await connectWallet();
      await ensureChain(100);
      wallet = walletFor(address, 100);
      const need = BigInt(target - boughtCount()) * (await costFor(pub, DEPTH, days));
      const have = await pub.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
      if (have < need) {
        show({ kind: 'short', need });
        return setPhase('idle');
      }
    } catch (err) {
      if (err instanceof WalletError && err.kind === 'no-wallet') show({ kind: 'no-wallet' });
      else if (isUserRejection(err)) show({ kind: 'cancelled', bought: boughtCount(), target });
      else show({ kind: 'failed', bought: boughtCount(), target, message: reason(err) });
      return setPhase('idle');
    }

    // 2. One batch after another, so each MetaMask step is clear.
    setPhase('buying');
    let stopped: Outcome | null = null;
    for (let i = 0; i < plan.length && !stopped; i++) {
      if (plan[i].batchId) continue;
      plan[i] = { state: 'buying' };
      commit();
      try {
        const { batchId } = await buyBatch(wallet, { owner, depth: DEPTH, days });
        const ttl = await batchTtlSeconds(pub, batchId).catch(() => null);
        plan[i] = { state: 'bought', batchId, ttl };
      } catch (err) {
        const cancelled = isUserRejection(err);
        plan[i] = { state: cancelled ? 'cancelled' : 'failed' };
        stopped = cancelled
          ? { kind: 'cancelled', bought: boughtCount(), target }
          : { kind: 'failed', bought: boughtCount(), target, message: reason(err) };
      }
      commit();
    }

    // 3. Bee accepts stamps only a little after creation. "Ready" needs that live confirmation.
    if (boughtCount() > 0) {
      setPhase('waiting');
      await Promise.all(
        plan.map(async (s, i) => {
          if (!s.batchId || s.state === 'ready') return;
          try {
            await waitBatchUsable(cfg.swarm.uploadUrl, s.batchId, USABLE_TIMEOUT_MS);
            const ttl = await batchTtlSeconds(pub, s.batchId).catch(() => null);
            plan[i] = { state: 'ready', batchId: s.batchId, ttl };
          } catch {
            /* stays "Preparing…"; the notice below says so */
          }
          commit();
        }),
      );

      // 4. Hand the batches to the extension's pool when it is connected.
      const fresh = plan.flatMap((s) => (s.batchId && !registered.has(s.batchId) ? [s.batchId] : []));
      if (extLink.kind === 'connected' && fresh.length > 0) {
        try {
          await addBatches(fresh);
          fresh.forEach((id) => registered.add(id));
        } catch (err) {
          setExtWarning(reason(err));
        }
      }
    }

    const ready = plan.filter((s) => s.state === 'ready').length;
    show(
      stopped ??
        (ready === plan.length
          ? { kind: 'success', count: plan.length, owner, registered: extLink.kind === 'connected' }
          : { kind: 'unconfirmed', count: plan.length }),
    );
    setPhase('idle');
  }

  // Copy and state of the primary action.
  const bought = slots.filter((s) => s.batchId).length;
  const buyingIndex = slots.findIndex((s) => s.state === 'buying') + 1;
  const label = {
    idle: `Buy ${countValid ? plural(count) : 'batches'}`,
    connecting: 'Waiting for MetaMask…',
    buying: `Buying batch ${buyingIndex || bought + 1} of ${slots.length}…`,
    waiting: 'Waiting for storage…',
  }[phase];
  const blocker = !owner
    ? 'Enter the owner address to continue.'
    : !countValid
      ? `Choose 1 to ${MAX_BATCHES} batches to continue.`
      : price.kind === 'loading'
        ? 'Reading the storage price…'
        : price.kind === 'error'
          ? 'The storage price could not be read, so buying is paused.'
          : null;
  const remaining = outcome && (outcome.kind === 'cancelled' || outcome.kind === 'failed') ? outcome.target - outcome.bought : 0;

  const progressText =
    phase === 'connecting'
      ? 'Confirm in MetaMask: connect, then switch to Gnosis.'
      : phase === 'buying'
        ? `Buying batch ${buyingIndex || bought + 1} of ${slots.length}… Confirm both steps in MetaMask: approve xBZZ, then create the batch.`
        : phase === 'waiting'
          ? 'Waiting for batches to become usable (about 1–2 min)'
          : '';

  return (
    <>
      <h1 tabIndex={-1}>Buy storage</h1>
      <p className="lede muted">Each capture uses one prepaid storage batch, owned by your extension&apos;s stamp key.</p>

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!running && !blocker) void run(false);
        }}
      >
        <section className="stack" aria-label="Owner">
          {extLink.kind === 'connected' ? (
            <p className="owner-row">
              Owner (extension): <MonoValue value={extLink.address} />
            </p>
          ) : extLink.kind === 'checking' ? (
            <p className="owner-row muted">Looking for the Recall extension…</p>
          ) : (
            <>
              <p className="owner-row">
                Recall extension not found. Install it, or set its ID in <a href="#/settings">Settings</a>.
              </p>
              <Field
                label="Owner address"
                value={ownerText}
                onChange={(e) => setOwnerText(e.target.value)}
                onBlur={() => setOwnerTouched(true)}
                error={ownerTouched && !typedOwner ? 'Enter a 0x address (42 characters).' : undefined}
                helper="The stamp address shown in the extension. Only this key can use the storage you buy."
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                disabled={running}
              />
            </>
          )}
        </section>

        <Field
          label="Number of batches"
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_BATCHES}
          step={1}
          value={countText}
          onChange={(e) => setCountText(e.target.value)}
          onBlur={() => setCountTouched(true)}
          error={countTouched && !countValid ? `Enter a whole number from 1 to ${MAX_BATCHES}.` : undefined}
          helper="One batch = one capture."
          disabled={running}
        />
        <Segmented
          legend="Storage lasts"
          value={days}
          options={[
            { value: 7, label: '7 days' },
            { value: 30, label: '30 days' },
          ]}
          onChange={setDays}
          disabled={running}
        />

        <p className="price" aria-live="polite">
          {price.kind === 'loading' ? (
            <span className="muted">Reading the storage price…</span>
          ) : price.kind === 'error' ? (
            <>
              Couldn&apos;t read the storage price from Gnosis.{' '}
              <button type="button" className="link-btn" onClick={() => setPriceTry((n) => n + 1)}>
                Try again
              </button>
            </>
          ) : countValid ? (
            <span className="tabular">
              {count} × {formatBzz(price.perBatch)} xBZZ = {formatBzz(price.perBatch * BigInt(count))} xBZZ + network fees ~
              {formatXdai(price.gasPrice * GAS_PER_BATCH * BigInt(count))} xDAI
            </span>
          ) : (
            <span className="muted">Choose 1 to {MAX_BATCHES} batches to see the cost.</span>
          )}
        </p>

        <div className="actions">
          <button
            type="submit"
            className="btn btn-primary btn-wide"
            disabled={running || blocker !== null}
            aria-busy={running || undefined}
          >
            {label}
          </button>
          <p className="field-helper">
            {blocker ??
              'Storage is paid in xBZZ and network fees in xDAI, both on Gnosis. MetaMask asks for two confirmations per batch.'}
          </p>
        </div>
      </form>

      {running ? (
        <section className="stack" aria-label="Progress">
          <progress
            className="progress"
            max={phase === 'buying' ? slots.length : undefined}
            value={phase === 'buying' ? bought : undefined}
          />
          <p className="progress-text" role="status">
            {progressText}
          </p>
        </section>
      ) : null}

      {outcome ? (
        <section className="stack" aria-label="Result">
          <OutcomeNotice key={outcome.seq} outcome={outcome} remaining={remaining} onRetry={() => void run(true)} />
          {extWarning ? (
            <Notice
              kind="warn"
              title="The extension was not updated"
              actions={
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={async () => {
                    const ids = slots.flatMap((s) => (s.batchId && !registered.has(s.batchId) ? [s.batchId] : []));
                    try {
                      await addBatches(ids);
                      ids.forEach((id) => registered.add(id));
                      setExtWarning(null);
                    } catch (err) {
                      setExtWarning(reason(err));
                    }
                  }}
                >
                  Try again
                </button>
              }
            >
              The batches are bought, but the extension did not accept them: {extWarning}.
            </Notice>
          ) : null}
        </section>
      ) : null}

      {slots.length > 0 ? (
        <section aria-labelledby="batches-heading" className="stack">
          <h2 id="batches-heading" className="section-title">
            Batches
          </h2>
          <ol className="batch-list">
            {slots.map((s, i) => {
              const v = SLOT_VIEW[s.state];
              return (
                <li key={i} className="batch-row" data-batch-id={s.batchId}>
                  <div className="batch-head">
                    <span className="batch-title">Batch {i + 1}</span>
                    <StatusBadge status={v.status} label={v.label} />
                  </div>
                  {s.batchId ? (
                    <div className="batch-meta">
                      <MonoValue value={s.batchId} />
                      <span className="mono batch-ttl">
                        Storage left: {s.ttl === undefined ? '…' : s.ttl === null ? 'not checked' : formatTtl(s.ttl)}
                      </span>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
    </>
  );
}

function OutcomeNotice({
  outcome,
  remaining,
  onRetry,
}: {
  outcome: Outcome;
  remaining: number;
  onRetry: () => void;
}) {
  switch (outcome.kind) {
    case 'success':
      return (
        <Notice kind="success" title={`${plural(outcome.count)} ready.`} focus>
          {outcome.registered
            ? `You can make ${outcome.count} more ${outcome.count === 1 ? 'capture' : 'captures'}.`
            : `The stamp key ${middle(outcome.owner)} can now make ${outcome.count} more ${outcome.count === 1 ? 'capture' : 'captures'}.`}
        </Notice>
      );
    case 'unconfirmed':
      return (
        <Notice kind="warn" title="Bought, but not confirmed usable yet" focus>
          The storage is paid for, but the Swarm node has not accepted it yet. This normally takes 1 to 2 minutes.
        </Notice>
      );
    case 'cancelled':
      return outcome.bought === 0 ? (
        <Notice
          kind="warn"
          title="Not bought"
          focus
          actions={
            <button type="button" className="btn btn-secondary" onClick={onRetry}>
              Try again
            </button>
          }
        >
          You rejected the request in MetaMask. Nothing was charged.
        </Notice>
      ) : (
        <Notice
          kind="warn"
          title={`${outcome.bought} of ${outcome.target} bought.`}
          focus
          actions={
            <button type="button" className="btn btn-secondary" onClick={onRetry}>
              Buy remaining {remaining}
            </button>
          }
        >
          You rejected batch {outcome.bought + 1} in MetaMask. Nothing more was charged.
        </Notice>
      );
    case 'failed':
      return (
        <Notice
          kind="error"
          title="Buying failed"
          focus
          actions={
            <button type="button" className="btn btn-secondary" onClick={onRetry}>
              {outcome.bought > 0 ? `Buy remaining ${remaining}` : 'Try again'}
            </button>
          }
        >
          {outcome.message}. {outcome.bought} of {outcome.target} bought.
        </Notice>
      );
    case 'short':
      return (
        <Notice kind="error" title="Not enough xBZZ" focus>
          You need {formatBzz(outcome.need)} xBZZ on Gnosis.
        </Notice>
      );
    case 'no-wallet':
      return (
        <Notice kind="error" title="MetaMask not found" focus>
          Install it, then reload this page.
        </Notice>
      );
  }
}
