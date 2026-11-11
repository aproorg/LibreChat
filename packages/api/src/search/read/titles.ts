import { MEILI_SEARCH_LIMIT } from '@librechat/data-schemas';
import type { SearchMethods } from '@librechat/data-schemas';
import type { QueryWord } from '../analyzer/query';
import type { SearchReadRunner } from './retry';
import type { PlanExpansions } from './plan';

export interface TitleMatchOptions {
  user: string;
  words: readonly QueryWord[];
  run: SearchReadRunner;
  methods: Pick<SearchMethods, 'readConversationRecords' | 'readVocabFrequencies'>;
  /** Shared with the message read, so one search expands a word once (R-08). */
  expansions: PlanExpansions;
  /** Today's hit limit, unless a test lowers it. */
  limit?: number;
}

/**
 * Conversations whose title or tags hold every word, at any tier. There is no page
 * to fill, so all tiers go in one read: the last word also matches by prefix, and a
 * word the word list lacks matches by its corrections (FR-009). Title reads stay
 * outside the serving cap, not outside the timeout, which is why callers still hand in
 * a runner (FR-017).
 */
export async function readTitleMatches(options: TitleMatchOptions): Promise<string[]> {
  const { user, words, run, methods, expansions, limit = MEILI_SEARCH_LIMIT } = options;
  const sets = words.map(({ exact, lemmas, parts }) => [exact, ...lemmas, ...parts]);
  const frequencies = await run((read) =>
    methods.readVocabFrequencies([...new Set(sets.flat())], read),
  );
  const known = new Set(frequencies.filter(({ df }) => df > 0).map(({ token }) => token));
  const last = words.length - 1;
  const allOf = await Promise.all(
    sets.map(async (tokens, index) => {
      const prefix = index === last ? (await expansions.prefix(words[index].exact)).tokens : [];
      const unmatched = prefix.length === 0 && !tokens.some((token) => known.has(token));
      const typos = unmatched ? (await expansions.typos(words[index].exact)).tokens : [];
      return [...tokens, ...prefix, ...typos];
    }),
  );
  const rows = await run((read) => methods.readConversationRecords({ user, allOf, limit }, read));
  return rows.map(({ conversationId }) => conversationId);
}
