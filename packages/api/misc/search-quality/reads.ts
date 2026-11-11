import { derivePage, sharedReadSize, SEARCH_PAGE_SIZE } from '~/search/read/window';
import { createReadGate, createReadRunner } from '~/search/read/retry';
import { analyzeQuery } from '~/search/analyzer/query';
import { createSearchMetrics } from '~/search/metrics';
import { readSearchPlan } from '~/search/read/plan';
import type { SearchMethods } from '@librechat/data-schemas';
import type { Analyzer } from '~/search/analyzer/analyze';

const READ_CONCURRENCY = 2;
const RANK_WINDOW = 200;
const TIMEOUT_MS = 60_000;
/** `contracts/config.md`'s defaults, which are the reference's. */
const PREFIX_BUDGET = { maxCommonReads: 4, maxRareTokens: 200, maxVocabRows: 50_000 };
const TYPO_BUDGET = { maxCorrections: 8, maxVocabRows: 50_000 };
const quiet = { info: () => undefined, warn: () => undefined };

export type QualityReadMethods = Pick<
  SearchMethods,
  | 'readVocabFrequencies'
  | 'readVocabRange'
  | 'readRecordWindow'
  | 'readRecordTokens'
  | 'readMessageTexts'
>;

/**
 * R-13's measures through the production path. "First page" is `/search`'s page; "top
 * 200" and "top 1,000" are the ranked shared read at that `sidebarLimit`. Every read
 * is sized as the service sizes it, and a multi-word query ranks with its tokens and
 * proximity at both sizes, as the reference does at any limit.
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
  const run = createReadRunner({
    surface: 'messages',
    signal: new AbortController().signal,
    deadline: Date.now() + TIMEOUT_MS,
    gate: createReadGate(READ_CONCURRENCY),
    metrics: createSearchMetrics(quiet),
    logger: quiet,
  });
  const read = await readSearchPlan({
    user,
    words: analyzed.words,
    ...sharedReadSize({ rankWindow: RANK_WINDOW, sidebarLimit }),
    readConcurrency: READ_CONCURRENCY,
    methods,
    run,
    prefix: PREFIX_BUDGET,
    typo: TYPO_BUDGET,
  });
  const ranked = async (limit: number) =>
    (
      await derivePage(
        read,
        { limit, rankWindow: RANK_WINDOW, lengthBucket: true },
        { user, run, methods, analyzer },
      )
    ).hits.map(({ messageId }) => messageId);
  return { firstPage: await ranked(SEARCH_PAGE_SIZE), top: await ranked(sidebarLimit) };
}
