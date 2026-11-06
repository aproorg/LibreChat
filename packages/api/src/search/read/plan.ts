import type { SearchMethods, SearchWindowRow } from '@librechat/data-schemas';
import type { QueryWord } from '../analyzer/query';
import type { SearchReadRunner } from './retry';
import type { TierJob } from './tiers';
import { buildTierJobs, READ_TIERS } from './tiers';

export interface PlannedWord {
  exact: string;
  lemmas: string[];
  parts: string[];
  /** Word list count over the exact form and lemmas. */
  df: number;
  partDf: number;
}

/**
 * What the read decided from one word list snapshot. Load-more needs the same
 * decisions on every page, so this stays plain data the cursor can carry (R-06).
 */
export interface FrozenPlan {
  words: PlannedWord[];
  /** Index of the rarest word, whose tiers the read walks. */
  driver: number;
  jobs: TierJob[];
}

/** One search's read. `rowsByJob` lines up with the start of `plan.jobs`: a stopped read has fewer. */
export interface PlanRead {
  plan: FrozenPlan;
  rowsByJob: SearchWindowRow[][];
  reads: number;
  rows: number;
}

export type PlanMethods = Pick<SearchMethods, 'readVocabFrequencies' | 'readRecordWindow'>;

export interface ReadPlanOptions {
  user: string;
  words: readonly QueryWord[];
  /** Rows wanted across tiers. The read stops once it holds this many. */
  need: number;
  /** Rows read per job. */
  window: number;
  readConcurrency: number;
  run: SearchReadRunner;
  methods: PlanMethods;
}

const wordTokens = ({ exact, lemmas, parts }: Pick<PlannedWord, 'exact' | 'lemmas' | 'parts'>) => [
  exact,
  ...lemmas,
  ...parts,
];

const sum = (tokens: readonly string[], df: ReadonlyMap<string, number>) =>
  tokens.reduce((total, token) => total + (df.get(token) ?? 0), 0);

function buildPlan(words: readonly QueryWord[], df: ReadonlyMap<string, number>): FrozenPlan {
  const planned = words.map(({ exact, lemmas, parts }) => ({
    exact,
    lemmas,
    parts,
    df: sum([exact, ...lemmas], df),
    partDf: sum(parts, df),
  }));
  const driver = planned.reduce(
    (best, word, index) =>
      word.df + word.partDf < planned[best].df + planned[best].partDf ? index : best,
    0,
  );
  const { exact, lemmas, parts } = planned[driver];
  const tokensByTier = { exact: [exact], lemma: lemmas, part: parts };
  return {
    words: planned,
    driver,
    jobs: READ_TIERS.flatMap((tier) => buildTierJobs(tier, tokensByTier[tier], df)),
  };
}

/** A plan's jobs as indexes, in the batches the read runs them: tier by tier, `readConcurrency` at a time. */
export function planBatches(plan: FrozenPlan, readConcurrency: number): number[][] {
  const batches: number[][] = [];
  for (const tier of READ_TIERS) {
    const indexes = plan.jobs.flatMap((job, index) => (job.tier === tier ? [index] : []));
    for (let start = 0; start < indexes.length; start += readConcurrency) {
      batches.push(indexes.slice(start, start + readConcurrency));
    }
  }
  return batches;
}

/**
 * Ported from `final/search.mjs`: document frequencies in one read, then tiers in
 * order, stopping once the page can fill. Rows stay grouped by job, so each surface
 * can replay the stop rule for its own size from the one read (R-08).
 */
export async function readSearchPlan(options: ReadPlanOptions): Promise<PlanRead> {
  const { user, words, need, window, readConcurrency, run, methods } = options;
  const tokens = [...new Set(words.flatMap(wordTokens))];
  const frequencies = await run((read) => methods.readVocabFrequencies(tokens, read));
  const df = new Map(frequencies.map(({ token, df: count }) => [token, count]));
  const plan = buildPlan(words, df);
  const allOf = plan.words.filter((_, index) => index !== plan.driver).map(wordTokens);

  const rowsByJob: SearchWindowRow[][] = [];
  const seen = new Set<string>();
  let reads = 1;
  let rows = frequencies.length;

  for (const batch of planBatches(plan, readConcurrency)) {
    if (seen.size >= need) {
      break;
    }
    const results = await Promise.all(
      batch.map((index) =>
        run((read) =>
          methods.readRecordWindow(
            {
              user,
              tokens: plan.jobs[index].tokens,
              ...(allOf.length ? { allOf } : {}),
              limit: window,
            },
            read,
          ),
        ),
      ),
    );
    reads += batch.length;
    for (const result of results) {
      rowsByJob.push(result);
      rows += result.length;
      for (const row of result) {
        seen.add(row._id);
      }
    }
  }

  return { plan, rowsByJob, reads, rows };
}
