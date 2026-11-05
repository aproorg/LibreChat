import type { SearchWindowRow } from '@librechat/data-schemas';
import type { ReadTier } from './tiers';

/** Tied to the quality evidence, so a change is a written decision rather than a tuning lever (R-16). */
export const TIER_WEIGHT: Readonly<Record<ReadTier, number>> = {
  exact: 1,
  lemma: 0.9,
  part: 0.6,
};

/** The reference's fixed collection size for rarity: a real count would change rankings per tenant. */
const RARITY_TOTAL_DOCS = 1_000_000;

/** The bucket's cap and width come from the reference, where they earned 9 first-page passes (§5). */
const MAX_LENGTH_BUCKET = 4;
const LENGTH_BUCKET_WIDTH = 2;

export interface RankedWord {
  /** Word list count over the word's exact form and lemmas. */
  df: number;
}

export interface TieredRow extends SearchWindowRow {
  tier: ReadTier;
  /** Query words this row holds. One until word masks exist. */
  matched?: number;
}

export interface RankOptions {
  /** `rank.lengthBucket`. FR-011 needs it off for the panel's re-run. */
  lengthBucket: boolean;
}

/** Plays the role of length normalization: short messages surface, and recency decides within a bucket. */
export const lengthBucket = (tokens: number): number =>
  Math.min(Math.floor(Math.log2(1 + tokens) / LENGTH_BUCKET_WIDTH), MAX_LENGTH_BUCKET);

const rarity = (df: number): number => Math.log(1 + RARITY_TOTAL_DOCS / (1 + Math.max(df, 1)));

/**
 * FR-011's order: words matched, tier weighted by rarity, length bucket, newest.
 * Proximity joins for multi-word queries (T084). Ties keep read order.
 */
export function rankHits<T extends TieredRow>(
  rows: readonly T[],
  words: readonly RankedWord[],
  options: RankOptions,
): T[] {
  const weight = rarity(words[0]?.df ?? 0);
  const keyed = rows.map((row) => ({
    row,
    matched: row.matched ?? 1,
    score: TIER_WEIGHT[row.tier] * weight,
    bucket: options.lengthBucket ? lengthBucket(row.n ?? 0) : 0,
    time: row.createdAt.getTime(),
  }));
  keyed.sort(
    (a, b) => b.matched - a.matched || b.score - a.score || a.bucket - b.bucket || b.time - a.time,
  );
  return keyed.map(({ row }) => row);
}
