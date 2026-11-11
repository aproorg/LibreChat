import type { SearchMethods } from '@librechat/data-schemas';
import type { SearchRealtext } from '../metrics';
import type { SearchReadRunner } from './retry';

/** Tokens this rare share one bounded `$in` read. Tied to the quality evidence (R-16). */
export const RARE_DF = 300;

/** In the order a search tries them (FR-009). */
export const READ_TIERS = ['exact', 'lemma', 'part', 'prefix', 'typo'] as const;
export type ReadTier = (typeof READ_TIERS)[number];

/** One read. A common token gets its own, so every read stays in index order. */
export interface TierJob {
  tier: ReadTier;
  tokens: string[];
}

/**
 * A tier's reads. A token missing from the word list counts as rare and is still
 * read, so a new word is findable before the next word list flush.
 */
export function buildTierJobs(
  tier: ReadTier,
  tokens: readonly string[],
  df: ReadonlyMap<string, number>,
): TierJob[] {
  const known = tokens.map((token) => ({ token, df: df.get(token) ?? 0 }));
  const rare = known.filter((entry) => entry.df <= RARE_DF).map(({ token }) => token);
  const common = known.filter((entry) => entry.df > RARE_DF).sort((a, b) => a.df - b.df);
  return [
    ...(rare.length ? [{ tier, tokens: rare }] : []),
    ...common.map(({ token }) => ({ tier, tokens: [token] })),
  ];
}

export interface PrefixBudget {
  /** Common expansions, each its own read. */
  maxCommonReads: number;
  /** Rare expansions, sharing one read. */
  maxRareTokens: number;
  /** Word list rows one expansion may read. */
  maxVocabRows: number;
}

export interface Expansion {
  /** Most frequent first. */
  tokens: string[];
  df: Map<string, number>;
  /** Word list rows the expansion read, for `search.request`. */
  vocabRows?: number;
}

export interface ExpansionDeps {
  run: SearchReadRunner;
  methods: Pick<SearchMethods, 'readVocabRange'>;
  realtext?: Pick<SearchRealtext, 'addPrefixFanout' | 'addVocabRowsTruncated'>;
}

/** The smallest string above every string starting with `prefix`. */
export const endOfPrefix = (prefix: string): string => {
  const last = [...prefix].pop() ?? '';
  return (
    prefix.slice(0, prefix.length - last.length) +
    String.fromCodePoint((last.codePointAt(0) ?? 0) + 1)
  );
};

/**
 * Words starting with the last query word, ported from the design's reference
 * implementation (`final/search.mjs`, kept outside this repository). The range
 * read is bounded, so "most frequent first" holds within the first rows by spelling;
 * a tail past the budget is not expanded, and is counted (R-10).
 */
export async function expandPrefix(
  exact: string,
  budget: PrefixBudget,
  { run, methods, realtext }: ExpansionDeps,
): Promise<Expansion> {
  const rows = await run((read) =>
    methods.readVocabRange(
      { start: exact, end: endOfPrefix(exact), limit: budget.maxVocabRows },
      read,
    ),
  );
  if (rows.length >= budget.maxVocabRows) {
    realtext?.addVocabRowsTruncated();
  }
  const others = rows.filter(({ token }) => token !== exact).sort((a, b) => b.df - a.df);
  const common = others.filter(({ df }) => df > RARE_DF).slice(0, budget.maxCommonReads);
  const rare = others.filter(({ df }) => df <= RARE_DF).slice(0, budget.maxRareTokens);
  const kept = [...common, ...rare];
  realtext?.addPrefixFanout(kept.length);
  return {
    tokens: kept.map(({ token }) => token),
    df: new Map(kept.map(({ token, df }) => [token, df])),
    vocabRows: rows.length,
  };
}
