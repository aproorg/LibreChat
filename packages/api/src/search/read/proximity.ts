import { SearchError } from '@librechat/data-schemas';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
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
 * How much of one message is scanned for a span. The scan is synchronous work on the process
 * that serves chat, and a pasted log or a long reasoning trace can run to megabytes. Indexing
 * stops at its token cap for the same reason, so a match almost always lies inside this.
 */
export const MAX_SPAN_CHARS = 50_000;

/**
 * The smallest run of words in a text that holds every query word, in words. Each
 * word of the text is analyzed as indexing analyzes it, so an inflected form counts.
 * Ported from the design's reference implementation (`final/search.mjs`, outside this repository).
 */
export function wordSpan(
  text: string,
  words: readonly PlannedWord[],
  analyzer: Pick<Analyzer, 'analyzeWord'>,
): number {
  const sets = words.map((word) => new Set(wordTokens(word)));
  const last = new Array<number>(sets.length).fill(-1);
  let best = NO_SPAN;
  const scanned = text.length > MAX_SPAN_CHARS ? text.slice(0, MAX_SPAN_CHARS) : text;
  splitWords(scanned).forEach((word, position) => {
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
  signal,
  deadline,
}: {
  user: string;
  rows: readonly TieredRow[];
  words: readonly PlannedWord[];
  analyzer: Pick<Analyzer, 'analyzeWord'>;
  run: SearchReadRunner;
  methods: Pick<SearchMethods, 'readMessageTexts'>;
  /** The search's own signal and deadline, which the scan between reads must honour too. */
  signal?: AbortSignal;
  deadline?: number;
}): Promise<Map<string, number>> {
  const texts = await run((read) =>
    methods.readMessageTexts({ user, messageIds: rows.map(({ messageId }) => messageId) }, read),
  );
  const textById = new Map(texts.map((source) => [source.messageId, messageText(source)]));
  const proximity = new Map<string, number>();
  for (const row of rows) {
    if (signal?.aborted || (deadline != null && Date.now() >= deadline)) {
      throw new SearchError('search_busy');
    }
    proximity.set(row._id, -wordSpan(textById.get(row.messageId) ?? '', words, analyzer));
    /* One message at a time, so the scan never holds the event loop for the whole set. */
    await yieldToEventLoop();
  }
  return proximity;
}
