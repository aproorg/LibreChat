import type { SearchRealtext } from '../metrics';
import type { Analyzer } from './analyze';
import { addLemmaTokens, PART_MARKER } from './analyze';
import { words } from './words';
import { fold } from './fold';

/** One query word's tokens. The word itself is never split. */
export interface QueryWord {
  /** NFC and lowercase. */
  raw: string;
  /** Folded surface. */
  exact: string;
  /** Lemmas or stems, without the surface. */
  lemmas: string[];
  /** The surface and lemmas marked as compound parts, so a word reaches compounds holding it. */
  parts: string[];
  stop: boolean;
}

export interface AnalyzedQuery {
  /** `no_words`: nothing in the query is a word. `only_stop_words`: every word is a stop word. */
  status: 'ok' | 'no_words' | 'only_stop_words';
  /** Words the read plan uses, in query order. The last one is the prefix word. */
  words: QueryWord[];
  /** Stop words removed. Query text: never log it. */
  dropped: string[];
}

export interface AnalyzeQueryOptions {
  /** Most query words used, counted after stop-word removal. */
  queryWordLimit: number;
  realtext?: Pick<SearchRealtext, 'addNoLetterQuery' | 'addStopOnlyQuery'>;
}

export function queryWord(analyzer: Analyzer, input: string): QueryWord {
  const { packs, stopWords } = analyzer;
  const raw = input.normalize('NFC').toLowerCase();
  const exact = fold(raw);
  const tokens = new Set<string>();
  addLemmaTokens(packs, raw, exact, tokens);
  if (!packs.some((pack) => pack.claims?.(raw) === true)) {
    for (const pack of packs) {
      for (const lemma of pack.queryLemmas?.(exact) ?? []) {
        tokens.add(lemma);
      }
    }
  }
  tokens.delete(exact);
  const lemmas = [...tokens];
  return {
    raw,
    exact,
    lemmas,
    parts: [exact, ...lemmas].map((token) => PART_MARKER + token),
    stop: stopWords.has(raw),
  };
}

export function analyzeQuery(
  analyzer: Analyzer,
  query: string,
  { queryWordLimit, realtext }: AnalyzeQueryOptions,
): AnalyzedQuery {
  const all = words(query).map((word) => queryWord(analyzer, word));
  if (all.length === 0) {
    return { status: 'no_words', words: [], dropped: [] };
  }
  const dropped = all.filter(({ stop }) => stop).map(({ raw }) => raw);
  const usable = all.filter(({ stop }) => !stop);
  if (usable.length === 0) {
    realtext?.addStopOnlyQuery();
    return { status: 'only_stop_words', words: [], dropped };
  }
  const anyPackClaims = analyzer.packs.some((pack) => pack.claims != null);
  if (
    anyPackClaims &&
    !usable.some(({ raw }) => analyzer.packs.some((pack) => pack.claims?.(raw) === true))
  ) {
    realtext?.addNoLetterQuery();
  }
  return { status: 'ok', words: usable.slice(0, queryWordLimit), dropped };
}
