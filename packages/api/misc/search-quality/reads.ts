import { deriveRanked, sharedReadSize, SEARCH_PAGE_SIZE } from '~/search/read/window';
import { createReadGate, createReadRunner } from '~/search/read/retry';
import { analyzeQuery } from '~/search/analyzer/query';
import { createSearchMetrics } from '~/search/metrics';
import { readSearchPlan } from '~/search/read/plan';
import type { SearchMethods } from '@librechat/data-schemas';
import type { Analyzer } from '~/search/analyzer/analyze';

const READ_CONCURRENCY = 2;
const RANK_WINDOW = 200;
const TIMEOUT_MS = 60_000;
const quiet = { info: () => undefined, warn: () => undefined };

export type QualityReadMethods = Pick<SearchMethods, 'readVocabFrequencies' | 'readRecordWindow'>;

/**
 * R-13's measures through the production path. "First page" is `/search`'s page; "top
 * 200" and "top 1,000" are the ranked shared read at that `sidebarLimit`, the function
 * the sidebar uses. Every read is sized as the service sizes it.
 */
export async function rankedMessageIds(
  methods: QualityReadMethods,
  analyzer: Analyzer,
  user: string,
  query: string,
  sidebarLimit: number,
): Promise<{ firstPage: string[]; top: string[] }> {
  const analyzed = analyzeQuery(analyzer, query, { queryWordLimit: 10 });
  if (analyzed.status !== 'ok') {
    return { firstPage: [], top: [] };
  }
  const read = await readSearchPlan({
    user,
    words: analyzed.words,
    ...sharedReadSize({ rankWindow: RANK_WINDOW, sidebarLimit }),
    readConcurrency: READ_CONCURRENCY,
    methods,
    run: createReadRunner({
      surface: 'messages',
      signal: new AbortController().signal,
      deadline: Date.now() + TIMEOUT_MS,
      gate: createReadGate(READ_CONCURRENCY),
      metrics: createSearchMetrics(quiet),
      logger: quiet,
    }),
  });
  const ranked = (limit: number) =>
    deriveRanked(read, {
      limit,
      rankWindow: RANK_WINDOW,
      readConcurrency: READ_CONCURRENCY,
      lengthBucket: true,
    }).hits.map(({ messageId }) => messageId);
  return { firstPage: ranked(SEARCH_PAGE_SIZE), top: ranked(sidebarLimit) };
}
