/** Thrown for queued checks that `cancelAll` dropped before they started. */
function abortError(): Error {
  const e = new Error('The check was cancelled');
  e.name = 'AbortError';
  return e;
}

/**
 * Runs at most `limit` checks at once (the library verifies the cards in view, three at a time,
 * so a long list never opens hundreds of downloads). `cancelAll` drops the jobs still waiting;
 * jobs already running finish (they have their own abort signal).
 */
export function createVerifyQueue(limit = 3) {
  type Job = { start: () => void; cancel: () => void };
  const waiting: Job[] = [];
  let active = 0;
  const pump = () => {
    while (active < limit && waiting.length > 0) waiting.shift()!.start();
  };
  return {
    run<T>(job: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        waiting.push({
          start: () => {
            active++;
            Promise.resolve()
              .then(job)
              .then(resolve, reject)
              .finally(() => {
                active--;
                pump();
              });
          },
          cancel: () => reject(abortError()),
        });
        pump();
      });
    },
    cancelAll(): void {
      for (const j of waiting.splice(0)) j.cancel();
    },
  };
}

export type VerifyQueue = ReturnType<typeof createVerifyQueue>;
