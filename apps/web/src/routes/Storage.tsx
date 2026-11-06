import { XBZZ, batchTtlSeconds, readBatch, waitBatchUsable } from '@recall/net';
import { HardDrive } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPublicClient, erc20Abi, http, isAddress, type Address, type Hex, type PublicClient } from 'viem';
import { addBatches, extensionIdFromLink, getStampAddress, readPool, type PoolEntry } from '../ext';
import { formatBzzCeil, formatTtl } from '../format';
import { getNetConfig } from '../net';
import { defaultSettings, getSettings, isSharedOrigin, saveSettingsChecked } from '../settings';
import { Field } from '../ui/Field';
import { MonoValue, middle } from '../ui/MonoValue';
import { Notice } from '../ui/Notice';
import { Segmented } from '../ui/Segmented';
import { StatusBadge, type Status } from '../ui/StatusBadge';
import { chainFor, connectWallet, ensureChain, isUserRejection, walletFor, WalletError, type ChainId } from '../wallet';
import { DEFAULT_SIZE, SIZE_OPTIONS, depthForSize, poolSummary, priceLine, quoteFor, type Size } from '../storage/size';
import {
  USABLE_TIMEOUT_MS,
  buyOneBatch,
  forgetSent as forgetSentKey,
  linkNeedsConfirm,
  reason,
  recallSent as recallSentKey,
  settlePurchase,
} from '../storage/buy';

const MAX_BATCHES = 20;
const DEFAULT_BATCHES = 4;

type SlotState = 'waiting' | 'checking' | 'buying' | 'bought' | 'ready' | 'unknown' | 'cancelled' | 'failed';
/** `txHash`: the slot's createBatch transaction once it was sent, kept until its outcome is known. */
type Slot = { state: SlotState; batchId?: Hex; ttl?: bigint | null; txHash?: Hex };
type Phase = 'idle' | 'checking' | 'connecting' | 'buying' | 'waiting' | 'switching';
/** The last step of a purchase: MetaMask moved to Arkiv, so a capture asks for one confirmation only. */
type Switch = 'idle' | 'switching' | 'done' | 'failed';
type PoolStatus = { kind: 'checking' } | { kind: 'ready'; text: string } | { kind: 'error' };
type Outcome =
  | { kind: 'success'; count: number; owner: Address }
  | { kind: 'unconfirmed'; count: number }
  /** `stage` tells whether a purchase transaction could already have been approved. */
  | { kind: 'cancelled'; bought: number; target: number; stage: 'wallet' | 'purchase' }
  | { kind: 'failed'; bought: number; target: number; message: string }
  /** A purchase was sent but its result could not be read: it may have gone through. */
  | { kind: 'unknown'; slot: number; txHash: Hex }
  | { kind: 'short'; need: bigint }
  | { kind: 'no-wallet' };
/** `seq` makes a repeated outcome (cancelled twice) remount its notice, so focus moves again. */
type Shown = Outcome & { seq: number };
type Price = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; perBatch: bigint; gasPrice: bigint };
type ExtLink = { kind: 'checking' } | { kind: 'connected'; address: Address } | { kind: 'absent' };
/**
 * Which extension owns what this page buys. The stamp address it reports becomes the owner of
 * the batches, so an extension named only by the link (`?ext=`) that is neither the one in
 * Settings nor the build default is used only after the person says so (`ask`).
 */
type ExtChoice =
  /** `address`: the stamp address the person confirmed; it is used as is, not asked for again. */
  | { kind: 'settled'; extensionId?: string; address?: Address }
  | { kind: 'ask'; linkId: string; settingsId?: string };
type LinkOwner = { kind: 'checking' } | { kind: 'ok'; address: Address } | { kind: 'error' };

function initialExtChoice(): ExtChoice {
  const settingsId = getSettings().extensionId || undefined;
  const linkId = extensionIdFromLink();
  if (!linkId) return { kind: 'settled', extensionId: settingsId };
  if (!linkNeedsConfirm(linkId)) return { kind: 'settled', extensionId: linkId };
  return { kind: 'ask', linkId, settingsId };
}

const SLOT_VIEW: Record<SlotState, { status: Status; label: string }> = {
  waiting: { status: 'unavailable', label: 'Waiting' },
  checking: { status: 'pending', label: 'Checking…' },
  buying: { status: 'pending', label: 'Buying…' },
  bought: { status: 'pending', label: 'Preparing…' },
  ready: { status: 'pass', label: 'Ready' },
  unknown: { status: 'warn', label: 'Not confirmed' },
  cancelled: { status: 'warn', label: 'Cancelled' },
  failed: { status: 'fail', label: 'Failed' },
};

const plural = (n: number) => `${n} ${n === 1 ? 'batch' : 'batches'}`;

/** The pool line: each unused batch read on Gnosis for its depth and the time it has left. */
async function describePool(pub: PublicClient, entries: PoolEntry[]): Promise<string> {
  const open = entries.filter((e) => !e.used && !e.dead).slice(0, 20);
  const infos = await Promise.all(
    open.map(async (e) => {
      const [info, ttl] = await Promise.all([readBatch(pub, e.batchId), batchTtlSeconds(pub, e.batchId)]);
      return { used: false, depth: info?.depth ?? null, ttl };
    }),
  );
  return poolSummary(infos, Date.now());
}

/** The createBatch hash of slot `i` is kept under this key until its outcome is known (storage/buy.ts). */
const sentKey = (i: number) => `recall.storage.sentTx.v1.${i}`;
const recallSent = (i: number) => recallSentKey(sentKey(i));
const forgetSent = (i: number) => forgetSentKey(sentKey(i));

export function Storage() {
  const cfg = useMemo(getNetConfig, []);
  const pub = useMemo(
    () => createPublicClient({ chain: chainFor(100), transport: http(cfg.gnosis.rpcUrl) }),
    [cfg],
  );

  // Owner: the extension's stamp address when the extension answers, else typed by hand. The
  // extension is the one in Settings (or the build default); one that only the link names (the
  // popup opens `#/storage?ext=<id>`) is used once the person confirms it.
  const [extChoice, setExtChoice] = useState<ExtChoice>(initialExtChoice);
  const extensionId = extChoice.kind === 'settled' ? extChoice.extensionId : undefined;
  const extOpts = extensionId ? { extensionId } : undefined;
  const [extLink, setExtLink] = useState<ExtLink>(() => (extensionId ? { kind: 'checking' } : { kind: 'absent' }));
  // While asking: the stamp address the link's extension reports, shown before anything is bought.
  const [linkOwner, setLinkOwner] = useState<LinkOwner>({ kind: 'checking' });
  const askId = extChoice.kind === 'ask' ? extChoice.linkId : undefined;
  useEffect(() => {
    if (!askId) return;
    let live = true;
    getStampAddress({ extensionId: askId }).then(
      (address) => live && setLinkOwner({ kind: 'ok', address }),
      () => live && setLinkOwner({ kind: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [askId]);
  const adoptLinkExtension = (linkId: string, address: Address) => {
    // Saved to Settings, except on a shared /bzz/ origin (R38), where it holds for this page only.
    saveSettingsChecked({ extensionId: linkId });
    // The owner is the address the person was shown, not a second answer from the extension.
    setExtChoice({ kind: 'settled', extensionId: linkId, address });
  };
  const confirmedAddress = extChoice.kind === 'settled' ? extChoice.address : undefined;
  useEffect(() => {
    if (!extensionId) {
      setExtLink({ kind: 'absent' });
      return;
    }
    if (confirmedAddress) {
      setExtLink({ kind: 'connected', address: confirmedAddress });
      return;
    }
    setExtLink({ kind: 'checking' });
    let live = true;
    getStampAddress({ extensionId }).then(
      (address) => live && setExtLink({ kind: 'connected', address }),
      () => live && setExtLink({ kind: 'absent' }),
    );
    return () => {
      live = false;
    };
  }, [extensionId, confirmedAddress]);
  const [ownerText, setOwnerText] = useState('');
  const [ownerTouched, setOwnerTouched] = useState(false);
  const typedOwner = isAddress(ownerText.trim()) ? (ownerText.trim() as Address) : null;
  const owner = extLink.kind === 'connected' ? extLink.address : typedOwner;

  // What the extension already holds, read once it answers (and again after a hand-off).
  const [pool, setPool] = useState<PoolStatus | null>(null);
  const poolRead = useRef(0);
  const showPool = (entries: Promise<PoolEntry[]>) => {
    const seq = ++poolRead.current;
    setPool({ kind: 'checking' });
    entries
      .then((list) => describePool(pub, list))
      .then(
        (text) => seq === poolRead.current && setPool({ kind: 'ready', text }),
        () => seq === poolRead.current && setPool({ kind: 'error' }),
      );
  };
  useEffect(() => {
    if (extLink.kind !== 'connected') {
      poolRead.current++;
      setPool(null);
      return;
    }
    showPool(readPool(extOpts));
    // Read again only when the extension (or the chain client) changes.
  }, [extLink.kind, extensionId, pub]);

  // Form.
  const [countText, setCountText] = useState(String(DEFAULT_BATCHES));
  const [countTouched, setCountTouched] = useState(false);
  const [days, setDays] = useState<7 | 30>(7);
  const [size, setSize] = useState<Size>(DEFAULT_SIZE);
  const count = /^\d+$/.test(countText.trim()) ? Number(countText.trim()) : NaN;
  const countValid = count >= 1 && count <= MAX_BATCHES;

  // Price from the Gnosis RPC (no wallet needed to see it).
  const [price, setPrice] = useState<Price>({ kind: 'loading' });
  const [priceTry, setPriceTry] = useState(0);
  useEffect(() => {
    let live = true;
    setPrice({ kind: 'loading' });
    Promise.all([quoteFor(pub, size, days), pub.getGasPrice()]).then(
      ([perBatch, gasPrice]) => live && setPrice({ kind: 'ready', perBatch, gasPrice }),
      () => live && setPrice({ kind: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [pub, size, days, priceTry]);

  // Purchase.
  const [phase, setPhase] = useState<Phase>('idle');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [outcome, setOutcome] = useState<Shown | null>(null);
  const outcomeSeq = useRef(0);
  const show = (o: Outcome | null) => setOutcome(o && { ...o, seq: ++outcomeSeq.current });
  const [extWarning, setExtWarning] = useState<string | null>(null);
  // Batches the extension has accepted; set only after `addBatches` resolved.
  const [registered] = useState(() => new Set<Hex>());
  const [handedOver, setHandedOver] = useState(false);
  const [switched, setSwitched] = useState<Switch>('idle');
  const arkivId: ChainId = cfg.arkiv.chain === 'local' ? 1337 : 7794095;
  /** MetaMask to Arkiv (added first if needed), so the next capture has no network prompt. */
  const switchToArkiv = async () => {
    setSwitched('switching');
    try {
      await ensureChain(arkivId);
      setSwitched('done');
    } catch {
      setSwitched('failed'); // rejected or failed: the purchase still counts, the capture asks instead
    }
  };
  const running = phase !== 'idle';
  // A purchase that stopped part-way (or whose result is not known) keeps its owner, amount and
  // duration until it is finished.
  const partial = slots.some((s) => s.batchId || s.txHash) && slots.some((s) => !s.batchId);
  const locked = running || partial;
  const allHandedOver = (list: Slot[]) => list.length > 0 && list.every((s) => s.batchId && registered.has(s.batchId));

  /**
   * Buys every slot that has no batch yet, waits for usability, then tells the extension. A slot
   * whose purchase was already sent is looked up by its transaction, never bought twice.
   */
  async function run(resume: boolean) {
    if (!owner || !countValid) return;
    const plan: Slot[] = resume
      ? slots.map((s) => (s.batchId || s.txHash ? s : { state: 'waiting' }))
      : Array.from({ length: count }, () => ({ state: 'waiting' }));
    const commit = () => setSlots(plan.map((s) => ({ ...s })));
    const boughtCount = () => plan.filter((s) => s.batchId).length;
    const sentBefore = (i: number) => plan[i].txHash ?? recallSent(i);
    const target = plan.length;
    const quotedTotal = price.kind === 'ready' ? price.perBatch : undefined;
    // The size is locked with the plan (the control is disabled while a purchase is unfinished).
    const depth = depthForSize(size);

    /** The batch a sent purchase made: `bought`, `none` (safe to buy again) or `unknown`. */
    const settle = async (i: number, txHash: Hex): Promise<{ kind: 'bought'; slot: Slot } | { kind: 'none' | 'unknown' }> => {
      const r = await settlePurchase(pub, txHash, owner, depth);
      if (r.kind === 'unknown') return r;
      forgetSent(i);
      return r.kind === 'bought' ? { kind: 'bought', slot: { state: 'bought', batchId: r.batchId, ttl: r.ttl } } : r;
    };
    commit();
    show(null);
    setExtWarning(null);
    setHandedOver(false);
    setSwitched('idle');

    let stopped: Outcome | null = null;
    const notKnown = (i: number, txHash: Hex) => {
      plan[i] = { state: 'unknown', txHash };
      stopped = { kind: 'unknown', slot: i + 1, txHash };
      show(stopped);
    };
    /** Slots that hold a batch or a sent purchase are never dropped from the list. */
    const keepsSomething = () => plan.some((s) => s.batchId || s.txHash);

    // 1. Purchases sent before whose result was not read: look them up first, with no wallet step,
    //    so a failing wallet or price read can never hide one. Only one that bought nothing is
    //    bought again; one that is still unknown stops the run.
    if (plan.some((s, i) => !s.batchId && sentBefore(i))) {
      setPhase('checking');
      for (let i = 0; i < plan.length && !stopped; i++) {
        const earlier = plan[i].batchId ? undefined : sentBefore(i);
        if (!earlier) continue;
        plan[i] = { state: 'checking', txHash: earlier };
        commit();
        const found = await settle(i, earlier);
        if (found.kind === 'bought') plan[i] = found.slot;
        else if (found.kind === 'unknown') notKnown(i, earlier);
        else plan[i] = { state: 'waiting' }; // it bought nothing: bought below like any other
        commit();
      }
    }
    const toBuy = plan.filter((s) => !s.batchId).length;

    // 2. Wallet on Gnosis with enough xBZZ, only when something is left to buy.
    let wallet: ReturnType<typeof walletFor> | null = null;
    if (!stopped && toBuy > 0) {
      setPhase('connecting');
      try {
        const { address } = await connectWallet();
        await ensureChain(100);
        const need = BigInt(toBuy) * (await quoteFor(pub, size, days));
        const have = await pub.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
        if (have < need) stopped = { kind: 'short', need };
        else wallet = walletFor(address, 100);
      } catch (err) {
        if (err instanceof WalletError && err.kind === 'no-wallet') stopped = { kind: 'no-wallet' };
        else if (isUserRejection(err)) stopped = { kind: 'cancelled', bought: boughtCount(), target, stage: 'wallet' };
        else stopped = { kind: 'failed', bought: boughtCount(), target, message: reason(err) };
      }
      if (stopped) {
        show(stopped);
        // Nothing bought and nothing sent: there is no batch list to show.
        if (!keepsSomething()) {
          setSlots([]);
          return setPhase('idle');
        }
      }
    }

    // 3. One batch after another, so each MetaMask step is clear.
    if (wallet && !stopped) {
      setPhase('buying');
      for (let i = 0; i < plan.length && !stopped; i++) {
        if (plan[i].batchId) continue;
        plan[i] = { state: 'buying' };
        commit();
        const r = await buyOneBatch(wallet, pub, {
          owner,
          days,
          depth,
          quotedTotal,
          sentKey: sentKey(i),
          onSent: (txHash) => {
            plan[i] = { state: 'buying', txHash };
            commit();
          },
        });
        if (r.kind === 'bought') {
          forgetSent(i);
          plan[i] = { state: 'bought', batchId: r.batchId, ttl: r.ttl };
        } else if (r.kind === 'unknown') {
          notKnown(i, r.txHash);
        } else {
          // Nothing was sent, or what was sent bought nothing: safe to buy again.
          forgetSent(i);
          const cancelled = r.kind === 'cancelled';
          const rose = r.kind === 'failed' ? r.rose : undefined;
          if (rose) setPriceTry((n) => n + 1); // show the new price before another try
          plan[i] = { state: cancelled ? 'cancelled' : 'failed' };
          stopped = cancelled
            ? { kind: 'cancelled', bought: boughtCount(), target, stage: 'purchase' }
            : {
                kind: 'failed',
                bought: boughtCount(),
                target,
                message: rose
                  ? `The price rose to ${formatBzzCeil(rose.total)} xBZZ per batch from the ${formatBzzCeil(rose.quoted)} xBZZ shown, so nothing was sent. Check the new price`
                  : r.kind === 'failed'
                    ? r.message
                    : '',
              };
          // Say so right away; the usability polling below can take minutes.
          show(stopped);
        }
        commit();
      }
    }

    // 3. Bee accepts stamps only a little after creation. "Ready" needs that live confirmation.
    if (boughtCount() > 0) {
      setPhase('waiting');
      await Promise.all(
        plan.map(async (s, i) => {
          if (!s.batchId || s.state === 'ready') return;
          try {
            await waitBatchUsable(cfg.swarm.uploadUrl, s.batchId, USABLE_TIMEOUT_MS, { chain: pub });
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
          const added = await addBatches(fresh, extOpts);
          fresh.forEach((id) => registered.add(id));
          showPool(Promise.resolve(added));
        } catch (err) {
          setExtWarning(reason(err));
        }
      }
      const handed = extLink.kind === 'connected' && allHandedOver(plan);
      setHandedOver(handed);

      // 5. MetaMask to Arkiv now, so the capture itself asks for one confirmation only. A
      //    rejection is fine: the storage is bought, and the capture asks to switch instead.
      if (handed && !stopped) {
        setPhase('switching');
        await switchToArkiv();
      }
    }

    // A stop (cancelled / failed) was already shown and stays; only a clean run reports here.
    if (!stopped) {
      const ready = plan.filter((s) => s.state === 'ready').length;
      show(ready === plan.length ? { kind: 'success', count: plan.length, owner } : { kind: 'unconfirmed', count: plan.length });
    }
    setPhase('idle');
  }

  // Copy and state of the primary action.
  const bought = slots.filter((s) => s.batchId).length;
  const buyingIndex = slots.findIndex((s) => s.state === 'buying') + 1;
  const label = {
    idle: `Buy ${countValid ? plural(count) : 'batches'}`,
    checking: 'Checking the earlier purchase…',
    connecting: 'Waiting for MetaMask…',
    buying: `Buying batch ${buyingIndex || bought + 1} of ${slots.length}…`,
    waiting: 'Waiting for storage…',
    switching: 'Switching MetaMask to Arkiv…',
  }[phase];
  const blocker = partial
    ? 'Finish the purchase in progress first: use the button in the notice below.'
    : extChoice.kind === 'ask'
    ? 'Choose which extension to use first: see the notice above.'
    : !owner
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
    phase === 'checking'
      ? 'Looking up a purchase that was already sent, so it is not paid for twice.'
      : phase === 'connecting'
      ? 'Confirm in MetaMask: connect, then switch to Gnosis.'
      : phase === 'buying'
        ? `Buying batch ${buyingIndex || bought + 1} of ${slots.length}… Confirm both steps in MetaMask: approve xBZZ, then create the batch.`
        : phase === 'waiting'
          ? 'Waiting for batches to become usable (about 1–2 min)'
          : phase === 'switching'
            ? 'Switching MetaMask to Arkiv for your captures. Confirm in MetaMask.'
            : '';

  return (
    <>
      <h1 tabIndex={-1}>Buy storage</h1>
      <p className="lede muted">Each capture uses one prepaid storage batch, owned by your extension&apos;s stamp key.</p>
      {pool ? (
        <p className={`pool-status${pool.kind === 'ready' ? '' : ' muted'}`} role="status">
          <HardDrive size={18} strokeWidth={1.75} aria-hidden="true" />
          <span>
            {pool.kind === 'ready'
              ? pool.text
              : pool.kind === 'checking'
                ? 'Checking the storage your extension has…'
                : "Couldn't check the storage your extension has."}
          </span>
        </p>
      ) : null}

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!running && !blocker) void run(false);
        }}
      >
        <section className="stack" aria-label="Owner">
          {extChoice.kind === 'ask' ? (
            <div className="ext-choice">
              <Notice
                kind="warn"
                title="Which extension should own this storage?"
                actions={
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={linkOwner.kind !== 'ok'}
                      onClick={() => linkOwner.kind === 'ok' && adoptLinkExtension(extChoice.linkId, linkOwner.address)}
                    >
                      Use this extension
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setExtChoice({ kind: 'settled', extensionId: extChoice.settingsId })}
                    >
                      Keep my Settings
                    </button>
                  </>
                }
              >
                <p>
                  {extChoice.settingsId
                    ? `This link uses extension ${extChoice.linkId}, which isn't the one in your Settings.`
                    : `This link uses extension ${extChoice.linkId}, and your Settings name no extension yet.`}
                </p>
                <p>
                  {linkOwner.kind === 'ok' ? (
                    <>
                      It reports the stamp address <MonoValue value={linkOwner.address} />. The batches you buy belong to that
                      address, so use it only if it is your Recall extension.
                    </>
                  ) : linkOwner.kind === 'checking' ? (
                    'Asking it for its stamp address…'
                  ) : (
                    'It did not answer, so it cannot be used.'
                  )}
                </p>
              </Notice>
            </div>
          ) : extLink.kind === 'connected' ? (
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
                disabled={locked}
              />
            </>
          )}
        </section>

        <div className="stack-tight">
          <Segmented legend="Storage for" value={size} options={SIZE_OPTIONS} onChange={setSize} disabled={locked} />
          <p className="field-helper">
            Buy once. Every capture after that needs one MetaMask confirmation until the storage runs out.
          </p>
        </div>
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
          disabled={locked}
        />
        <Segmented
          legend="Storage lasts"
          value={days}
          options={[
            { value: 7, label: '7 days' },
            { value: 30, label: '30 days' },
          ]}
          onChange={setDays}
          disabled={locked}
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
            // Round the unit up once and multiply it, so "n × a = b" is exact and never below the real cost.
            <span className="tabular">{priceLine(count, price.perBatch, price.gasPrice)}</span>
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
          <OutcomeNotice
            key={outcome.seq}
            outcome={outcome}
            remaining={remaining}
            busy={running}
            handoff={extLink.kind !== 'connected' ? 'none' : handedOver ? 'done' : 'failed'}
            switched={switched}
            onSwitch={() => void switchToArkiv()}
            onRetry={() => void run(slots.some((s) => s.batchId || s.txHash))}
          />
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
                      const added = await addBatches(ids, extOpts);
                      ids.forEach((id) => registered.add(id));
                      showPool(Promise.resolve(added));
                      setExtWarning(null);
                      setHandedOver(allHandedOver(slots));
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
  busy,
  handoff,
  switched,
  onSwitch,
  onRetry,
}: {
  outcome: Outcome;
  remaining: number;
  /** A run is still in progress (waiting for usability): the actions stay off until it ends. */
  busy: boolean;
  /** Whether the extension has the batches: only `done` may say it can use them. */
  handoff: 'done' | 'failed' | 'none';
  /** Whether MetaMask was moved to Arkiv after the hand-off (the purchase's last step). */
  switched: Switch;
  onSwitch: () => void;
  onRetry: () => void;
}) {
  const action = (label: string) => (
    <button type="button" className="btn btn-secondary" onClick={onRetry} disabled={busy}>
      {label}
    </button>
  );
  const captures = (n: number) => `${n} more ${n === 1 ? 'capture' : 'captures'}`;
  switch (outcome.kind) {
    case 'success':
      if (handoff === 'done') {
        // The extension holds the batches: the next capture is one MetaMask confirmation, or two
        // (a network switch first) while MetaMask is not on Arkiv.
        return switched === 'done' ? (
          <Notice kind="success" title="Storage ready." focus>
            <p>MetaMask is on Arkiv, so your next capture needs one confirmation.</p>
            <p>You can make {captures(outcome.count)}.</p>
          </Notice>
        ) : (
          <Notice
            kind="success"
            title="Storage ready."
            focus
            actions={
              <button type="button" className="btn btn-secondary" onClick={onSwitch} disabled={busy || switched === 'switching'}>
                {switched === 'switching' ? 'Switching…' : 'Switch MetaMask to Arkiv now'}
              </button>
            }
          >
            <p>You can make {captures(outcome.count)}.</p>
            <p>MetaMask is not on Arkiv yet, so your next capture asks to switch first.</p>
          </Notice>
        );
      }
      return (
        <Notice kind="success" title={`${plural(outcome.count)} ready.`} focus>
          {handoff === 'failed'
            ? "They are paid for, but they are not in the extension's pool yet."
            : `These batches are owned by the stamp key ${middle(outcome.owner)}. The Recall extension has not been told about them.`}
        </Notice>
      );
    case 'unconfirmed':
      return (
        <Notice kind="warn" title="Bought, but not confirmed usable yet" focus>
          The storage is paid for, but the Swarm node has not accepted it yet. This normally takes 1 to 2 minutes.
        </Notice>
      );
    case 'cancelled': {
      // A rejected wallet or network prompt cannot have charged anything. A rejected purchase
      // prompt can come after the xBZZ approval already went through.
      const body =
        outcome.stage === 'wallet'
          ? `You rejected the request in MetaMask. ${outcome.bought === 0 ? 'Nothing was charged.' : 'Nothing more was charged.'}`
          : `${outcome.bought === 0 ? 'You rejected the request in MetaMask.' : `You rejected batch ${outcome.bought + 1} in MetaMask.`} No ${
              outcome.bought === 0 ? '' : 'more '
            }storage was bought. If you already approved the xBZZ spend, that approval and its small network fee remain.`;
      return outcome.bought === 0 ? (
        <Notice kind="warn" title="Not bought" focus actions={action('Try again')}>
          {body}
        </Notice>
      ) : (
        <Notice kind="warn" title={`${outcome.bought} of ${outcome.target} bought.`} focus actions={action(`Buy remaining ${remaining}`)}>
          {body}
        </Notice>
      );
    }
    case 'failed':
      return (
        <Notice
          kind="error"
          title="Buying failed"
          focus
          actions={action(outcome.bought > 0 ? `Buy remaining ${remaining}` : 'Try again')}
        >
          {outcome.message}. {outcome.bought} of {outcome.target} bought.
        </Notice>
      );
    case 'unknown':
      return (
        <Notice kind="warn" title="The purchase may have gone through" focus actions={action('Check again')}>
          Batch {outcome.slot} was sent to Gnosis (transaction <MonoValue value={outcome.txHash} />), but its result could
          not be read yet. Check again: the page looks that transaction up and does not buy the batch twice.
        </Notice>
      );
    case 'short':
      return (
        <Notice kind="error" title="Not enough xBZZ" focus actions={action('Try again')}>
          You need {formatBzzCeil(outcome.need)} xBZZ on Gnosis.
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
