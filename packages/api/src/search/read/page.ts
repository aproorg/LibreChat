import type { SearchMethods, SearchWindowRow } from '@librechat/data-schemas';
import type { FrozenPlan, PlanExpansions, PlanRead } from './plan';
import type { PrefixBudget, ReadTier } from './tiers';
import type { SearchRealtext } from '../metrics';
import type { SearchReadRunner } from './retry';
import type { SearchCursor } from './cursor';
import { fitPrefix, frozenTierJobs, stageDriver, stageRest, tierTokens, wordTokens } from './plan';
import { expandPrefix, RARE_DF, READ_TIERS } from './tiers';
import { lengthBucket } from './rank';
import { hashId } from './cursor';

/**
 * Reads one load-more request may make. A request that runs out returns a short page
 * with a cursor, so a walk through sparse jobs never becomes one long request.
 */
export const MAX_WALK_READS = 6;

/**
 * A window is re-read by its dates, so late records can add to it. Past this many
 * times `rankWindow` it has overflowed, and the job goes on newest first (R-06). The
 * factor bounds `seen`, and with it the cursor: at 1.25 the worst-case URL, with the
 * longest query in three-byte letters, stays under the 7.5 KB a proxy's request line
 * allows, which `cursor.spec.ts` pins. R-06 planned for 2, which does not fit.
 */
export const WINDOW_OVERFLOW_FACTOR = 1.25;

export interface WalkOptions {
  user: string;
  cursor: SearchCursor;
  pageSize: number;
  rankWindow: number;
  lengthBucket: boolean;
  prefix: PrefixBudget;
  run: SearchReadRunner;
  methods: Pick<SearchMethods, 'readRecordWindow' | 'readRecordTies' | 'readVocabRange'>;
  expansions?: Pick<PlanExpansions, 'prefix'>;
  realtext?: Pick<SearchRealtext, 'addPrefixFanout' | 'addVocabRowsTruncated'>;
}

export interface WalkedPage {
  rows: Array<SearchWindowRow & { tier: ReadTier }>;
  /** `null` once the walk has passed its last job. */
  cursor: SearchCursor | null;
  reads: number;
  rowsRead: number;
}

/** Where page 2 starts: the top of the frozen plan, with page 1's rows excluded (R-06). */
export function firstCursor(read: PlanRead, served: readonly SearchWindowRow[]): SearchCursor {
  return {
    anchor: read.startedAt,
    plan: read.plan,
    stage: 0,
    tier: 0,
    job: 0,
    mode: 'fresh',
    before: null,
    floor: null,
    tieDate: null,
    tieAfter: null,
    first: new Set(served.map(({ _id }) => hashId(_id))),
    seen: new Set(),
    carry: new Set(),
    carryFloor: null,
    sequential: false,
  };
}

const timeOf = (row: SearchWindowRow): number => row.createdAt.getTime();

const newestFirst = (a: SearchWindowRow, b: SearchWindowRow): number =>
  timeOf(b) - timeOf(a) || a._id.localeCompare(b._id);

interface WalkJob {
  tier: ReadTier;
  tokens: string[];
  allOf: string[][];
  noneOf: string[];
}

/**
 * One load-more page: the walk by word set, tier and job from the frozen plan, each job
 * excluding the tokens of earlier jobs, higher tiers and fuller word sets. A job is
 * read in windows of `rankWindow` rows by date. A full read's last date leaves the
 * window, because a limit returns an arbitrary part of one date; that date is then read
 * on its own in `_id` order. A window is ranked and served across pages, re-read by its
 * dates each time, with what it already served remembered by hash.
 *
 * Nothing newer than the anchor enters, and a record appearing mid-pagination either
 * joins a window not yet finished or is left out. It never repeats or displaces a row.
 */
export async function walkPage(options: WalkOptions): Promise<WalkedPage> {
  const { user, pageSize, rankWindow, run, methods, realtext } = options;
  const state: SearchCursor = {
    ...options.cursor,
    plan: structuredClone(options.cursor.plan),
    seen: new Set(options.cursor.seen),
    carry: new Set(options.cursor.carry),
  };
  const { plan } = state;
  const anchor = new Date(state.anchor);
  const overflowAt = Math.floor(rankWindow * WINDOW_OVERFLOW_FACTOR);
  const page: WalkedPage['rows'] = [];
  let reads = 0;
  let rowsRead = 0;
  let ended = false;
  let stopped = false;

  const skipped = (row: SearchWindowRow): boolean => {
    const hash = hashId(row._id);
    return state.first.has(hash) || state.carry.has(hash);
  };
  const room = (): number => pageSize - page.length;

  const resetWindow = () => {
    state.mode = 'fresh';
    state.before = null;
    state.floor = null;
    state.tieDate = null;
    state.tieAfter = null;
    state.seen = new Set();
    state.carry = new Set();
    state.carryFloor = null;
    state.sequential = false;
  };
  const nextJob = () => {
    state.job += 1;
    resetWindow();
  };
  const startTie = (date: number) => {
    state.mode = 'tie';
    state.tieDate = date;
    state.tieAfter = null;
    state.seen = new Set();
  };
  /** The walk's upper date moved to `date`: rows served above an overflowed window's floor are behind it. */
  const moveBefore = (date: number) => {
    state.before = date;
    if (state.carry.size > 0 && state.carryFloor !== null && date <= state.carryFloor) {
      state.carry = new Set();
      state.carryFloor = null;
    }
  };

  const freezePrefix = async (word: FrozenPlan['words'][number], index: number) => {
    const expansion = await (options.expansions?.prefix(word.exact) ??
      expandPrefix(word.exact, options.prefix, { run, methods, realtext }));
    reads += 1;
    rowsRead += expansion.vocabRows ?? 0;
    const known = new Map(plan.common.map((token, at) => [token, RARE_DF + 1 + at]));
    word.prefix = fitPrefix(plan.words, index, expansion, known);
    if (word.prefix.length < expansion.tokens.length) {
      realtext?.addVocabRowsTruncated();
    }
    const fresh = word.prefix
      .filter((token) => (expansion.df.get(token) ?? 0) > RARE_DF && !known.has(token))
      .sort((a, b) => (expansion.df.get(a) ?? 0) - (expansion.df.get(b) ?? 0));
    plan.common = [...plan.common, ...fresh];
  };

  /**
   * The job the cursor points at, moving past tiers and stages that have run out.
   * `'expand'` means the prefix tier is next and its words have not been read yet.
   */
  const settle = (): WalkJob | 'expand' | null => {
    for (;;) {
      if (state.stage >= plan.words.length) {
        return null;
      }
      const tier = READ_TIERS[state.tier];
      if (tier === undefined) {
        state.stage += 1;
        state.tier = 0;
        state.job = 0;
        resetWindow();
        continue;
      }
      const tokens = tierTokens(plan, state.stage, tier);
      if (tokens === undefined) {
        return 'expand';
      }
      const jobs = frozenTierJobs(plan, tier, tokens);
      if (state.job >= jobs.length) {
        state.tier += 1;
        state.job = 0;
        resetWindow();
        continue;
      }
      const higher = READ_TIERS.slice(0, state.tier).flatMap(
        (earlier) => tierTokens(plan, state.stage, earlier) ?? [],
      );
      const fuller = state.stage > 0 ? wordTokens(plan.words[plan.words.length - state.stage]) : [];
      return {
        tier,
        tokens: jobs[state.job].tokens,
        allOf: stageRest(plan, state.stage),
        noneOf: [...higher, ...jobs.slice(0, state.job).flatMap((job) => job.tokens), ...fuller],
      };
    }
  };

  const currentJob = async (): Promise<WalkJob | null> => {
    const settled = settle();
    if (settled !== 'expand') {
      return settled;
    }
    const driver = stageDriver(plan, state.stage);
    await freezePrefix(plan.words[driver], driver);
    return settle() as WalkJob | null;
  };

  const serve = (tier: ReadTier, rows: readonly SearchWindowRow[]) => {
    for (const row of rows) {
      page.push({ ...row, tier });
    }
  };

  /** Ranks what the window still owes and serves what fits. */
  const serveWindow = (tier: ReadTier, rows: readonly SearchWindowRow[]) => {
    const present = new Set(rows.map(({ _id }) => hashId(_id)));
    state.seen = new Set([...state.seen].filter((hash) => present.has(hash)));
    const owed = rows
      .filter((row) => !state.seen.has(hashId(row._id)) && !skipped(row))
      .sort(
        (a, b) =>
          (options.lengthBucket ? lengthBucket(a.n ?? 0) - lengthBucket(b.n ?? 0) : 0) ||
          newestFirst(a, b),
      );
    const taken = owed.slice(0, room());
    serve(tier, taken);
    for (const { _id } of taken) {
      state.seen.add(hashId(_id));
    }
    if (taken.length < owed.length) {
      return;
    }
    if (state.floor === null) {
      nextJob();
    } else {
      startTie(state.floor);
    }
  };

  /** After an overflow: whole dates, newest first, so the position is a date and needs no `seen`. */
  const serveSequential = (
    tier: ReadTier,
    rows: readonly SearchWindowRow[],
    cutDate: number | null,
  ) => {
    const ordered = [...rows].sort(newestFirst);
    for (let start = 0; start < ordered.length; ) {
      const date = timeOf(ordered[start]);
      let end = start;
      while (end < ordered.length && timeOf(ordered[end]) === date) {
        end += 1;
      }
      const group = ordered.slice(start, end).filter((row) => !skipped(row));
      if (group.length > room()) {
        if (page.length > 0) {
          stopped = true;
        } else {
          startTie(date);
        }
        return;
      }
      serve(tier, group);
      moveBefore(date);
      start = end;
    }
    if (cutDate === null) {
      nextJob();
    } else {
      startTie(cutDate);
    }
  };

  while (room() > 0 && reads < MAX_WALK_READS && !stopped) {
    const job = await currentJob();
    if (job === null) {
      ended = true;
      break;
    }
    if (reads >= MAX_WALK_READS) {
      break;
    }
    const { tier } = job;
    const match = { user, tokens: job.tokens, allOf: job.allOf, noneOf: job.noneOf };
    const upper = state.before === null ? { upTo: anchor } : { before: new Date(state.before) };

    if (state.mode === 'tie' && state.tieDate !== null) {
      const date = state.tieDate;
      const afterId = state.tieAfter ?? undefined;
      const rows = await run((read) =>
        methods.readRecordTies({ ...match, at: new Date(date), afterId, limit: rankWindow }, read),
      );
      reads += 1;
      rowsRead += rows.length;
      let consumed = 0;
      for (const row of rows) {
        if (!skipped(row)) {
          if (room() === 0) {
            break;
          }
          serve(tier, [row]);
        }
        state.tieAfter = row._id;
        consumed += 1;
      }
      if (consumed === rows.length && rows.length < rankWindow) {
        state.mode = 'fresh';
        state.tieDate = null;
        state.tieAfter = null;
        moveBefore(date);
      }
      continue;
    }

    if (state.mode === 'window') {
      const range = { ...upper, ...(state.floor !== null ? { after: new Date(state.floor) } : {}) };
      const rows = await run((read) =>
        methods.readRecordWindow({ ...match, range, limit: overflowAt }, read),
      );
      reads += 1;
      rowsRead += rows.length;
      if (rows.length >= overflowAt) {
        state.carry = new Set([...state.carry, ...state.seen]);
        state.carryFloor = state.floor;
        state.seen = new Set();
        state.sequential = true;
        state.mode = 'fresh';
        state.floor = null;
        continue;
      }
      serveWindow(tier, rows);
      continue;
    }

    const rows = await run((read) =>
      methods.readRecordWindow({ ...match, range: upper, limit: rankWindow }, read),
    );
    reads += 1;
    rowsRead += rows.length;
    if (rows.length === 0) {
      nextJob();
      continue;
    }
    const cutDate = rows.length >= rankWindow ? timeOf(rows[rows.length - 1]) : null;
    const held = cutDate === null ? rows : rows.filter((row) => timeOf(row) > cutDate);
    if (cutDate !== null && held.length === 0) {
      startTie(cutDate);
      continue;
    }
    if (state.sequential) {
      serveSequential(tier, held, cutDate);
      continue;
    }
    state.mode = 'window';
    state.floor = cutDate;
    state.seen = new Set();
    serveWindow(tier, held);
  }

  /* A page may fill on the walk's last row: knowing that needs no read. */
  if (!ended && settle() === null) {
    ended = true;
  }
  return { rows: page, cursor: ended ? null : state, reads, rowsRead };
}
