import { SearchError } from '@librechat/data-schemas';
import { SEARCH_PAGE_SIZE } from 'librechat-data-provider';
import type { SearchMethods } from '@librechat/data-schemas';
import type { Analyzer } from '../analyzer/analyze';
import type { SearchReadRunner } from './retry';
import type { SearchTier } from '../metrics';
import type { TieredRow } from './rank';
import type { PlanRead } from './plan';
import { proximityCandidates, rankHits, wordTiers } from './rank';
import { readProximity } from './proximity';
import { planBatches } from './plan';

/** `/search`'s page (FR-013). Shared with the client, which reads a shorter page as thinned. */
export { SEARCH_PAGE_SIZE };
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
  /* One past the page, so a read that fills it exactly still looks for what load-more owes. */
  need: Math.max(SEARCH_PAGE_SIZE + 1, sidebarLimit),
  window: Math.max(rankWindow, SEARCH_PAGE_SIZE, sidebarLimit),
});

export interface DeriveOptions {
  /** How many ranked rows this surface shows. */
  limit: number;
  rankWindow: number;
  lengthBucket: boolean;
}

export interface DerivedCandidates {
  rows: TieredRow[];
  tierReached: SearchTier;
  /** Whether matches may exist beyond these rows: the replay stopped early, or a job was cut. */
  more: boolean;
}

export interface DerivedHits {
  hits: TieredRow[];
  tierReached: SearchTier;
  /** Whether load-more may find anything after `hits`. */
  more: boolean;
}

/** What multi-word ranking reads: each candidate's tokens, and the top candidates' text. */
export interface RankReads {
  user: string;
  run: SearchReadRunner;
  methods: Pick<SearchMethods, 'readRecordTokens' | 'readMessageTexts'>;
  analyzer: Pick<Analyzer, 'analyzeWord'>;
  /** The search's signal and deadline, for the ranking work between its reads. */
  signal?: AbortSignal;
  deadline?: number;
}

/**
 * One surface's candidates, as a pure function of the read: replays the read's stop
 * rule at this surface's size, as if the read had been made for it. Each job's rows are
 * newest first, so its first `window` rows are what a smaller read returns.
 */
export function deriveCandidates(
  read: PlanRead,
  { limit, rankWindow }: Pick<DeriveOptions, 'limit' | 'rankWindow'>,
): DerivedCandidates {
  const window = Math.max(rankWindow, limit);
  const { jobs, rowsByJob } = read;
  const seen = new Map<string, TieredRow>();
  let more = false;

  for (const batch of planBatches(jobs)) {
    if (seen.size >= limit) {
      more = true;
      break;
    }
    for (const index of batch) {
      const rows = rowsByJob[index] ?? [];
      more = more || rows.length >= window;
      for (const row of rows.slice(0, window)) {
        if (!seen.has(row._id)) {
          seen.set(row._id, { ...row, tier: jobs[index].tier, stage: jobs[index].stage });
        }
      }
    }
  }

  const rows = [...seen.values()];
  const tierReached = rows.reduce<SearchTier>(
    (lowest, { tier }) => (tierOrder(tier) > tierOrder(lowest) ? tier : lowest),
    'none',
  );
  return { rows, tierReached, more: more || rows.length > limit };
}

/**
 * A surface's ranked rows without reading anything more. One word ranks fully. Several
 * words rank by the stage and tier that found each row, which is all the sidebar needs:
 * it shows conversations, not an order (R-08).
 */
export function deriveRanked(read: PlanRead, options: DeriveOptions): DerivedHits {
  const { rows, tierReached, more } = deriveCandidates(read, options);
  const hits = rankHits(rows, read.plan.words, { lengthBucket: options.lengthBucket });
  return { hits: hits.slice(0, options.limit), tierReached, more };
}

/**
 * `/search`'s ranked rows. A multi-word query also reads its candidates' tokens, in
 * chunks, for each word's tier, and the top candidates' text for proximity (FR-011).
 */
export async function derivePage(
  read: PlanRead,
  options: DeriveOptions,
  reads: RankReads,
): Promise<DerivedHits> {
  const { words } = read.plan;
  const { rows, tierReached, more } = deriveCandidates(read, options);
  if (words.length < 2 || rows.length === 0) {
    const hits = rankHits(rows, words, { lengthBucket: options.lengthBucket });
    return { hits: hits.slice(0, options.limit), tierReached, more };
  }
  const { user, run, methods, analyzer, signal, deadline } = reads;
  const records = await run((read_) =>
    methods.readRecordTokens({ user, ids: rows.map(({ _id }) => _id) }, read_),
  );
  const masks = new Map(records.map(({ _id, tokens }) => [_id, wordTiers(words, tokens)]));
  const ranking = { lengthBucket: options.lengthBucket, masks };
  const proximity = await readProximity({
    user,
    rows: proximityCandidates(rows, words, ranking),
    words,
    analyzer,
    run,
    methods,
    signal,
    deadline,
  });
  const hits = rankHits(rows, words, { ...ranking, proximity });
  return { hits: hits.slice(0, options.limit), tierReached, more };
}

const TIER_ORDER: readonly SearchTier[] = ['none', 'exact', 'lemma', 'part', 'prefix', 'typo'];
const tierOrder = (tier: SearchTier): number => TIER_ORDER.indexOf(tier);
