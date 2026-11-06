import { mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CDPSession, Locator, Page } from '@playwright/test';
import { OVERLAY_SCRIPT, type CardSpec } from './overlay';

// The recording: frames come from the browser's screencast of the page in front (JPEG, at the
// device pixel size, so 1280x720 at scale 1.5 gives 1920x1080 frames), each with its wall-clock
// time. A "shot" is a stretch of wall-clock time on one page that goes into the video, at normal
// speed or marked fast (the editor speeds it up). Everything between shots (page loads, waits
// that add nothing) is cut. The timeline (frames, shots, beats) is written to JSON, so the edit
// in post.ts is deterministic and can be redone without recording again.

export type Frame = { f: string; t: number };
export type ShotKind = 'normal' | 'fast';
export type Shot = { page: string; from: number; to: number; kind: ShotKind; label: string };
export type Beat = { name: string; t: number };
export type Timeline = {
  version: 1;
  mode: string;
  startedAt: string;
  frameSize: { width: number; height: number };
  pages: Record<string, { label: string; frames: Frame[] }>;
  shots: Shot[];
  beats: Beat[];
  notes: Record<string, unknown>;
};

type PageRec = {
  id: string;
  label: string;
  page: Page;
  dir: string;
  frames: Frame[];
  cdp?: CDPSession;
  streaming: boolean;
  listening?: boolean;
  nth: number;
};

const NORMAL_NTH = 2; // every 2nd compositor frame: up to 30 fps
const FAST_NTH = 4; // up to 15 fps while the part is sped up anyway

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Stage {
  private recs = new Map<Page, PageRec>();
  private active?: PageRec;
  private mode: 'off' | ShotKind = 'off';
  private segStart = 0;
  private label = '';
  private segLabel = '';
  private captionText = '';
  private whereText: string | null | undefined = undefined;
  private writes = new Set<Promise<void>>();
  readonly shots: Shot[] = [];
  readonly beats: Beat[] = [];
  readonly notes: Record<string, unknown> = {};
  private seq = 0;

  constructor(
    readonly runDir: string,
    readonly mode0: string,
    readonly viewport = { width: 1280, height: 720 },
    readonly frameSize = { width: 1920, height: 1080 },
  ) {
    mkdirSync(join(runDir, 'frames'), { recursive: true });
  }

  /** 'off' between shots, else the kind of the shot being recorded. */
  get speed(): 'off' | ShotKind {
    return this.mode;
  }

  get page(): Page {
    if (!this.active) throw new Error('no page in front');
    return this.active.page;
  }

  log(msg: string, data?: unknown): void {
    const t = new Date().toISOString().slice(11, 19);
    console.log(`[demo ${t}] ${msg}${data === undefined ? '' : ' ' + JSON.stringify(data)}`);
  }

  beat(name: string): void {
    this.label = name;
    this.beats.push({ name, t: Date.now() });
    this.log(`beat: ${name}`);
  }

  private rec(page: Page, label: string): PageRec {
    let r = this.recs.get(page);
    if (!r) {
      const id = `p${this.recs.size + 1}`;
      r = { id, label, page, dir: join(this.runDir, 'frames', id), frames: [], streaming: false, nth: NORMAL_NTH };
      mkdirSync(r.dir, { recursive: true });
      this.recs.set(page, r);
    }
    return r;
  }

  private async startStream(r: PageRec, nth: number, restart = false): Promise<void> {
    if (!r.cdp || !r.listening) {
      r.listening = true;
      await this.session(r);
      r.cdp!.on('Page.screencastFrame', (ev: { data: string; sessionId: number; metadata?: { timestamp?: number } }) => {
        void r.cdp?.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => undefined);
        const now = Date.now();
        const meta = ev.metadata?.timestamp ? ev.metadata.timestamp * 1000 : NaN;
        const t = Number.isFinite(meta) && Math.abs(meta - now) < 2000 ? meta : now;
        const f = join(r.dir, `${String(++this.seq).padStart(6, '0')}.jpg`);
        const w = writeFile(f, Buffer.from(ev.data, 'base64')).then(() => {
          r.frames.push({ f, t });
          this.writes.delete(w);
        });
        this.writes.add(w);
      });
    }
    if (r.streaming && r.nth === nth && !restart) return;
    if (r.streaming) await r.cdp!.send('Page.stopScreencast').catch(() => undefined);
    r.nth = nth;
    await r.cdp!.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 84,
      maxWidth: this.frameSize.width,
      maxHeight: this.frameSize.height,
      everyNthFrame: nth,
    });
    r.streaming = true;
  }

  private async session(r: PageRec): Promise<CDPSession> {
    r.cdp ??= await r.page.context().newCDPSession(r.page);
    return r.cdp;
  }

  /**
   * Makes the page's window show exactly the viewport (1280x720 CSS px). The screencast sends
   * what the window shows, so a headless window's simulated toolbar must not take the bottom.
   */
  private async fitWindow(r: PageRec): Promise<void> {
    const want = this.viewport;
    try {
      const cdp = await this.session(r);
      for (let i = 0; i < 3; i++) {
        const [iw, ih, ow, oh] = await r.page.evaluate(() => [innerWidth, innerHeight, outerWidth, outerHeight]);
        if (iw === want.width && ih === want.height) return;
        const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
        await cdp.send('Browser.setWindowBounds', {
          windowId,
          bounds: { width: ow! + want.width - iw!, height: oh! + want.height - ih! },
        });
        await sleep(250);
      }
      const size = await r.page.evaluate(() => [innerWidth, innerHeight]);
      this.log(`warning: the ${r.label} window shows ${size.join('x')}, not ${want.width}x${want.height}`);
    } catch (e) {
      this.log(`warning: could not fit the ${r.label} window: ${String(e).split('\n')[0]}`);
    }
  }

  private async stopStream(r: PageRec): Promise<void> {
    if (!r.streaming) return;
    r.streaming = false;
    await r.cdp?.send('Page.stopScreencast').catch(() => undefined);
  }

  /** Puts `page` in front: cuts the current shot, moves the screencast, re-applies the overlay. */
  async show(page: Page, label = 'page'): Promise<void> {
    await this.cut();
    const fresh = !this.recs.has(page);
    const r = this.rec(page, label);
    if (this.active && this.active !== r) await this.stopStream(this.active);
    this.active = r;
    this.whereText = undefined;
    if (fresh) await this.fitWindow(r);
    await page.bringToFront().catch(() => undefined);
    await this.overlay();
    await this.startStream(r, NORMAL_NTH);
  }

  /** Brings the page in front back to the top (a tab the extension opens takes the focus). */
  async front(): Promise<void> {
    await this.page.bringToFront().catch(() => undefined);
  }

  /** The overlay on the page in front (again after a navigation), with the current caption. */
  async overlay(): Promise<void> {
    const page = this.page;
    for (let i = 0; i < 3; i++) {
      try {
        await page.evaluate(OVERLAY_SCRIPT);
        // After a navigation (possibly into another renderer) the screencast is started again.
        if (this.active && this.active.streaming) await this.startStream(this.active, this.active.nth, true);
        await page.evaluate(
          ([text, where]) => {
            const w = window as unknown as { __caption(t: string, w?: string | null): void; __where(w?: string | null): void };
            if (where === '__auto__') w.__where(undefined);
            else w.__where(where);
            w.__caption(text);
          },
          [this.captionText, this.whereText === undefined ? '__auto__' : this.whereText] as const,
        );
        return;
      } catch {
        await sleep(400);
      }
    }
  }

  /** Waits until the page in front has given a frame after `since`. */
  private async freshFrame(since: number, timeoutMs = 2500): Promise<void> {
    const r = this.active!;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      await Promise.all([...this.writes]);
      if (r.frames.some((f) => f.t >= since)) return;
      await sleep(60);
    }
    this.log(`warning: no fresh frame from ${r.id} within ${timeoutMs} ms`);
  }

  private close(): void {
    if (this.mode === 'off' || !this.active) return;
    const to = Date.now();
    if (to - this.segStart > 40) {
      this.shots.push({ page: this.active.id, from: this.segStart, to, kind: this.mode, label: this.segLabel });
    }
    this.mode = 'off';
  }

  /** Starts (or continues) a normal-speed shot. */
  async roll(label?: string): Promise<void> {
    if (label) this.label = label;
    if (this.mode === 'normal') return;
    const wasFast = this.mode === 'fast';
    this.close();
    if (wasFast) await this.setFast(false);
    const since = Date.now();
    await this.nudge();
    await this.freshFrame(since);
    this.mode = 'normal';
    this.segStart = Date.now();
    this.segLabel = this.label;
  }

  /** From now on the shot is sped up in the edit (a "Sped up" badge shows meanwhile). */
  async fast(label?: string): Promise<void> {
    if (label) this.label = label;
    if (this.mode === 'fast') return;
    this.close();
    await this.setFast(true);
    const since = Date.now();
    await this.freshFrame(since);
    this.mode = 'fast';
    this.segStart = Date.now();
    this.segLabel = this.label;
  }

  /** Ends the current shot: what follows is not in the video until the next roll(). */
  async cut(): Promise<void> {
    const wasFast = this.mode === 'fast';
    this.close();
    if (wasFast) await this.setFast(false);
  }

  private async setFast(on: boolean): Promise<void> {
    const r = this.active!;
    await r.page.evaluate((v) => (window as unknown as { __fast(v: boolean): void }).__fast(v), on).catch(() => undefined);
    await this.startStream(r, on ? FAST_NTH : NORMAL_NTH);
  }

  /** A tiny repaint, so the screencast sends a frame now. */
  private async nudge(): Promise<void> {
    await this.page
      .evaluate(() => {
        const d = document.documentElement;
        d.style.setProperty('--recall-demo-nudge', String(Math.random()));
        d.style.outline = '0.01px solid transparent';
        requestAnimationFrame(() => (d.style.outline = ''));
      })
      .catch(() => undefined);
  }

  /** Sets the caption (an empty string hides the bar). */
  async say(text: string, holdMs = 0): Promise<void> {
    this.captionText = text;
    await this.page
      .evaluate((t) => (window as unknown as { __caption(t: string): void }).__caption(t), text)
      .catch(async () => {
        await this.overlay();
      });
    if (text) this.log(`caption: ${text}`);
    if (holdMs) await sleep(holdMs);
  }

  /** Overrides the address line above the caption (null hides it, undefined = the page's URL). */
  async where(text: string | null | undefined): Promise<void> {
    this.whereText = text;
    await this.page
      .evaluate((w) => (window as unknown as { __where(w?: string | null): void }).__where(w === '__auto__' ? undefined : w), text === undefined ? '__auto__' : text)
      .catch(() => undefined);
  }

  async card(spec: CardSpec | null, holdMs = 0): Promise<void> {
    await this.page.evaluate((s) => (window as unknown as { __card(s: unknown): void }).__card(s), spec).catch(() => undefined);
    if (holdMs) await sleep(holdMs);
  }

  /** Scrolls `loc` into a comfortable spot (above the caption bar) if needed, then rings it. */
  async point(loc: Locator, holdMs = 1200, timeoutMs = 30_000): Promise<void> {
    await loc.waitFor({ state: 'visible', timeout: timeoutMs });
    const moved = await loc.evaluate((el) => {
      const r = el.getBoundingClientRect();
      if (r.top >= 64 && r.bottom <= window.innerHeight - 130) return false;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    });
    if (moved) await sleep(900);
    const box = await loc.boundingBox();
    if (box) {
      await this.page.evaluate((b) => (window as unknown as { __highlight(b: unknown): void }).__highlight(b), box);
    }
    await sleep(holdMs);
  }

  /** Rings `loc`, shows a tap, then clicks it. */
  async press(loc: Locator, holdMs = 1000): Promise<void> {
    await this.point(loc, holdMs);
    await this.page.evaluate(() => (window as unknown as { __tap(): void }).__tap()).catch(() => undefined);
    await sleep(180);
    await loc.click();
    await sleep(700);
  }

  /** Scrolls the page in front smoothly to `y` (CSS px from the top). */
  async scrollTo(y: number, waitMs = 1100): Promise<void> {
    await this.page.evaluate((top) => window.scrollTo({ top, behavior: 'smooth' }), y);
    await sleep(waitMs);
  }

  /** Waits for every frame on disk, stops all screencasts, and writes the timeline. */
  async finish(path: string): Promise<Timeline> {
    await this.cut();
    for (const r of this.recs.values()) await this.stopStream(r);
    await Promise.all([...this.writes]);
    const timeline: Timeline = {
      version: 1,
      mode: this.mode0,
      startedAt: new Date(this.beats[0]?.t ?? Date.now()).toISOString(),
      frameSize: this.frameSize,
      pages: Object.fromEntries(
        [...this.recs.values()].map((r) => [r.id, { label: r.label, frames: [...r.frames].sort((a, b) => a.t - b.t) }]),
      ),
      shots: this.shots,
      beats: this.beats,
      notes: this.notes,
    };
    writeFileSync(path, JSON.stringify(timeline, null, 1));
    return timeline;
  }
}
