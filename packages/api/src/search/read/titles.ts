import { MEILI_SEARCH_LIMIT } from '@librechat/data-schemas';
import type { SearchMethods } from '@librechat/data-schemas';
import type { QueryWord } from '../analyzer/query';
import type { SearchReadRunner } from './retry';

export interface TitleMatchOptions {
  user: string;
  words: readonly QueryWord[];
  run: SearchReadRunner;
  methods: Pick<SearchMethods, 'readConversationRecords'>;
  /** Today's hit limit, unless a test lowers it. */
  limit?: number;
}

/**
 * Conversations whose title or tags hold every word, at any tier. There is no page
 * to fill, so all tiers go in one read (FR-009). Title reads stay outside the serving
 * cap, not outside the timeout, which is why callers still hand in a runner (FR-017).
 */
export async function readTitleMatches(options: TitleMatchOptions): Promise<string[]> {
  const { user, words, run, methods, limit = MEILI_SEARCH_LIMIT } = options;
  const allOf = words.map(({ exact, lemmas, parts }) => [exact, ...lemmas, ...parts]);
  const rows = await run((read) => methods.readConversationRecords({ user, allOf, limit }, read));
  return rows.map(({ conversationId }) => conversationId);
}
