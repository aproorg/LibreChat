import { SearchError } from '@librechat/data-schemas';
import { stopWhen } from './retry';

export interface SearchLimiterScope {
  /** Fires at the timeout, or when the caller's signal does. */
  signal: AbortSignal;
  /** Epoch milliseconds of the timeout. */
  deadline: number;
}

/**
 * One process's cap on running searches. A search at the cap fails at once: no queue (FR-017).
 * A user's own share of the cap is smaller, so one user's parallel requests cannot hold every
 * slot and turn everyone else's search into `search_busy`.
 */
export interface SearchLimiter {
  run<T>(
    signal: AbortSignal,
    work: (scope: SearchLimiterScope) => Promise<T>,
    user?: string,
  ): Promise<T>;
  active(): number;
}

/** Half the cap, and at least one: what a single user may hold of it. */
export const userShare = (maxConcurrent: number): number =>
  Math.max(1, Math.ceil(maxConcurrent / 2));

export function createSearchLimiter({
  maxConcurrent,
  maxPerUser = maxConcurrent,
  timeoutMs,
}: {
  maxConcurrent: number;
  /** Most slots one user holds at once. Applies to a `run` that names its user. */
  maxPerUser?: number;
  timeoutMs: number;
}): SearchLimiter {
  let active = 0;
  const held = new Map<string, number>();

  return {
    active: () => active,
    async run<T>(
      signal: AbortSignal,
      work: (scope: SearchLimiterScope) => Promise<T>,
      user?: string,
    ): Promise<T> {
      const mine = user == null ? 0 : (held.get(user) ?? 0);
      if (active >= maxConcurrent || mine >= maxPerUser) {
        throw new SearchError('search_busy');
      }
      active += 1;
      if (user != null) {
        held.set(user, mine + 1);
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      const deadline = Date.now() + timeoutMs;
      try {
        return await stopWhen(work({ signal: controller.signal, deadline }), controller.signal);
      } finally {
        active -= 1;
        if (user != null) {
          const left = (held.get(user) ?? 1) - 1;
          if (left > 0) {
            held.set(user, left);
          } else {
            held.delete(user);
          }
        }
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    },
  };
}
