import { isSearchError, SearchError } from '@librechat/data-schemas';
import type { SearchReadOptions } from '@librechat/data-schemas';
import type { SearchMetrics, SearchSurface } from '../metrics';
import { safeFailure } from '../failure';

const CURSOR_LIMIT_CODE = 2;
const CURSOR_LIMIT_TEXT = 'Cannot open a new cursor';
const EXCEEDED_TIME_LIMIT_CODE = 50;
const CURSOR_RETRIES = 2;
const JITTER_MIN_MS = 50;
const JITTER_SPREAD_MS = 150;

/** At most `limit` reads at once, per search. Reads past it wait their turn. */
export interface ReadGate {
  run<T>(read: () => Promise<T>): Promise<T>;
}

export function createReadGate(limit: number): ReadGate {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async run<T>(read: () => Promise<T>): Promise<T> {
      if (active >= limit) {
        /* The slot is handed over, still counted, so a read arriving meanwhile cannot take it too. */
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else {
        active += 1;
      }
      try {
        return await read();
      } finally {
        const next = waiting.shift();
        if (next) {
          next();
        } else {
          active -= 1;
        }
      }
    },
  };
}

/**
 * Settles with `work`, or rejects `search_busy` once the signal fires or the
 * deadline passes. Racing means a stalled connection cannot hold a slot, even where
 * the driver has not noticed yet; `maxTimeMS` is what stops the work on the server.
 */
export function stopWhen<T>(work: Promise<T>, signal: AbortSignal, deadline?: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new SearchError('search_busy'));
    if (signal.aborted) {
      stop();
    }
    signal.addEventListener('abort', stop, { once: true });
    const timer =
      deadline === undefined ? undefined : setTimeout(stop, Math.max(deadline - Date.now(), 0));
    const clear = () => {
      signal.removeEventListener('abort', stop);
      clearTimeout(timer);
    };
    work.then(
      (value) => {
        clear();
        resolve(value);
      },
      (error: unknown) => {
        clear();
        reject(error);
      },
    );
  });
}

const errorCode = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

function isCursorLimit(error: unknown): boolean {
  return (
    errorCode(error) === CURSOR_LIMIT_CODE &&
    error instanceof Error &&
    error.message.includes(CURSOR_LIMIT_TEXT)
  );
}

export interface ReadRunnerOptions {
  surface: SearchSurface;
  signal: AbortSignal;
  /** Epoch milliseconds when this search must have stopped. */
  deadline: number;
  gate: ReadGate;
  metrics: Pick<SearchMetrics, 'cursorError'>;
  logger: { warn(message: string, meta: object): unknown };
  /** Replaces the jitter wait, in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Runs one search read. Every read a search makes goes through this. */
export type SearchReadRunner = <T>(read: (options: SearchReadOptions) => Promise<T>) => Promise<T>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The one wrapper around search reads: it applies the signal and the time left,
 * retries the engine's cursor limit, and turns every failure into a coded error,
 * so a read's own error text never travels further than this function.
 */
export function createReadRunner(options: ReadRunnerOptions): SearchReadRunner {
  const { surface, signal, deadline, gate, metrics, logger, sleep = defaultSleep } = options;

  return async function runRead<T>(read: (options: SearchReadOptions) => Promise<T>): Promise<T> {
    for (let retries = 0; ; retries += 1) {
      try {
        return await gate.run(async () => {
          const maxTimeMS = deadline - Date.now();
          if (signal.aborted || maxTimeMS <= 0) {
            throw new SearchError('search_busy');
          }
          return stopWhen(read({ maxTimeMS, signal }), signal, deadline);
        });
      } catch (error) {
        if (isSearchError(error)) {
          throw error;
        }
        if (signal.aborted || Date.now() >= deadline) {
          throw new SearchError('search_busy');
        }
        if (isCursorLimit(error)) {
          const final = retries === CURSOR_RETRIES;
          metrics.cursorError({ surface, retries, final });
          if (final) {
            throw new SearchError('search_busy');
          }
          await stopWhen(sleep(JITTER_MIN_MS + Math.random() * JITTER_SPREAD_MS), signal, deadline);
          continue;
        }
        if (errorCode(error) === EXCEEDED_TIME_LIMIT_CODE) {
          throw new SearchError('search_busy');
        }
        /* The driver's code and code name are stable and say which failure this was: an
         * unsupported option, a missing index and a network error all read as `Error`. */
        logger.warn('[search] Read failed', { ...safeFailure(error), surface });
        throw new SearchError('search_failed');
      }
    }
  };
}
