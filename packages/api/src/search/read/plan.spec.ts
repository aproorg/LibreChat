import type { SearchHarness } from '../__tests__/helpers/harness';
import { createSearchHarness, sourceMessage } from '../__tests__/helpers/harness';
import { createReadGate, createReadRunner } from './retry';
import { deriveRanked, SEARCH_PAGE_SIZE } from './window';
import { analyzeQuery } from '../analyzer/query';
import { buildTierJobs, RARE_DF } from './tiers';
import { readSearchPlan } from './plan';

describe('read plan', () => {
  let harness: SearchHarness;
  let reads: { windows: Array<{ tokens: readonly string[]; limit: number }>; df: number };

  const plan = async (
    query: string,
    { need = SEARCH_PAGE_SIZE, window = 200, readConcurrency = 2, user = 'user-a' } = {},
  ) => {
    const analyzed = analyzeQuery(harness.analyzer, query, { queryWordLimit: 10 });
    const run = createReadRunner({
      surface: 'messages',
      signal: new AbortController().signal,
      deadline: Date.now() + 10_000,
      gate: createReadGate(readConcurrency),
      metrics: harness.metrics,
      logger: harness.logger,
    });
    return readSearchPlan({
      user,
      words: analyzed.words,
      need,
      window,
      readConcurrency,
      run,
      methods: {
        readVocabFrequencies: (tokens, options) => {
          reads.df += 1;
          return harness.methods.readVocabFrequencies(tokens, options);
        },
        readRecordWindow: (params, options) => {
          reads.windows.push({ tokens: params.tokens, limit: params.limit });
          return harness.methods.readRecordWindow(params, options);
        },
      },
    });
  };

  const page = (read: Awaited<ReturnType<typeof plan>>, limit = SEARCH_PAGE_SIZE) =>
    deriveRanked(read, { limit, rankWindow: 200, readConcurrency: 2, lengthBucket: true });

  beforeAll(async () => {
    harness = await createSearchHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    reads = { windows: [], df: 0 };
  });

  describe('buildTierJobs', () => {
    it('shares one job among rare tokens, and gives each common token its own, rarest first', () => {
      const df = new Map([
        ['rare1', 3],
        ['rare2', RARE_DF],
        ['big', RARE_DF + 500],
        ['common', RARE_DF + 1],
      ]);
      expect(buildTierJobs('lemma', ['big', 'rare1', 'missing', 'common', 'rare2'], df)).toEqual([
        { tier: 'lemma', tokens: ['rare1', 'missing', 'rare2'] },
        { tier: 'lemma', tokens: ['common'] },
        { tier: 'lemma', tokens: ['big'] },
      ]);
    });

    it('builds nothing from no tokens', () => {
      expect(buildTierJobs('part', [], new Map())).toEqual([]);
    });
  });

  it('reads tiers in order, tagging each row with its tier', async () => {
    await harness.seed({
      messages: [
        sourceMessage({ text: 'blorg itself', messageId: 'exact' }),
        sourceMessage({ text: 'blorgum inflected', messageId: 'inflected' }),
        sourceMessage({ text: 'blorgkvartana compound', messageId: 'compound' }),
      ],
    });

    const read = await plan('blorgum');

    expect(read.plan.jobs.map(({ tier }) => tier)).toEqual(['exact', 'lemma', 'part']);
    const hits = page(read).hits;
    const tier = (id: string) => hits.find(({ messageId }) => messageId === id)?.tier;
    expect(tier('inflected')).toBe('exact');
    expect(tier('exact')).toBe('lemma');
    expect(tier('compound')).toBe('part');
    expect(page(read).tierReached).toBe('part');
  });

  it('stops once the page can fill, before a lower tier', async () => {
    await harness.seed({
      messages: [
        ...Array.from({ length: SEARCH_PAGE_SIZE }, (_, index) =>
          sourceMessage({ text: 'blorgum', messageId: `e${index}` }),
        ),
        sourceMessage({ text: 'blorg', messageId: 'lemma-only' }),
      ],
    });

    const read = await plan('blorgum');

    expect(reads.windows.map(({ tokens }) => tokens)).toEqual([['blorgum']]);
    expect(page(read).hits).toHaveLength(SEARCH_PAGE_SIZE);
    expect(page(read).tierReached).toBe('exact');
    expect(read.reads).toBe(2);
    /* The word list rows count too, as the reference counts them. */
    expect(read.rows).toBe(SEARCH_PAGE_SIZE + 2);
  });

  it('keeps reading for a larger surface, and the page still replays the same stop', async () => {
    await harness.seed({
      messages: [
        ...Array.from({ length: SEARCH_PAGE_SIZE }, (_, index) =>
          sourceMessage({ text: 'blorgum', messageId: `e${index}` }),
        ),
        sourceMessage({ text: 'blorg', messageId: 'lemma-only' }),
      ],
    });

    const small = await plan('blorgum');
    const large = await plan('blorgum', { need: 1000, window: 1000 });

    expect(large.rowsByJob.length).toBeGreaterThan(small.rowsByJob.length);
    const ids = (read: typeof small) => page(read).hits.map(({ messageId }) => messageId);
    expect(ids(large)).toEqual(ids(small));
    expect(ids(large)).not.toContain('lemma-only');
    expect(page(large, 1000).hits.map(({ messageId }) => messageId)).toContain('lemma-only');
  });

  it('still reads and finds a token missing from the word list', async () => {
    await harness.seed({ messages: [sourceMessage({ text: 'freshword', messageId: 'new' })] });
    await harness.models.SearchVocab.deleteMany({});

    const read = await plan('freshword');

    expect(page(read).hits.map(({ messageId }) => messageId)).toEqual(['new']);
  });

  it('runs common tokens as separate reads, and holds read concurrency', async () => {
    await harness.seed({ messages: [sourceMessage({ text: 'kvartana', messageId: 'hit' })] });
    for (const token of ['kvart', 'kvartur']) {
      await harness.models.SearchVocab.updateOne(
        { _id: token },
        { $set: { df: RARE_DF + 100 } },
        { upsert: true },
      );
    }

    let active = 0;
    let highest = 0;
    const seen: Array<readonly string[]> = [];
    const run = createReadRunner({
      surface: 'messages',
      signal: new AbortController().signal,
      deadline: Date.now() + 10_000,
      gate: createReadGate(2),
      metrics: harness.metrics,
      logger: harness.logger,
    });
    const analyzed = analyzeQuery(harness.analyzer, 'kvartana', { queryWordLimit: 10 });
    await readSearchPlan({
      user: 'user-a',
      words: analyzed.words,
      need: 25,
      window: 200,
      readConcurrency: 2,
      run,
      methods: {
        readVocabFrequencies: harness.methods.readVocabFrequencies,
        readRecordWindow: async (params, options) => {
          seen.push(params.tokens);
          active += 1;
          highest = Math.max(highest, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          const rows = await harness.methods.readRecordWindow(params, options);
          active -= 1;
          return rows;
        },
      },
    });

    expect(seen).toEqual(expect.arrayContaining([['kvart'], ['kvartur']]));
    expect(highest).toBe(2);
  });

  it('carries the frozen plan', async () => {
    await harness.seed({ messages: [sourceMessage({ text: 'blorgum', messageId: 'hit' })] });

    const read = await plan('blorgum');

    expect(read.plan.driver).toBe(0);
    expect(read.plan.words[0]).toMatchObject({
      exact: 'blorgum',
      lemmas: ['blorg'],
      parts: ['~blorgum', '~blorg'],
    });
    expect(read.plan.words[0].df).toBeGreaterThan(0);
    expect(read.plan.jobs.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(read.plan)).jobs).toEqual(read.plan.jobs);
  });

  it('ranks a compound-only match below the word itself (US1 scenario 6)', async () => {
    await harness.seed({
      messages: [
        sourceMessage({
          text: 'blorgkvartana',
          messageId: 'compound-newer',
          createdAt: new Date('2026-06-01'),
        }),
        sourceMessage({
          text: 'blorg',
          messageId: 'word-older',
          createdAt: new Date('2026-01-01'),
        }),
      ],
    });

    const read = await plan('blorg');

    expect(page(read).hits.map(({ messageId }) => messageId)).toEqual([
      'word-older',
      'compound-newer',
    ]);
  });

  it('does not reach a compound through a part of the query word (US1 scenario 4)', async () => {
    await harness.seed({
      messages: [
        sourceMessage({ text: 'blorgkvartana', messageId: 'compound' }),
        sourceMessage({ text: 'kvartana', messageId: 'part-only' }),
      ],
    });

    const read = await plan('blorgkvartana');

    expect(page(read).hits.map(({ messageId }) => messageId)).toEqual(['compound']);
  });

  it('works for the stemmer pack', async () => {
    await harness.seed({
      messages: [
        sourceMessage({ text: 'horses in the field', messageId: 'inflected' }),
        sourceMessage({ text: 'an unrelated line', messageId: 'other' }),
      ],
    });

    const read = await plan('horse');

    expect(page(read).hits.map(({ messageId }) => messageId)).toEqual(['inflected']);
  });

  it('never returns another user (FR-029)', async () => {
    await harness.seed({
      messages: [
        sourceMessage({ text: 'blorg', messageId: 'mine' }),
        sourceMessage({ text: 'blorg', messageId: 'theirs', user: 'user-b' }),
      ],
    });

    const read = await plan('blorg');

    expect(page(read).hits.map(({ messageId }) => messageId)).toEqual(['mine']);
  });

  it('requires every word when there are several', async () => {
    await harness.seed({
      messages: [
        sourceMessage({ text: 'blorg horses', messageId: 'both' }),
        sourceMessage({ text: 'blorg alone', messageId: 'one' }),
      ],
    });

    const read = await plan('blorg horses');

    expect(page(read).hits.map(({ messageId }) => messageId)).toEqual(['both']);
  });
});
