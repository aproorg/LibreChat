import type { SearchMethods, SearchWindowRow } from '@librechat/data-schemas';
import type { Expansion, PrefixBudget, ReadTier, TierJob } from './tiers';
import type { FrozenPlan, PlannedWord } from './frozen';
import type { QueryWord } from '../analyzer/query';
import type { SearchRealtext } from '../metrics';
import type { SearchReadRunner } from './retry';
import type { TypoBudget } from './typo';
import { buildTierJobs, expandPrefix, RARE_DF, READ_TIERS } from './tiers';
import { PLAN_BUDGET_BYTES, planBytes } from './frozen';
import { expandTypos } from './typo';

/** A read the plan ran. Jobs sharing a `batch` ran together. */
export interface PlanJob extends TierJob {
  /** How many trailing words were dropped: 0 requires every word (R-07). */
  stage: number;
  batch: number;
}

/** One search's read. `rowsByJob` lines up with `jobs`. */
export interface PlanRead {
  plan: FrozenPlan;
  jobs: PlanJob[];
  rowsByJob: SearchWindowRow[][];
  reads: number;
  rows: number;
  /** When the read began. Load-more lets nothing newer in. */
  startedAt: number;
}

export type PlanMethods = Pick<
  SearchMethods,
  'readVocabFrequencies' | 'readVocabRange' | 'readRecordWindow'
>;

/** Word list expansions. The service shares them between a search's title and message reads. */
export interface PlanExpansions {
  prefix(exact: string): Promise<Expansion>;
  typos(exact: string): Promise<Expansion>;
}

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
  prefix: PrefixBudget;
  typo: TypoBudget;
  expansions?: PlanExpansions;
  realtext?: Pick<
    SearchRealtext,
    'addPrefixFanout' | 'addVocabRowsTruncated' | 'addTypoSkippedWordExists'
  >;
  now?: () => number;
}

/** Every token a row may hold to count as matching this word. */
export const wordTokens = ({ exact, lemmas, parts, prefix, typos }: PlannedWord): string[] => [
  exact,
  ...lemmas,
  ...parts,
  ...(prefix ?? []),
  ...(typos ?? []),
];

const matchCount = ({ df, partDf }: PlannedWord): number => df + partDf;

/** The words a stage requires: all of them, then all but the last, and so on. */
export const stageWords = (plan: FrozenPlan, stage: number): PlannedWord[] =>
  plan.words.slice(0, plan.words.length - stage);

/** Index of the stage's rarest word, whose tiers the read walks. The first wins a tie. */
export function stageDriver(plan: FrozenPlan, stage: number): number {
  return stageWords(plan, stage).reduce(
    (best, word, index, words) => (matchCount(word) < matchCount(words[best]) ? index : best),
    0,
  );
}

/** The stage's other words, each as the tokens that match it. */
export const stageRest = (plan: FrozenPlan, stage: number): string[][] => {
  const driver = stageDriver(plan, stage);
  return stageWords(plan, stage)
    .filter((_, index) => index !== driver)
    .map(wordTokens);
};

/**
 * A tier's tokens for a stage's driver. `undefined` means the prefix tier applies and
 * has not been expanded yet. Only the last query word expands by prefix.
 */
export function tierTokens(plan: FrozenPlan, stage: number, tier: ReadTier): string[] | undefined {
  const driver = stageDriver(plan, stage);
  const word = plan.words[driver];
  if (tier === 'exact') {
    return [word.exact];
  }
  if (tier === 'lemma') {
    return word.lemmas;
  }
  if (tier === 'part') {
    return word.parts;
  }
  if (tier === 'prefix') {
    return driver === plan.words.length - 1 ? word.prefix : [];
  }
  return word.typos ?? [];
}

/** A tier's jobs from the frozen split, as the read made them. */
export function frozenTierJobs(plan: FrozenPlan, tier: ReadTier, tokens: readonly string[]) {
  const df = new Map(plan.common.map((token, index) => [token, RARE_DF + 1 + index]));
  return buildTierJobs(tier, tokens, df);
}

const commonTokens = (words: readonly PlannedWord[], df: ReadonlyMap<string, number>): string[] =>
  [...new Set(words.flatMap(wordTokens))]
    .map((token) => ({ token, df: df.get(token) ?? 0 }))
    .filter((entry) => entry.df > RARE_DF)
    .sort((a, b) => a.df - b.df)
    .map(({ token }) => token);

/**
 * The longest run of expansions, most frequent first, whose plan still fits the cursor.
 * Applied once, when they are frozen and before any row is served, so a word past the
 * budget is outside it rather than lost between pages (R-06).
 */
export function fitPrefix(
  words: readonly PlannedWord[],
  index: number,
  { tokens, df }: Expansion,
  known: ReadonlyMap<string, number>,
): string[] {
  const merged = new Map([...known, ...df]);
  const fits = (count: number): boolean => {
    const candidate = words.map((word, at) =>
      at === index ? { ...word, prefix: tokens.slice(0, count) } : word,
    );
    return (
      planBytes({ words: candidate, common: commonTokens(candidate, merged) }) <= PLAN_BUDGET_BYTES
    );
  };
  if (fits(tokens.length)) {
    return tokens;
  }
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return tokens.slice(0, low);
}

/** Expansions read straight from the word list, where nothing shares them. */
export const createPlanExpansions = ({
  run,
  methods,
  prefix,
  typo,
  realtext,
}: Pick<ReadPlanOptions, 'run' | 'prefix' | 'typo' | 'realtext'> & {
  methods: Pick<SearchMethods, 'readVocabRange'>;
}): PlanExpansions => ({
  prefix: (exact) => expandPrefix(exact, prefix, { run, methods, realtext }),
  typos: (exact) => expandTypos(exact, typo, { run, methods, realtext }),
});

/** The run's jobs as indexes, in the batches the read ran them. */
export function planBatches(jobs: readonly PlanJob[]): number[][] {
  const batches: number[][] = [];
  jobs.forEach(({ batch }, index) => {
    (batches[batch] ??= []).push(index);
  });
  return batches.filter(Boolean);
}

/**
 * Ported from `final/search.mjs`: document frequencies in one read, then tiers in
 * order, stopping once the page can fill. All words are required first, and trailing
 * words drop while the page cannot fill. Rows stay grouped by job, so each surface can
 * replay the stop rule for its own size from the one read (R-08).
 */
export async function readSearchPlan(options: ReadPlanOptions): Promise<PlanRead> {
  const { user, words, need, window, readConcurrency, run, methods, realtext } = options;
  const { now = Date.now } = options;
  const expansions = options.expansions ?? createPlanExpansions(options);
  const startedAt = now();

  const tokens = [
    ...new Set(words.flatMap(({ exact, lemmas, parts }) => [exact, ...lemmas, ...parts])),
  ];
  const frequencies = await run((read) => methods.readVocabFrequencies(tokens, read));
  const df = new Map(frequencies.map(({ token, df: count }) => [token, count]));
  const sum = (list: readonly string[]) =>
    list.reduce((total, token) => total + (df.get(token) ?? 0), 0);
  const planned: PlannedWord[] = words.map(({ exact, lemmas, parts }) => ({
    exact,
    lemmas,
    parts,
    df: sum([exact, ...lemmas]),
    partDf: sum(parts),
  }));
  const plan: FrozenPlan = { words: planned, common: [] };
  const last = planned.length - 1;
  let reads = 1;
  let rows = frequencies.length;

  const learn = (expansion: Expansion) => {
    reads += 1;
    rows += expansion.vocabRows ?? 0;
    for (const [token, count] of expansion.df) {
      df.set(token, count);
    }
  };
  const prefixFor = async (index: number) => {
    const word = planned[index];
    if (word.prefix) {
      return;
    }
    const expansion = await expansions.prefix(word.exact);
    learn(expansion);
    word.prefix = fitPrefix(planned, index, expansion, df);
    if (word.prefix.length < expansion.tokens.length) {
      realtext?.addVocabRowsTruncated();
    }
  };
  const typosFor = async (index: number) => {
    const word = planned[index];
    if (word.typos) {
      return;
    }
    const expansion = await expansions.typos(word.exact);
    learn(expansion);
    word.typos = expansion.tokens;
  };

  /* A word matching nothing gets its prefix (last word) or corrections before any AND is built. */
  for (let index = 0; index <= last; index += 1) {
    if (matchCount(planned[index]) > 0) {
      continue;
    }
    if (index === last) {
      await prefixFor(index);
      if (planned[index].prefix?.length === 0) {
        await typosFor(index);
      }
    } else {
      await typosFor(index);
    }
  }
  if (last > 0 && matchCount(planned[last]) <= RARE_DF) {
    await prefixFor(last);
  }

  const jobs: PlanJob[] = [];
  const rowsByJob: SearchWindowRow[][] = [];
  const seen = new Set<string>();
  let batch = 0;

  const readTier = async (
    stage: number,
    tier: ReadTier,
    tierTokenList: readonly string[],
    allOf: string[][],
  ) => {
    const tierJobs = buildTierJobs(tier, tierTokenList, df);
    for (let start = 0; start < tierJobs.length && seen.size < need; start += readConcurrency) {
      const slice = tierJobs.slice(start, start + readConcurrency);
      const results = await Promise.all(
        slice.map((job) =>
          run((read) =>
            methods.readRecordWindow(
              { user, tokens: job.tokens, ...(allOf.length ? { allOf } : {}), limit: window },
              read,
            ),
          ),
        ),
      );
      reads += slice.length;
      slice.forEach((job, index) => {
        jobs.push({ ...job, stage, batch });
        rowsByJob.push(results[index]);
        rows += results[index].length;
        for (const row of results[index]) {
          seen.add(row._id);
        }
      });
      batch += 1;
    }
  };

  for (let stage = 0; stage < planned.length; stage += 1) {
    if (stage > 0 && seen.size >= need) {
      break;
    }
    const driver = stageDriver(plan, stage);
    const allOf = stageRest(plan, stage);
    const word = planned[driver];
    await readTier(stage, 'exact', [word.exact], allOf);
    if (seen.size < need) {
      await readTier(stage, 'lemma', word.lemmas, allOf);
    }
    if (seen.size < need) {
      await readTier(stage, 'part', word.parts, allOf);
    }
    if (seen.size < need && driver === last) {
      await prefixFor(driver);
      await readTier(stage, 'prefix', word.prefix ?? [], allOf);
    }
    if (seen.size === 0) {
      await typosFor(driver);
      await readTier(stage, 'typo', word.typos ?? [], allOf);
    }
  }

  /* A misspelling that is itself a word gets no correction: count how often that left nothing. */
  if (seen.size === 0 && planned.some((word) => !word.typos && matchCount(word) > 0)) {
    realtext?.addTypoSkippedWordExists();
  }

  plan.common = commonTokens(planned, df);
  return { plan, jobs, rowsByJob, reads, rows, startedAt };
}

export { READ_TIERS };

export type { FrozenPlan, PlannedWord };
