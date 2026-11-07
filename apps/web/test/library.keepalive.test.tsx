// @vitest-environment jsdom
import { Flip } from 'gsap/Flip';
import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CaptureCard } from '../src/components/CaptureCard';
import { LibraryKeepAlive, useKeepAliveRerank } from '../src/library/LibraryKeepAlive';
import { filterSort, type PageEntry } from '../src/library/model';
import type { LibraryData } from '../src/library/useLibrary';
import { flipRerank } from '../src/library/rerank';
import type { LibraryView } from '../src/router';
import { Library } from '../src/routes/Library';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The real keep-alive dialog talks to MetaMask; here its trigger just reports a settled step.
const keepAliveProps: {
  target: unknown;
  onChanged: () => void | Promise<void>;
  trigger?: { label: string; icon?: boolean };
}[] = [];
vi.mock('../src/components/KeepAlive', async () => {
  const { createElement, Fragment } = await import('react');
  return {
    KeepAlive: (p: {
      target: unknown;
      onChanged: () => void | Promise<void>;
      trigger?: { label: string; icon?: boolean };
    }) => {
      keepAliveProps.push(p);
      return createElement(
        Fragment,
        null,
        createElement(
          'button',
          { type: 'button', className: 'btn btn-secondary', onClick: () => void p.onChanged() },
          p.trigger?.label ?? 'Keep alive…',
        ),
        createElement('dialog', { 'aria-label': 'Keep this capture available' }),
      );
    },
  };
});

// The library page reads the shared store through useLibrary; a test hands it its own.
const pageLib = vi.hoisted(() => ({ use: null as null | (() => unknown) }));
vi.mock('../src/library/useLibrary', () => ({ useLibrary: () => pageLib.use!() }));

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

function page(name: string, n: number): PageEntry {
  const urlHash = hash(n);
  return {
    urlHash,
    address: `${name}.example/notice`,
    kind: 'page',
    versions: 1,
    signedAt: BigInt(1_700_000_000 + n),
    newest: {
      urlHash,
      entityKey: hash(1000 + n),
      owner: '0x0000000000000000000000000000000000000001',
      creator: '0x0000000000000000000000000000000000000001',
      expiresAtBlock: 1n,
      bodySha256: hash(2000 + n),
      serverName: `${name}.example`,
      witness: '0x0000000000000000000000000000000000000002',
      signedAt: BigInt(1_700_000_000 + n),
      httpStatus: 200,
      batchId: hash(3000 + n),
      evidenceRef: hash(4000 + n),
      canonicalUrl: `https://${name}.example/notice`,
    },
  };
}

const A = page('a', 1);
const B = page('b', 2);
const C = page('c', 3);

/** A stand-in for the library store: `days` by page, and a re-read that the test scripts. */
function fakeStore(initial: [PageEntry, number | null][], reread: (urlHash: Hex) => Promise<number | null>) {
  let days: ReadonlyMap<Hex, number | null> = new Map(initial.map(([e, d]) => [e.urlHash, d]));
  const listeners = new Set<() => void>();
  return {
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => days,
    refreshDays: vi.fn(async (urlHash: Hex) => {
      const d = await reread(urlHash);
      days = new Map(days).set(urlHash, d);
      listeners.forEach((l) => l());
    }),
  };
}
type Store = ReturnType<typeof fakeStore>;

/** The library grid as the page draws it: filterSort over the days the keep-alive hook hands out. */
function Grid({ store, entries, view, verified }: { store: Store; entries: PageEntry[]; view: LibraryView; verified: boolean }) {
  const live = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { days, onExtended } = useKeepAliveRerank(live, store.refreshDays);
  const shown = filterSort(entries, view, new Map(), days);
  return (
    <div data-library-grid="">
      {shown.map((e, i) => (
        <CaptureCard
          key={e.urlHash}
          title={e.address}
          address={e.address}
          href={`#/c/${e.newest.entityKey}`}
          status={verified ? 'verified' : 'checking'}
          rank={view.sort === 'time' ? i + 1 : undefined}
          kind={e.kind}
          versions={e.versions}
          daysLeft={days.get(e.urlHash) ?? null}
          keepAlive={<LibraryKeepAlive entry={e} verified={verified} onExtended={onExtended} />}
        />
      ))}
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const TIME: LibraryView = { q: '', type: 'all', sort: 'time' };

function render(store: Store, verified = true, view: LibraryView = TIME): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Grid store={store} entries={[A, B, C]} view={view} verified={verified} />));
  return host;
}

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// Card order by address line (titles follow their own rules: "Capture of <host>" until a page title is known).
const order = (el: HTMLElement) => [...el.querySelectorAll('.ccard-addr')].map((a) => a.textContent);
// A card is found by its title or its address line (a card without a page title is "Capture of <host>").
const cardOf = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll<HTMLElement>('.ccard')].find((c) =>
    ['.ccard-link', '.ccard-addr'].some((sel) => c.querySelector(sel)?.textContent?.startsWith(name)),
  )!;
const rankOf = (el: HTMLElement, name: string) => cardOf(el, name).querySelector('.ccard-rank')?.textContent;
const daysOf = (el: HTMLElement, name: string) => cardOf(el, name).querySelector<HTMLElement>('.ccard-days')!;

async function keepAlive(el: HTMLElement, name: string) {
  const button = [...cardOf(el, name).querySelectorAll('button')].find((b) => b.textContent === 'Keep alive')!;
  await act(async () => {
    button.click();
  });
  // The re-read, the decision after its commit, and the timer that plays the result.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

let fromSpy: MockInstance<typeof Flip.from>;
beforeEach(() => {
  keepAliveProps.length = 0;
  fromSpy = vi.spyOn(Flip, 'from').mockImplementation(() => ({}) as ReturnType<typeof Flip.from>);
  setReducedMotion(false);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

describe('keep alive from the library', () => {
  const raiseB = () =>
    fakeStore(
      [
        [A, 212],
        [B, 4],
        [C, 21],
      ],
      async (h) => (h === B.urlHash ? 34 : null),
    );

  it('re-ranks A(212), C(21), B(4) to A, B, C with Flip when B gains 30 days', async () => {
    const store = raiseB();
    const el = render(store);
    expect(order(el)).toEqual(['a.example/notice', 'c.example/notice', 'b.example/notice']);
    expect(rankOf(el, 'b')).toBe('#3');
    // Flip must record the cards while they still stand in the old order.
    const recorded: (string | null)[][] = [];
    const realGetState = Flip.getState.bind(Flip);
    vi.spyOn(Flip, 'getState').mockImplementation(((...args: Parameters<typeof Flip.getState>) => {
      recorded.push(order(el));
      return realGetState(...args);
    }) as typeof Flip.getState);

    await keepAlive(el, 'b');

    expect(recorded).toEqual([['a.example/notice', 'c.example/notice', 'b.example/notice']]);
    expect(store.refreshDays).toHaveBeenCalledWith(B.urlHash);
    expect(order(el)).toEqual(['a.example/notice', 'b.example/notice', 'c.example/notice']);
    expect(rankOf(el, 'b')).toBe('#2');
    expect(rankOf(el, 'c')).toBe('#3');
    expect(daysOf(el, 'b').dataset.days).toBe('34');
    expect(fromSpy).toHaveBeenCalledTimes(1);
    expect(fromSpy.mock.calls[0]![1]).toMatchObject({ duration: 0.8, ease: 'power3.inOut', absolute: true });
    // The card that was kept alive gets the brief ring.
    expect(cardOf(el, 'b').classList.contains('lib-ka-glow')).toBe(true);
  });

  it('with reduced motion re-orders without Flip and shows the final days at once', async () => {
    setReducedMotion(true);
    const el = render(raiseB());
    await keepAlive(el, 'b');
    expect(order(el)).toEqual(['a.example/notice', 'b.example/notice', 'c.example/notice']);
    expect(rankOf(el, 'b')).toBe('#2');
    expect(daysOf(el, 'b').textContent).toBe('34');
    expect(fromSpy).not.toHaveBeenCalled();
    expect(cardOf(el, 'b').classList.contains('lib-ka-glow')).toBe(false);
  });

  it('moves nothing when the re-read fails (a cancelled or failed keep-alive)', async () => {
    const store = fakeStore(
      [
        [A, 212],
        [B, 4],
        [C, 21],
      ],
      async () => {
        throw new Error('The record could not be read.');
      },
    );
    const el = render(store);
    await keepAlive(el, 'b');
    expect(order(el)).toEqual(['a.example/notice', 'c.example/notice', 'b.example/notice']);
    expect(daysOf(el, 'b').textContent).toBe('4');
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it('moves nothing when the days did not grow (step 1 only tops up storage)', async () => {
    const store = fakeStore(
      [
        [A, 212],
        [B, 4],
        [C, 21],
      ],
      async () => 4,
    );
    const el = render(store);
    await keepAlive(el, 'b');
    expect(order(el)).toEqual(['a.example/notice', 'c.example/notice', 'b.example/notice']);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it('holds the old order while the dialog is open and re-ranks once it closes', async () => {
    const el = render(raiseB());
    const dialog = cardOf(el, 'b').querySelector('dialog')!;
    dialog.setAttribute('open', '');
    await keepAlive(el, 'b');
    // Behind the open dialog nothing has moved yet.
    expect(order(el)).toEqual(['a.example/notice', 'c.example/notice', 'b.example/notice']);
    expect(daysOf(el, 'b').textContent).toBe('4');
    expect(fromSpy).not.toHaveBeenCalled();

    await act(async () => {
      dialog.removeAttribute('open');
      dialog.dispatchEvent(new Event('close'));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(order(el)).toEqual(['a.example/notice', 'b.example/notice', 'c.example/notice']);
    expect(fromSpy).toHaveBeenCalledTimes(1);
  });

  it('extends only the newest capture of the page: its record and its batch', () => {
    render(raiseB());
    const b = keepAliveProps.find((p) => (p.target as { entityKeys: Hex[] }).entityKeys[0] === B.newest.entityKey)!;
    expect(b.target).toEqual({ entityKeys: [B.newest.entityKey], batchId: B.newest.batchId });
  });

  it('on a verified card the trigger reads "Keep alive", with no icon and no ellipsis', () => {
    const el = render(raiseB());
    const button = cardOf(el, 'b').querySelector('.ccard-action button') as HTMLButtonElement;
    expect(button.textContent).toBe('Keep alive');
    expect(keepAliveProps.every((p) => p.trigger?.label === 'Keep alive' && p.trigger.icon === false)).toBe(true);
  });

  it('on a card not verified yet offers a disabled "Keep alive" that says why', () => {
    const el = render(raiseB(), false);
    const button = cardOf(el, 'b').querySelector('.ccard-action button') as HTMLButtonElement;
    expect(button.textContent).toBe('Keep alive');
    expect(button.querySelector('svg')).toBeNull();
    expect(button.disabled).toBe(true);
    const describedBy = button.getAttribute('aria-describedby')!;
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy)?.textContent).toBe('Available after this capture is checked');
    expect(keepAliveProps).toHaveLength(0);
  });
});

describe('flipRerank', () => {
  it('records the cards, mutates, then plays Flip.from (0.8 s, power3.inOut, absolute)', () => {
    const grid = document.createElement('div');
    grid.append(document.createElement('div'), document.createElement('div'));
    const calls: string[] = [];
    const getState = vi.spyOn(Flip, 'getState');
    getState.mockImplementation((() => {
      calls.push('getState');
      return {};
    }) as unknown as typeof Flip.getState);
    fromSpy.mockImplementation((() => {
      calls.push('from');
      return {};
    }) as unknown as typeof Flip.from);
    flipRerank(grid, () => calls.push('mutate'), { reducedMotion: false });
    expect(calls).toEqual(['getState', 'mutate', 'from']);
    const vars = fromSpy.mock.calls[0]![1]!;
    expect(vars).toMatchObject({ duration: 0.8, ease: 'power3.inOut', absolute: true });
    // The cards leave the flow while they move: the grid keeps its height until the move ends.
    expect(grid.style.minHeight).toBe('0px');
    (vars.onComplete as () => void)();
    expect(grid.style.minHeight).toBe('');
  });

  it('under reduced motion only mutates', () => {
    const getState = vi.spyOn(Flip, 'getState');
    const mutate = vi.fn();
    flipRerank(document.createElement('div'), mutate, { reducedMotion: true });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(getState).not.toHaveBeenCalled();
    expect(fromSpy).not.toHaveBeenCalled();
  });
});

describe('the library page wires keep-alive to its grid', () => {
  it('re-ranks the page grid and moves "#2" to the card kept alive', async () => {
    const store = fakeStore(
      [
        [A, 212],
        [B, 4],
        [C, 21],
      ],
      async (h) => (h === B.urlHash ? 34 : null),
    );
    pageLib.use = (): LibraryData => {
      const days = useSyncExternalStore(store.subscribe, store.getSnapshot);
      return {
        status: 'ready',
        entries: [A, B, C],
        captureCount: 3,
        truncated: false,
        check: new Map([A, B, C].map((e) => [e.urlHash, 'verified'] as const)),
        titles: new Map(),
        days,
        requestCheck: () => {},
        retry: () => {},
        refreshDays: store.refreshDays,
      };
    };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Library />));
    const grid = host.querySelector<HTMLElement>('[data-library-grid]')!;
    expect(order(grid)).toEqual(['a.example/notice', 'c.example/notice', 'b.example/notice']);

    await keepAlive(grid, 'b');

    expect(store.refreshDays).toHaveBeenCalledWith(B.urlHash);
    expect(order(grid)).toEqual(['a.example/notice', 'b.example/notice', 'c.example/notice']);
    expect(rankOf(grid, 'b')).toBe('#2');
    expect(fromSpy).toHaveBeenCalledTimes(1);
  });
});

describe('a kept-alive card that ranks onto another page', () => {
  it('turns the library to the page it moved to and gives its link the focus', async () => {
    // Ten pages: p1 (100 days) … p9 (20 days) fill page 1; p10 (1 day) is alone on page 2.
    const entries = Array.from({ length: 10 }, (_, i) => page(`p${i + 1}`, i + 1));
    const last = entries[9]!;
    const store = fakeStore(
      entries.map((e, i) => [e, i === 9 ? 1 : 100 - i * 10] as [PageEntry, number]),
      async (h) => (h === last.urlHash ? 500 : null),
    );
    pageLib.use = (): LibraryData => {
      const days = useSyncExternalStore(store.subscribe, store.getSnapshot);
      return {
        status: 'ready',
        entries,
        captureCount: entries.length,
        truncated: false,
        check: new Map(entries.map((e) => [e.urlHash, 'verified'] as const)),
        titles: new Map(),
        days,
        requestCheck: () => {},
        retry: () => {},
        refreshDays: store.refreshDays,
      };
    };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Library page={2} />));
    const grid = host.querySelector<HTMLElement>('[data-library-grid]')!;
    expect(order(grid)).toEqual(['p10.example/notice']);

    await keepAlive(grid, 'p10');

    const now = host.querySelector<HTMLElement>('[data-library-grid]')!;
    expect(order(now)).toHaveLength(9);
    expect(order(now)[0]).toBe('p10.example/notice');
    expect(rankOf(now, 'p10')).toBe('#1');
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('1');
    expect(document.activeElement).toBe(cardOf(now, 'p10').querySelector('a'));
  });
});
