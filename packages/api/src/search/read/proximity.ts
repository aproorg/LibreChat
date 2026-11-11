import type { SearchMethods } from '@librechat/data-schemas';
import type { Analyzer } from '../analyzer/analyze';
import type { SearchReadRunner } from './retry';
import type { PlannedWord } from './plan';
import type { TieredRow } from './rank';
import { words as splitWords } from '../analyzer/words';
import { messageText } from '../sync/extract';
import { fold } from '../analyzer/fold';
import { wordTokens } from './plan';

/** What a row scores when its text is gone or lacks a word: it sorts last among the candidates. */
export const NO_SPAN = 1_000_000;

/**
 * The smallest run of words in a text that holds every query word, in words. Each
 * word of the text is analyzed as indexing analyzes it, so an inflected form counts.
 * Ported from `final/search.mjs`.
 */
export function wordSpan(
  text: string,
  words: readonly PlannedWord[],
  analyzer: Pick<Analyzer, 'analyzeWord'>,
): number {
  const sets = words.map((word) => new Set(wordTokens(word)));
  const last = new Array<number>(sets.length).fill(-1);
  let best = NO_SPAN;
  splitWords(text).forEach((word, position) => {
    const tokens = analyzer.analyzeWord(word);
    const folded = fold(word);
    sets.forEach((set, index) => {
      if (set.has(folded) || tokens.some((token) => set.has(token))) {
        last[index] = position;
      }
    });
    if (last.every((at) => at >= 0)) {
      best = Math.min(best, position - Math.min(...last));
    }
  });
  return best;
}

/**
 * Proximity for a multi-word query's top candidates, as one read of their canonical
 * text. Higher is closer. The text is used here and never kept or logged.
 */
export async function readProximity({
  user,
  rows,
  words,
  analyzer,
  run,
  methods,
}: {
  user: string;
  rows: readonly TieredRow[];
  words: readonly PlannedWord[];
  analyzer: Pick<Analyzer, 'analyzeWord'>;
  run: SearchReadRunner;
  methods: Pick<SearchMethods, 'readMessageTexts'>;
}): Promise<Map<string, number>> {
  const texts = await run((read) =>
    methods.readMessageTexts({ user, messageIds: rows.map(({ messageId }) => messageId) }, read),
  );
  const textById = new Map(texts.map((source) => [source.messageId, messageText(source)]));
  return new Map(
    rows.map((row) => [row._id, -wordSpan(textById.get(row.messageId) ?? '', words, analyzer)]),
  );
}
