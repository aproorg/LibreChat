import type { SearchHarness } from '../__tests__/helpers/harness';
import { createSearchHarness, sourceConversation } from '../__tests__/helpers/harness';
import { createReadGate, createReadRunner } from './retry';
import { analyzeQuery } from '../analyzer/query';
import { createPlanExpansions } from './plan';
import { readTitleMatches } from './titles';

const BUDGETS = {
  prefix: { maxCommonReads: 4, maxRareTokens: 200, maxVocabRows: 50_000 },
  typo: { maxCorrections: 8, maxVocabRows: 50_000 },
};

describe('readTitleMatches', () => {
  let harness: SearchHarness;

  const matches = (query: string, overrides: { limit?: number; user?: string } = {}) => {
    const run = createReadRunner({
      surface: 'conversations',
      signal: new AbortController().signal,
      deadline: Date.now() + 5000,
      gate: createReadGate(2),
      metrics: harness.metrics,
      logger: harness.logger,
    });
    return readTitleMatches({
      user: overrides.user ?? 'user-a',
      words: analyzeQuery(harness.analyzer, query, { queryWordLimit: 10 }).words,
      limit: overrides.limit,
      run,
      methods: harness.methods,
      expansions: createPlanExpansions({ run, methods: harness.methods, ...BUDGETS }),
    });
  };

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

  describe('prefix, typo and all-words matching (FR-009)', () => {
    it('matches the last word by prefix, on a title and on a tag', async () => {
      await harness.seed({
        conversations: [
          sourceConversation({ conversationId: 'title', title: 'kerpilon notes' }),
          sourceConversation({ conversationId: 'tag', title: 'plain', tags: ['kerpilon'] }),
          sourceConversation({ conversationId: 'none', title: 'unrelated' }),
        ],
      });

      expect((await matches('kerpil')).sort()).toEqual(['tag', 'title']);
      expect((await matches('notes kerpil')).sort()).toEqual(['title']);
    });

    it('gives no prefix to a word that is not last', async () => {
      await harness.seed({
        conversations: [sourceConversation({ conversationId: 'both', title: 'kerpilon vindra' })],
      });

      expect(await matches('kerpil vindra')).toEqual([]);
      expect(await matches('vindra kerpil')).toEqual(['both']);
    });

    it('corrects a word the word list lacks, on a title and on a tag', async () => {
      await harness.seed({
        conversations: [
          sourceConversation({ conversationId: 'title', title: 'plomkit report' }),
          sourceConversation({ conversationId: 'tag', title: 'plain', tags: ['plomkit'] }),
          sourceConversation({ conversationId: 'none', title: 'unrelated' }),
        ],
      });

      expect((await matches('plomkat')).sort()).toEqual(['tag', 'title']);
      expect(await matches('plomkat report')).toEqual(['title']);
    });

    it('corrects nothing when the word list has the word', async () => {
      await harness.seed({
        conversations: [
          sourceConversation({ conversationId: 'near', title: 'plomkit' }),
          sourceConversation({ conversationId: 'same', title: 'plomkat' }),
        ],
      });

      expect(await matches('plomkat')).toEqual(['same']);
    });

    it('keeps the first letter, and corrects no word under five letters', async () => {
      await harness.seed({
        conversations: [
          sourceConversation({ conversationId: 'long', title: 'plomkit' }),
          sourceConversation({ conversationId: 'short', title: 'zarn' }),
        ],
      });

      expect(await matches('glomkit')).toEqual([]);
      expect(await matches('zorn')).toEqual([]);
    });

    it('requires every word, each at its own tier', async () => {
      await harness.seed({
        conversations: [
          sourceConversation({ conversationId: 'all', title: 'blorgum plomkit kerpilon' }),
          sourceConversation({ conversationId: 'split', title: 'blorgum', tags: ['kerpilon'] }),
          sourceConversation({ conversationId: 'two', title: 'blorgum kerpilon' }),
          sourceConversation({ conversationId: 'one', title: 'plomkit' }),
        ],
      });

      expect(await matches('blorg plomkat kerpil')).toEqual(['all']);
      expect((await matches('blorg kerpil')).sort()).toEqual(['all', 'split', 'two']);
    });

    it('returns nothing when the first word matches nothing', async () => {
      await harness.seed({
        conversations: [sourceConversation({ conversationId: 'second', title: 'vindra' })],
      });

      expect(await matches('trelvak vindra')).toEqual([]);
    });
  });
});
