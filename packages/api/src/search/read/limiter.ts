import { SearchError } from '@librechat/data-schemas';
import { stopWhen } from './retry';

export interface SearchLimiterScope {
  /** Fires at the timeout, or when the caller's signal does. */
  signal: AbortSignal;
  /** Epoch milliseconds of the timeout. */
  deadline: number;
}

/** One process's cap on running searches. A search at the cap fails at once: no queue (FR-017). */
export interface SearchLimiter {
  run<T>(signal: AbortSignal, work: (scope: SearchLimiterScope) => Promise<T>): Promise<T>;
  active(): number;
}

export function createSearchLimiter({
  maxConcurrent,
  timeoutMs,
}: {
  maxConcurrent: number;
  timeoutMs: number;
}): SearchLimiter {
  let active = 0;

  return {
    active: () => active,
    async run<T>(signal: AbortSignal, work: (scope: SearchLimiterScope) => Promise<T>): Promise<T> {
      if (active >= maxConcurrent) {
        throw new SearchError('search_busy');
      }
      active += 1;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      const deadline = Date.now() + timeoutMs;
      try {
        return await stopWhen(work({ signal: controller.signal, deadline }), controller.signal);
      } finally {
        active -= 1;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    },
  };
}
