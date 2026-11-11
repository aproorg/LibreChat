import type { SearchHarness } from '../__tests__/helpers/harness';
import type { PrefixBudget } from './tiers';
import type { TypoBudget } from './typo';
import {
  createSearchHarness,
  searchConfig,
  sourceConversation,
  sourceMessage,
} from '../__tests__/helpers/harness';
import { createReadGate, createReadRunner } from './retry';
import { derivePage, SEARCH_PAGE_SIZE } from './window';
import { createSearchConfigSnapshot } from '../config';
import { analyzeQuery } from '../analyzer/query';
import { createSearchService } from '../service';
import { readSearchPlan } from './plan';

const PREFIX: PrefixBudget = { maxCommonReads: 4, maxRareTokens: 200, maxVocabRows: 50_000 };
const TYPO: TypoBudget = { maxCorrections: 8, maxVocabRows: 50_000 };

interface SearchOptions {
  prefix?: Partial<PrefixBudget>;
  typo?: Partial<TypoBudget>;
  need?: number;
}

/**
 * FR-009 to FR-012 over the fake dictionary and `en`. Every word here is invented:
 * `kerpil` is a prefix of the `kerpil…` words, and `plomkat` is one edit from `plomkit`.
 */
describe('harder queries', () => {
  let harness: SearchHarness;

  const at = (day: number) => new Date(Date.UTC(2026, 0, day));

  const words = (query: string) =>
    analyzeQuery(harness.analyzer, query, { queryWordLimit: 10 }).words;

  /** The read plan and `/search`'s ranked first page, as the service runs them. */
  const search = async (query: string, options: SearchOptions = {}) => {
    const run = createReadRunner({
      surface: 'messages',
      signal: new AbortController().signal,
      deadline: Date.now() + 10_000,
      gate: createReadGate(2),
      metrics: harness.metrics,
      logger: harness.logger,
    });
    const read = await readSearchPlan({
      user: 'user-a',
      words: words(query),
      need: options.need ?? SEARCH_PAGE_SIZE,
      window: 200,
      readConcurrency: 2,
      run,
      methods: harness.methods,
      prefix: { ...PREFIX, ...options.prefix },
      typo: { ...TYPO, ...options.typo },
    });
    const page = await derivePage(
      read,
      { limit: SEARCH_PAGE_SIZE, rankWindow: 200, lengthBucket: true },
      { user: 'user-a', run, methods: harness.methods, analyzer: harness.analyzer },
    );
    return {
      read,
      ids: page.hits.map(({ messageId }) => messageId),
      tierReached: page.tierReached,
    };
  };

  const setFrequency = (token: string, df: number) =>
    harness.models.SearchVocab.updateOne({ _id: token }, { $set: { df } });

  const serviceFor = async () => {
    const service = createSearchService({
      config: createSearchConfigSnapshot({ search: searchConfig() }),
      methods: harness.methods,
      metrics: harness.metrics,
      logger: harness.logger,
      cursorSecret: 'secret',
      resolvePacks: () => ({ ok: true, packs: harness.packs }),
    });
    await service.loadPacks();
    return service;
  };

  const context = () => ({
    user: 'user-a',
    signal: new AbortController().signal,
    startedAt: Date.now(),
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

  describe('typo tolerance', () => {
    it('corrects a word that matches nothing', async () => {
      await harness.seed({
        messages: [
          sourceMessage({ text: 'plomkit here', messageId: 'near' }),
          sourceMessage({ text: 'unrelated', messageId: 'other' }),
        ],
      });

      const { read, ids, tierReached } = await search('plomkat');

      expect(ids).toEqual(['near']);
      expect(tierReached).toBe('typo');
      expect(read.plan.words[0].typos).toEqual(['plomkit']);
    });

    it('corrects nothing for a word that matches', async () => {
      await harness.seed({
        messages: [
          sourceMessage({ text: 'plomkit here', messageId: 'near' }),
          sourceMessage({ text: 'plomkat here', messageId: 'same' }),
        ],
      });

      const { read, ids, tierReached } = await search('plomkat');

      expect(ids).toEqual(['same']);
      expect(tierReached).toBe('exact');
      expect(read.plan.words[0].typos).toBeUndefined();
    });

    it('corrects a misspelt word that is not last, before the words are combined', async () => {
      await harness.seed({
        messages: [
          sourceMessage({ text: 'plomkit vindra', messageId: 'both' }),
          sourceMessage({ text: 'vindra alone', messageId: 'one' }),
        ],
      });

      expect((await search('plomkat vindra')).ids).toEqual(['both']);
    });

    it('counts a swap of two letters as one edit', async () => {
      await harness.seed({ messages: [sourceMessage({ text: 'plomkit', messageId: 'near' })] });

      expect((await search('plomkti')).ids).toEqual(['near']);
    });

    it('keeps the first letter fixed', async () => {
      await harness.seed({ messages: [sourceMessage({ text: 'plomkit', messageId: 'near' })] });

      expect((await search('glomkit')).ids).toEqual([]);
    });

    it('allows no edit under five letters, one under nine, then two', async () => {
      await harness.seed({
        messages: [
          sourceMessage({ text: 'zarn', messageId: 'four' }),
          sourceMessage({ text: 'tuvmelor', messageId: 'eight' }),
          sourceMessage({ text: 'skandorix', messageId: 'nine' }),
        ],
      });

      expect((await search('zorn')).ids).toEqual([]);
      expect((await search('tuvmelar')).ids).toEqual(['eight']);
      expect((await search('tuvmalar')).ids).toEqual([]);
      expect((await search('skandurax')).ids).toEqual(['nine']);
    });

    it('stops at maxCorrections, most frequent first', async () => {
      await harness.seed({
        messages: [
          ...[1, 2, 3].map((n) => sourceMessage({ text: 'plomkiz', messageId: `often-${n}` })),
          ...[1, 2].map((n) => sourceMessage({ text: 'plomkib', messageId: `some-${n}` })),
          sourceMessage({ text: 'plomkic', messageId: 'rare' }),
        ],
      });

      const { read, ids } = await search('plomkix', { typo: { maxCorrections: 2 } });

      expect(read.plan.words[0].typos).toEqual(['plomkiz', 'plomkib']);
      expect([...ids].sort()).toEqual(['often-1', 'often-2', 'often-3', 'some-1', 'some-2']);
    });
  });

  describe('prefix', () => {
    it('finds a longer word from the last word, after the word itself', async () => {
      await harness.seed({
        messages: [
          sourceMessage({ text: 'kerpil', messageId: 'whole', createdAt: at(1) }),
          sourceMessage({ text: 'kerpilon', messageId: 'longer', createdAt: at(9) }),
        ],
      });

      const { ids, tierReached } = await search('kerpil');

      expect(ids).toEqual(['whole', 'longer']);
      expect(tierReached).toBe('prefix');
    });

    it('applies to the last word only', async () => {
      await harness.seed({
        messages: [sourceMessage({ text: 'kerpilon vindra', messageId: 'both' })],
      });

      expect((await search('vindra kerpil')).ids).toEqual(['both']);
      const first = await search('kerpil vindra');
      expect(first.ids).toEqual([]);
      expect(first.read.plan.words[0].prefix).toBeUndefined();
    });

    it('keeps at most maxRareTokens expansions, most frequent first', async () => {
      await harness.seed({
        messages: [
          ...[1, 2, 3].map((n) => sourceMessage({ text: 'kerpilak', messageId: `often-${n}` })),
          ...[1, 2].map((n) => sourceMessage({ text: 'kerpilok', messageId: `some-${n}` })),
          sourceMessage({ text: 'kerpilux', messageId: 'rare' }),
        ],
      });

      const { read, ids } = await search('kerpil', { prefix: { maxRareTokens: 2 } });

      expect(read.plan.words[0].prefix).toEqual(['kerpilak', 'kerpilok']);
      expect([...ids].sort()).toEqual(['often-1', 'often-2', 'often-3', 'some-1', 'some-2']);
      expect((await search('kerpil')).ids).toContain('rare');
    });

    it('reads at most maxCommonReads common expansions, each on its own', async () => {
      await harness.seed({
        messages: ['kerpilak', 'kerpilok', 'kerpilux', 'kerpilim'].map((text) =>
          sourceMessage({ text, messageId: text }),
        ),
      });
      await setFrequency('kerpilak', 900);
      await setFrequency('kerpilok', 800);
      await setFrequency('kerpilux', 700);

      const { read, ids } = await search('kerpil', { prefix: { maxCommonReads: 2 } });

      expect(read.plan.words[0].prefix).toEqual(['kerpilak', 'kerpilok', 'kerpilim']);
      expect(read.jobs.filter(({ tier }) => tier === 'prefix').map(({ tokens }) => tokens)).toEqual(
        [['kerpilim'], ['kerpilok'], ['kerpilak']],
      );
      expect([...ids].sort()).toEqual(['kerpilak', 'kerpilim', 'kerpilok']);
    });

    it('reads at most maxVocabRows of the word list, in spelling order', async () => {
      await harness.seed({
        messages: ['kerpilux', 'kerpilok', 'kerpilim', 'kerpilak'].map((text) =>
          sourceMessage({ text, messageId: text }),
        ),
      });
      const range = jest.spyOn(harness.methods, 'readVocabRange');

      const { read, ids } = await search('kerpil', { prefix: { maxVocabRows: 2 } });

      expect(range).toHaveBeenCalledWith(
        expect.objectContaining({ start: 'kerpil', limit: 2 }),
        expect.anything(),
      );
      expect([...(read.plan.words[0].prefix ?? [])].sort()).toEqual(['kerpilak', 'kerpilim']);
      expect([...ids].sort()).toEqual(['kerpilak', 'kerpilim']);
    });
  });

  describe('stop words', () => {
    it('removes a stop word before the last word is chosen', async () => {
      await harness.seed({
        messages: [sourceMessage({ text: 'kerpilon', messageId: 'longer' })],
      });

      expect(words('kerpil the').map(({ exact }) => exact)).toEqual(['kerpil']);
      expect((await search('kerpil the')).ids).toEqual(['longer']);
      expect((await search('kerpil zog')).ids).toEqual(['longer']);
    });

    it('ignores the stop words of a natural-language question', async () => {
      await harness.seed({
        messages: [
          sourceMessage({ text: 'grumtak vindra', messageId: 'both' }),
          sourceMessage({ text: 'grumtak', messageId: 'first' }),
          /* Stop words are not indexed, so a message of them alone matches nothing. */
          sourceMessage({ text: 'what is the of zog', messageId: 'stops' }),
        ],
      });

      const plain = await search('grumtak vindra');
      const question = await search('what is the grumtak of zog ðox vindra');

      expect(question.ids).toEqual(plain.ids);
      expect(question.ids).toEqual(['both', 'first']);
      expect(question.read.plan.words.map(({ exact }) => exact)).toEqual(['grumtak', 'vindra']);
    });
  });

  describe('several words', () => {
    it('requires every word while the page can fill', async () => {
      await harness.seed({
        messages: [
          sourceMessage({ text: 'grumtak vindra', messageId: 'both', createdAt: at(1) }),
          sourceMessage({ text: 'grumtak', messageId: 'first', createdAt: at(5) }),
          sourceMessage({ text: 'vindra', messageId: 'second', createdAt: at(9) }),
        ],
      });

      const { read, ids } = await search('grumtak vindra', { need: 1 });

      expect(ids).toEqual(['both']);
      expect(read.jobs.every(({ stage }) => stage === 0)).toBe(true);
    });

    it('drops trailing words when the page cannot fill, fuller matches first', async () => {
      await harness.seed({
        messages: [
          sourceMessage({ text: 'grumtak vindra zarnok', messageId: 'three', createdAt: at(1) }),
          sourceMessage({ text: 'grumtak vindra', messageId: 'two', createdAt: at(3) }),
          sourceMessage({ text: 'grumtak', messageId: 'one', createdAt: at(5) }),
          sourceMessage({ text: 'vindra zarnok', messageId: 'tail', createdAt: at(9) }),
        ],
      });

      const { read, ids } = await search('grumtak vindra zarnok');

      /* Only trailing words drop, so a message without the first word is never reached. */
      expect(ids).toEqual(['three', 'two', 'one']);
      expect([...new Set(read.jobs.map(({ stage }) => stage))]).toEqual([0, 1, 2]);
    });

    it('returns nothing when the first word matches nothing', async () => {
      await harness.seed({
        messages: [sourceMessage({ text: 'vindra', messageId: 'second' })],
      });

      expect((await search('trelvak vindra')).ids).toEqual([]);
      expect((await search('vindra trelvak')).ids).toEqual(['second']);
    });
  });

  describe('titles and tags (FR-009)', () => {
    const titles = async (query: string) =>
      (await (await serviceFor()).titleMatches(context(), query))?.conversationIds.sort();

    beforeEach(async () => {
      await harness.seed({
        conversations: [
          sourceConversation({ conversationId: 'title', title: 'plomkit kerpilon' }),
          sourceConversation({
            conversationId: 'tags',
            title: 'plain',
            tags: ['plomkit', 'vindra'],
          }),
          sourceConversation({ conversationId: 'none', title: 'unrelated' }),
        ],
      });
    });

    it('corrects a word that matches nothing', async () => {
      expect(await titles('plomkat')).toEqual(['tags', 'title']);
    });

    it('matches the last word by prefix, and no other', async () => {
      expect(await titles('plomkit kerpil')).toEqual(['title']);
      expect(await titles('kerpil plomkit')).toEqual([]);
    });

    it('requires every word', async () => {
      expect(await titles('plomkit vindra')).toEqual(['tags']);
      expect(await titles('vindra kerpilon')).toEqual([]);
    });

    it('ignores stop words, before the last word is chosen', async () => {
      expect(await titles('what is the plomkit of zog kerpil the')).toEqual(['title']);
    });

    it('returns nothing when the first word matches nothing', async () => {
      expect(await titles('trelvak vindra')).toEqual([]);
    });

    it('reaches the sidebar with the same matches', async () => {
      const service = await serviceFor();
      const matches = await service.conversationMatches(context(), 'plomkat kerpil');
      expect(matches).toEqual({ conversationIds: ['title'] });
    });
  });

  describe('a query with no usable word (FR-012)', () => {
    it.each(['the', 'zog', 'ðox', 'what is the zog'])(
      'answers only_stop_words on every surface for "%s", with no read',
      async (query) => {
        const service = await serviceFor();
        const reads = [
          jest.spyOn(harness.methods, 'readVocabFrequencies'),
          jest.spyOn(harness.methods, 'readRecordWindow'),
          jest.spyOn(harness.methods, 'readConversationRecords'),
        ];

        expect(await service.searchMessages(context(), query)).toMatchObject({
          hits: [],
          nextCursor: null,
          reason: 'only_stop_words',
        });
        expect(await service.conversationMatches(context(), query)).toEqual({
          conversationIds: [],
          reason: 'only_stop_words',
        });
        expect(await service.titleMatches(context(), query)).toEqual({
          conversationIds: [],
          reason: 'only_stop_words',
        });
        for (const read of reads) {
          expect(read).not.toHaveBeenCalled();
        }
      },
    );

    it.each(['???', '   ', '...'])(
      'answers the ordinary empty result for "%s", with no reason',
      async (query) => {
        const service = await serviceFor();

        const messages = await service.searchMessages(context(), query);
        expect(messages).toMatchObject({ hits: [], nextCursor: null });
        expect(messages).not.toHaveProperty('reason');
        expect(await service.conversationMatches(context(), query)).toEqual({
          conversationIds: [],
        });
        expect(await service.titleMatches(context(), query)).toEqual({ conversationIds: [] });
      },
    );
  });
});
