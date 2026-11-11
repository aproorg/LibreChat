import { deflateRawSync } from 'node:zlib';

export interface PlannedWord {
  exact: string;
  lemmas: string[];
  parts: string[];
  /** Words starting with this one, once the read or the walk has reached that tier. */
  prefix?: string[];
  /** Corrections, for a word that matched nothing. */
  typos?: string[];
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
  /** Tokens too common to share a read, rarest first. Each is its own job. */
  common: string[];
}

/** Deflated bytes a frozen plan may take, so the worst-case URL fits a proxy's request line. */
export const PLAN_BUDGET_BYTES = 1500;

export type EncodedWord = [string, string[], number, number, string[] | 0, string[] | 0];

export interface EncodedPlan {
  w: EncodedWord[];
  c: string[];
}

/** Compound parts are the surface and lemmas marked, so they are rebuilt, not carried. */
export const encodePlan = ({ words, common }: FrozenPlan): EncodedPlan => ({
  w: words.map(({ exact, lemmas, df, partDf, prefix, typos }) => [
    exact,
    lemmas,
    df,
    partDf,
    prefix ?? 0,
    typos ?? 0,
  ]),
  c: common,
});

/** What a plan costs in the cursor, for the prefix budget. */
export const planBytes = (plan: FrozenPlan): number =>
  deflateRawSync(JSON.stringify(encodePlan(plan))).length;
