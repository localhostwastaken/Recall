import { describe, expect, it } from 'vitest';
import { createVerifyQueue } from '../src/library/queue';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createVerifyQueue', () => {
  it('never runs more than the limit at once and runs every job', async () => {
    const q = createVerifyQueue(3);
    let inFlight = 0;
    let peak = 0;
    const jobs = Array.from({ length: 10 }, (_, i) =>
      q.run(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5 + (i % 3)));
        inFlight--;
        return i;
      }),
    );
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBe(3);
  });

  it('keeps going after a job fails', async () => {
    const q = createVerifyQueue(1);
    const bad = q.run(async () => {
      throw new Error('boom');
    });
    const good = q.run(async () => 'ok');
    await expect(bad).rejects.toThrow('boom');
    expect(await good).toBe('ok');
  });

  it('cancelAll rejects the jobs still waiting with an AbortError', async () => {
    const q = createVerifyQueue(1);
    let release!: () => void;
    const first = q.run(() => new Promise<string>((r) => (release = () => r('first'))));
    const waiting = q.run(async () => 'never');
    await tick();
    q.cancelAll();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    release();
    expect(await first).toBe('first');
  });
});
