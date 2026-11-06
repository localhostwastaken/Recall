import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Frame, Shot, Timeline } from './stage';

// The edit: turns a recorded timeline (frames with wall-clock times, shots, beats) into one
// H.264 video. Normal shots play at real speed. Fast shots (marked "Sped up" on screen) get the
// time that is left under the budget, played at least 4x; each keeps a short, readable stretch.
// The frames of every shot are listed with their exact on-screen durations in an ffconcat file,
// so the cut points are the logged timestamps, nothing else.
//
// Run again on a kept recording: pnpm tsx e2e/demo/post.ts <run-dir>/timeline.json [--out file.mp4]

export const FFMPEG = process.env.FFMPEG || (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
export const FFPROBE = process.env.FFPROBE || (existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe');

export type EditShot = Shot & { rawS: number; outS: number; speed: number; at: number };
export type EditResult = { out: string; durationS: number; shots: EditShot[]; overBudgetS: number; listFile: string };

const MIN_FAST_SPEED = 4;
const FAST_MAX_OUT_S = 3.5;

/** Output seconds of each shot under `budgetS` (normal shots are never shortened). */
export function plan(shots: Shot[], budgetS: number): EditShot[] {
  const raw = shots.map((s) => Math.max(0, (s.to - s.from) / 1000));
  const normal = shots.reduce((n, s, i) => n + (s.kind === 'normal' ? raw[i]! : 0), 0);
  const out = shots.map((s, i) => {
    const r = raw[i]!;
    // At least 4x, and never more than FAST_MAX_OUT_S on screen.
    return s.kind === 'normal' ? r : Math.min(r / MIN_FAST_SPEED, FAST_MAX_OUT_S);
  });
  const fastIdx = shots.map((s, i) => (s.kind === 'fast' ? i : -1)).filter((i) => i >= 0);
  let fastOut = fastIdx.reduce((n, i) => n + out[i]!, 0);
  const room = budgetS - normal;
  if (fastIdx.length && normal + fastOut > budgetS) {
    // Squeeze the fast parts (never below 0.8 s each) to fit the budget.
    const floor = (i: number) => Math.min(0.8, raw[i]!);
    for (let pass = 0; pass < 5 && fastOut > Math.max(room, 0) + 1e-6; pass++) {
      const k = Math.max(room, 0) / fastOut;
      for (const i of fastIdx) out[i] = Math.max(floor(i), out[i]! * k);
      fastOut = fastIdx.reduce((n, i) => n + out[i]!, 0);
    }
  }
  let at = 0;
  return shots.map((s, i) => {
    const e: EditShot = { ...s, rawS: raw[i]!, outS: out[i]!, speed: out[i]! > 0 ? raw[i]! / out[i]! : 1, at };
    at += out[i]!;
    return e;
  });
}

/** Index of the last frame shown at or before `t` (frames sorted by time); 0 when none is. */
function frameAt(frames: Frame[], t: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.t <= t) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export function assemble(timelinePath: string, outPath: string, opts: { budgetS?: number; fps?: number } = {}): EditResult {
  const tl = JSON.parse(readFileSync(timelinePath, 'utf8')) as Timeline;
  const budgetS = opts.budgetS ?? 178;
  const fps = opts.fps ?? 30;
  const shots = plan(tl.shots, budgetS);
  const lines = ['ffconcat version 1.0'];
  let last = '';
  let total = 0;
  const q = (f: string) => `'${f.replace(/'/g, "'\\''")}'`;
  for (const s of shots) {
    const frames = tl.pages[s.page]?.frames ?? [];
    if (!frames.length || s.outS <= 0) continue;
    const k0 = frameAt(frames, s.from);
    for (let k = k0; k < frames.length && frames[k]!.t < s.to; k++) {
      const a = k === k0 ? s.from : Math.max(frames[k]!.t, s.from);
      const b = Math.min(frames[k + 1]?.t ?? s.to, s.to);
      const d = (b - a) / 1000 / s.speed;
      if (d <= 0) continue;
      lines.push(`file ${q(frames[k]!.f)}`, `duration ${d.toFixed(5)}`);
      last = frames[k]!.f;
      total += d;
    }
  }
  if (!last) throw new Error('nothing to edit: the timeline has no frames inside its shots');
  lines.push(`file ${q(last)}`);
  const listFile = join(dirname(timelinePath), 'edit.ffconcat');
  writeFileSync(listFile, lines.join('\n') + '\n');

  const { width, height } = tl.frameSize;
  const fadeOut = Math.max(0, total - 0.7).toFixed(2);
  const vf = [
    // JPEG frames are full range; the video is limited-range yuv420p (what every player expects).
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos:in_range=full:out_range=limited`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0xfffdf5`,
    `fps=${fps}`,
    'format=yuv420p',
    'fade=t=in:st=0:d=0.4',
    `fade=t=out:st=${fadeOut}:d=0.7`,
  ].join(',');
  execFileSync(
    FFMPEG,
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', vf, '-r', String(fps), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-movflags', '+faststart', '-an', outPath],
    { stdio: 'inherit' },
  );
  const durationS = Number(
    execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outPath]).toString().trim(),
  );
  const edl = shots.map((s) => ({
    at: s.at.toFixed(1),
    out: s.outS.toFixed(1),
    raw: s.rawS.toFixed(1),
    speed: s.kind === 'fast' ? `${s.speed.toFixed(1)}x` : '1x',
    page: s.page,
    label: s.label,
  }));
  writeFileSync(join(dirname(timelinePath), 'edit.json'), JSON.stringify({ out: outPath, durationS, budgetS, shots: edl }, null, 1));
  return { out: outPath, durationS, shots, overBudgetS: Math.max(0, durationS - budgetS), listFile };
}

// CLI: tsx e2e/demo/post.ts <timeline.json> [--out file.mp4] [--budget 178]
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const tlPath = args.find((a) => !a.startsWith('--'));
  if (!tlPath) {
    console.error('usage: tsx e2e/demo/post.ts <timeline.json> [--out file.mp4] [--budget 178]');
    process.exit(2);
  }
  const flag = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = flag('--out') ?? join(dirname(tlPath), 'demo.mp4');
  const r = assemble(resolve(tlPath), resolve(out), { budgetS: flag('--budget') ? Number(flag('--budget')) : undefined });
  console.table(r.shots.map((s) => ({ at: s.at.toFixed(1), out: s.outS.toFixed(1), speed: s.speed.toFixed(1), kind: s.kind, label: s.label })));
  console.log(`wrote ${r.out} (${r.durationS.toFixed(1)} s)`);
}
