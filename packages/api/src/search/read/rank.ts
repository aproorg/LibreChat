import type { SearchWindowRow } from '@librechat/data-schemas';
import type { ReadTier } from './tiers';
import { READ_TIERS } from './tiers';

/** Tied to the quality evidence, so a change is a written decision rather than a tuning lever (R-16). */
export const TIER_WEIGHT: Readonly<Record<ReadTier, number>> = {
  exact: 1,
  lemma: 0.9,
  part: 0.6,
  prefix: 0.5,
  typo: 0.4,
};

/** The reference's fixed collection size for rarity: a real count would change rankings per tenant. */
const RARITY_TOTAL_DOCS = 1_000_000;

/** The bucket's cap and width come from the reference, where they earned 9 first-page passes (§5). */
const MAX_LENGTH_BUCKET = 4;
const LENGTH_BUCKET_WIDTH = 2;

/** Multi-word candidates whose text is read for proximity (FR-011). */
export const PROXIMITY_TOP = 50;

/** A query word as ranking sees it. Only `df` is needed for one word. */
export interface RankedWord {
  /** Word list count over the word's exact form and lemmas. */
  df: number;
  partDf?: number;
  exact?: string;
  lemmas?: readonly string[];
  parts?: readonly string[];
  prefix?: readonly string[];
  typos?: readonly string[];
}

export interface TieredRow extends SearchWindowRow {
  /** The driving word's tier in the read that found the row. */
  tier: ReadTier;
  /** Trailing words dropped in that read. */
  stage?: number;
}

/** Per query word, the best tier a row holds it at, or `null`. */
export type WordTiers = Array<ReadTier | null>;

export interface RankOptions {
  /** `rank.lengthBucket`: a lever changed only by written decision (FR-011). */
  lengthBucket: boolean;
  /** Multi-word only: each row's tiers per word, from its tokens. */
  masks?: ReadonlyMap<string, WordTiers>;
  /** Multi-word only: smallest span covering every word, negated, for the top candidates. */
  proximity?: ReadonlyMap<string, number>;
}

/** Plays the role of length normalization: short messages surface, and recency decides within a bucket. */
export const lengthBucket = (tokens: number): number =>
  Math.min(Math.floor(Math.log2(1 + tokens) / LENGTH_BUCKET_WIDTH), MAX_LENGTH_BUCKET);

const rarity = (df: number): number => Math.log(1 + RARITY_TOTAL_DOCS / (1 + Math.max(df, 1)));

/** The best tier each word reaches among a record's tokens. */
export function wordTiers(words: readonly RankedWord[], tokens: readonly string[]): WordTiers {
  const held = new Set(tokens);
  const any = (list: readonly string[] | undefined) => list?.some((token) => held.has(token));
  return words.map(({ exact, lemmas, parts, prefix, typos }) => {
    if (exact !== undefined && held.has(exact)) {
      return 'exact';
    }
    const lists = [lemmas, parts, prefix, typos];
    const found = lists.findIndex(any);
    return found < 0 ? null : READ_TIERS[found + 1];
  });
}

interface Scored<T> {
  row: T;
  matched: number;
  score: number;
  proximity: number;
  bucket: number;
  time: number;
}

/** The stage's rarest word, which drove the read. */
const driverOf = (words: readonly RankedWord[], stage: number): number =>
  words
    .slice(0, words.length - stage)
    .reduce(
      (best, word, index, active) =>
        word.df + (word.partDf ?? 0) < active[best].df + (active[best].partDf ?? 0) ? index : best,
      0,
    );

function scoreRows<T extends TieredRow>(
  rows: readonly T[],
  words: readonly RankedWord[],
  { lengthBucket: useBucket, masks }: RankOptions,
): Scored<T>[] {
  const weights = words.map(({ df }) => rarity(df));
  return rows.map((row) => {
    const mask = masks?.get(row._id);
    const stage = row.stage ?? 0;
    /* Without tokens, a row is known to hold its stage's words, at the driver's tier. */
    const matched = mask
      ? mask.filter((tier) => tier !== null).length
      : Math.max(words.length - stage, 1);
    const score = mask
      ? mask.reduce((sum, tier, index) => sum + (tier ? TIER_WEIGHT[tier] * weights[index] : 0), 0)
      : TIER_WEIGHT[row.tier] * (weights[driverOf(words, stage)] ?? rarity(0));
    return {
      row,
      matched,
      score,
      proximity: 0,
      bucket: useBucket ? lengthBucket(row.n ?? 0) : 0,
      time: row.createdAt.getTime(),
    };
  });
}

const byNewest = <T>(a: Scored<T>, b: Scored<T>) =>
  b.matched - a.matched || b.score - a.score || b.time - a.time;

const byRank = <T>(a: Scored<T>, b: Scored<T>) =>
  b.matched - a.matched ||
  b.score - a.score ||
  b.proximity - a.proximity ||
  a.bucket - b.bucket ||
  b.time - a.time;

/**
 * The rows whose text a multi-word search reads for proximity: the best by words
 * matched, tier and recency. Selection ignores the length bucket, as the reference does.
 */
export function proximityCandidates<T extends TieredRow>(
  rows: readonly T[],
  words: readonly RankedWord[],
  options: RankOptions,
): T[] {
  return scoreRows(rows, words, options)
    .sort(byNewest)
    .slice(0, PROXIMITY_TOP)
    .map(({ row }) => row);
}

/**
 * FR-011's order: words matched, tier weighted by rarity, proximity among the top
 * candidates of a multi-word query, length bucket, newest. Ties keep read order.
 */
export function rankHits<T extends TieredRow>(
  rows: readonly T[],
  words: readonly RankedWord[],
  options: RankOptions,
): T[] {
  const scored = scoreRows(rows, words, options);
  if (words.length < 2) {
    return scored.sort(byRank).map(({ row }) => row);
  }
  scored.sort(byNewest);
  const top = scored.slice(0, PROXIMITY_TOP);
  for (const entry of top) {
    entry.proximity = options.proximity?.get(entry.row._id) ?? 0;
  }
  return [...top.sort(byRank), ...scored.slice(PROXIMITY_TOP).sort(byRank)].map(({ row }) => row);
}
