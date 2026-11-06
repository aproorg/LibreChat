/** Tokens this rare share one bounded `$in` read. Tied to the quality evidence (R-16). */
export const RARE_DF = 300;

/** Later tiers (prefix, typo) arrive with the harder queries. */
export const READ_TIERS = ['exact', 'lemma', 'part'] as const;
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
