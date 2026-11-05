import type { SearchHarness } from '../__tests__/helpers/harness';
import { createSearchHarness, sourceConversation } from '../__tests__/helpers/harness';
import { createReadGate, createReadRunner } from './retry';
import { analyzeQuery } from '../analyzer/query';
import { readTitleMatches } from './titles';

describe('readTitleMatches', () => {
  let harness: SearchHarness;

  const matches = (query: string, overrides: { limit?: number; user?: string } = {}) =>
    readTitleMatches({
      user: overrides.user ?? 'user-a',
      words: analyzeQuery(harness.analyzer, query, { queryWordLimit: 10 }).words,
      limit: overrides.limit,
      run: createReadRunner({
        surface: 'conversations',
        signal: new AbortController().signal,
        deadline: Date.now() + 5000,
        gate: createReadGate(2),
        metrics: harness.metrics,
        logger: harness.logger,
      }),
      methods: harness.methods,
    });

  beforeAll(async () => {
    harness = await createSearchHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  it('finds exact, lemma and part tiers on titles and tags', async () => {
    await harness.seed({
      conversations: [
        sourceConversation({ conversationId: 'exact', title: 'blorgum notes' }),
        sourceConversation({ conversationId: 'lemma', title: 'blorg notes' }),
        sourceConversation({ conversationId: 'part', title: 'blorgkvartana notes' }),
        sourceConversation({ conversationId: 'tag', title: 'plain', tags: ['blorg'] }),
        sourceConversation({ conversationId: 'none', title: 'unrelated' }),
      ],
    });

    expect((await matches('blorgum')).sort()).toEqual(['exact', 'lemma', 'part', 'tag']);
  });

  it('requires all words', async () => {
    await harness.seed({
      conversations: [
        sourceConversation({ conversationId: 'both', title: 'blorg horses' }),
        sourceConversation({ conversationId: 'one', title: 'blorg alone' }),
      ],
    });

    expect(await matches('blorg horse')).toEqual(['both']);
  });

  it('stops at its hit limit', async () => {
    await harness.seed({
      conversations: Array.from({ length: 5 }, () => sourceConversation({ title: 'blorg' })),
    });

    expect(await matches('blorg', { limit: 3 })).toHaveLength(3);
  });

  it('never returns another user', async () => {
    await harness.seed({
      conversations: [
        sourceConversation({ conversationId: 'theirs', user: 'user-b', title: 'blorg' }),
      ],
    });

    expect(await matches('blorg')).toEqual([]);
  });
});
