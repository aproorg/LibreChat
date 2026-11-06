import { SearchError } from '@librechat/data-schemas';
import type { SearchTier } from '../metrics';
import type { TieredRow } from './rank';
import type { PlanRead } from './plan';
import { planBatches } from './plan';
import { rankHits } from './rank';

/** `/search`'s page (FR-013). */
export const SEARCH_PAGE_SIZE = 25;
/** FR-015's staleness bound on the ranked window. */
export const SHARED_READ_TTL_MS = 30_000;

/** Rough heap cost of one row and of an entry's frame, for the byte budget. */
const ESTIMATED_ROW_BYTES = 256;
const ESTIMATED_ENTRY_BYTES = 1024;

export interface SharedReadOptions<T> {
  ttlMs: number;
  maxBytes: number;
  sizeOf(value: T): number;
  now?: () => number;
}

/**
 * Single-flight by key, kept for a short time. A read counts once however many
 * surfaces wait on it, one waiter leaving is not a failure for the others, and the
 * read aborts only when the last one leaves. Failures are never kept.
 */
export interface SharedRead<T> {
  get(key: string, signal: AbortSignal, start: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

interface Flight<T> {
  controller: AbortController;
  promise: Promise<T>;
  waiters: number;
}

interface StoredRead<T> {
  value: T;
  startedAt: number;
  bytes: number;
}

export function createSharedRead<T>(options: SharedReadOptions<T>): SharedRead<T> {
  const { ttlMs, maxBytes, sizeOf, now = Date.now } = options;
  const flights = new Map<string, Flight<T>>();
  const stored = new Map<string, StoredRead<T>>();
  let storedBytes = 0;
  let sweep: ReturnType<typeof setTimeout> | undefined;

  const remove = (key: string) => {
    const entry = stored.get(key);
    if (entry) {
      storedBytes -= entry.bytes;
      stored.delete(key);
    }
  };

  const keep = (key: string, value: T, startedAt: number) => {
    const bytes = sizeOf(value);
    if (bytes > maxBytes) {
      return;
    }
    remove(key);
    stored.set(key, { value, startedAt, bytes });
    storedBytes += bytes;
    for (const oldest of stored.keys()) {
      if (storedBytes <= maxBytes) {
        break;
      }
      remove(oldest);
    }
    scheduleSweep();
  };

  /* Query words sit in the keys, so an entry past its time goes even if searching stops. */
  const scheduleSweep = () => {
    if (sweep !== undefined || stored.size === 0) {
      return;
    }
    sweep = setTimeout(() => {
      sweep = undefined;
      for (const [key, entry] of stored) {
        if (now() - entry.startedAt >= ttlMs) {
          remove(key);
        }
      }
      scheduleSweep();
    }, ttlMs);
    sweep.unref?.();
  };

  const launch = (key: string, start: (signal: AbortSignal) => Promise<T>): Flight<T> => {
    const controller = new AbortController();
    const startedAt = now();
    const flight: Flight<T> = {
      controller,
      waiters: 0,
      promise: start(controller.signal).then(
        (value) => {
          /* Measured from the start, so what a surface sees is never older than the bound. */
          if (flights.get(key) === flight) {
            flights.delete(key);
            keep(key, value, startedAt);
          }
          return value;
        },
        (error: unknown) => {
          if (flights.get(key) === flight) {
            flights.delete(key);
          }
          throw error;
        },
      ),
    };
    flights.set(key, flight);
    return flight;
  };

  return {
    get(key, signal, start) {
      if (signal.aborted) {
        return Promise.reject(new SearchError('search_busy'));
      }
      const entry = stored.get(key);
      if (entry) {
        if (now() - entry.startedAt < ttlMs) {
          return Promise.resolve(entry.value);
        }
        remove(key);
      }
      const flight = flights.get(key) ?? launch(key, start);
      flight.waiters += 1;
      return new Promise<T>((resolve, reject) => {
        const leave = () => {
          signal.removeEventListener('abort', onAbort);
          flight.waiters -= 1;
        };
        function onAbort() {
          leave();
          if (flight.waiters === 0) {
            if (flights.get(key) === flight) {
              flights.delete(key);
            }
            flight.controller.abort();
          }
          reject(new SearchError('search_busy'));
        }
        signal.addEventListener('abort', onAbort, { once: true });
        flight.promise.then(
          (value) => {
            if (!signal.aborted) {
              leave();
              resolve(value);
            }
          },
          (error: unknown) => {
            if (!signal.aborted) {
              leave();
              reject(error);
            }
          },
        );
      });
    },
  };
}

export const estimatePlanReadBytes = ({ rowsByJob }: PlanRead): number =>
  ESTIMATED_ENTRY_BYTES +
  rowsByJob.reduce((total, rows) => total + rows.length * ESTIMATED_ROW_BYTES, 0);

/** Sized for the larger surface, so a page replayed from it never depends on who fired first. */
export const sharedReadSize = ({
  rankWindow,
  sidebarLimit,
}: {
  rankWindow: number;
  sidebarLimit: number;
}) => ({
  need: Math.max(SEARCH_PAGE_SIZE, sidebarLimit),
  window: Math.max(rankWindow, SEARCH_PAGE_SIZE, sidebarLimit),
});

export interface DeriveOptions {
  /** How many ranked rows this surface shows. */
  limit: number;
  rankWindow: number;
  readConcurrency: number;
  lengthBucket: boolean;
}

export interface DerivedHits {
  hits: TieredRow[];
  tierReached: SearchTier;
}

/**
 * One surface's answer, as a pure function of the read: replays the read's stop rule
 * at this surface's size, as if the read had been made for it, then ranks. Each job's
 * rows are newest first, so its first `window` rows are what a smaller read returns.
 */
export function deriveRanked(read: PlanRead, options: DeriveOptions): DerivedHits {
  const { limit, rankWindow, readConcurrency, lengthBucket } = options;
  const window = Math.max(rankWindow, limit);
  const { plan, rowsByJob } = read;
  const seen = new Map<string, TieredRow>();

  for (const batch of planBatches(plan, readConcurrency)) {
    if (seen.size >= limit) {
      break;
    }
    for (const index of batch) {
      for (const row of (rowsByJob[index] ?? []).slice(0, window)) {
        if (!seen.has(row._id)) {
          seen.set(row._id, { ...row, tier: plan.jobs[index].tier });
        }
      }
    }
  }

  const rows = [...seen.values()];
  const hits = rankHits(rows, [plan.words[plan.driver]], { lengthBucket }).slice(0, limit);
  const tierReached = rows.reduce<SearchTier>(
    (lowest, { tier }) => (tierOrder(tier) > tierOrder(lowest) ? tier : lowest),
    'none',
  );
  return { hits, tierReached };
}

const TIER_ORDER: readonly SearchTier[] = ['none', 'exact', 'lemma', 'part', 'prefix', 'typo'];
const tierOrder = (tier: SearchTier): number => TIER_ORDER.indexOf(tier);
