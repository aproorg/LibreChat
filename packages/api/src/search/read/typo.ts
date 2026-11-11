import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { Expansion, ExpansionDeps } from './tiers';
import { endOfPrefix } from './tiers';

/** Word list rows compared before the scan gives way: it runs on the process that serves chat. */
const SCAN_SLICE_ROWS = 5_000;

/**
 * Words of one search that may be corrected, in titles and in messages alike. Each correction
 * reads up to `typo.maxVocabRows` word list rows, and a query of many unknown words is noise,
 * not a misspelling, so the words past this are matched as typed.
 */
export const MAX_TYPO_WORDS = 3;

export interface TypoBudget {
  maxCorrections: number;
  /** Word list rows one correction may read. */
  maxVocabRows: number;
}

/**
 * Edits allowed by length, the same budget as Meilisearch: none under 5 letters, one
 * under 9, then two. Tied to the quality evidence (R-16).
 */
export function typoEdits(length: number): number {
  if (length < 5) {
    return 0;
  }
  return length < 9 ? 1 : 2;
}

/**
 * Damerau-Levenshtein distance, stopping at `max + 1` once no cell of a row can come
 * in under it. Ported from the design's reference implementation (`final/search.mjs`, outside
 * this repository).
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) {
    return max + 1;
  }
  let beforePrevious = new Array<number>(b.length + 1).fill(0);
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let cell = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cell = Math.min(cell, beforePrevious[j - 2] + 1);
      }
      current[j] = cell;
      rowMin = Math.min(rowMin, cell);
    }
    if (rowMin > max) {
      return max + 1;
    }
    [beforePrevious, previous, current] = [previous, current, beforePrevious];
  }
  return previous[b.length];
}

/**
 * Corrections for a word that matched nothing: words in the tenant's word list within
 * the edit budget, first letter fixed, nearest then most frequent first.
 */
export async function expandTypos(
  exact: string,
  budget: TypoBudget,
  {
    run,
    methods,
    realtext,
  }: Omit<ExpansionDeps, 'realtext'> & {
    realtext?: Pick<NonNullable<ExpansionDeps['realtext']>, 'addVocabRowsTruncated'>;
  },
): Promise<Expansion> {
  const edits = typoEdits(exact.length);
  if (edits === 0) {
    return { tokens: [], df: new Map() };
  }
  const first = exact.slice(0, 1);
  const rows = await run((read) =>
    methods.readVocabRange(
      { start: first, end: endOfPrefix(first), limit: budget.maxVocabRows },
      read,
    ),
  );
  if (rows.length >= budget.maxVocabRows) {
    realtext?.addVocabRowsTruncated();
  }
  const within: Array<{ token: string; df: number; distance: number }> = [];
  for (let start = 0; start < rows.length; start += SCAN_SLICE_ROWS) {
    for (const { token, df } of rows.slice(start, start + SCAN_SLICE_ROWS)) {
      const distance = editDistance(exact, token, edits);
      if (distance <= edits) {
        within.push({ token, df, distance });
      }
    }
    if (start + SCAN_SLICE_ROWS < rows.length) {
      await yieldToEventLoop();
    }
  }
  const near = within
    .sort((a, b) => a.distance - b.distance || b.df - a.df)
    .slice(0, budget.maxCorrections);
  return {
    tokens: near.map(({ token }) => token),
    df: new Map(near.map(({ token, df }) => [token, df])),
    vocabRows: rows.length,
  };
}
