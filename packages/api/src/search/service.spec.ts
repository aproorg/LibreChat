import { tenantStorage } from '@librechat/data-schemas';
import type { SearchHarness } from './__tests__/helpers/harness';
import {
  createSearchHarness,
  searchConfig,
  sourceConversation,
  sourceMessage,
} from './__tests__/helpers/harness';
import { createFakeDictionaryPack } from './languages/__tests__/helpers/fakeDictionary';
import { createSearchConfigSnapshot } from './config';
import { SEARCH_PAGE_SIZE } from './read/window';
import { createSearchService } from './service';

const contextFor = (user = 'user-a', signal = new AbortController().signal) => ({
  user,
  signal,
  startedAt: Date.now(),
});

describe('createSearchService', () => {
  let harness: SearchHarness;

  const service = async (search: Parameters<typeof searchConfig>[0] = {}, load = true) => {
    const created = createSearchService({
      config: createSearchConfigSnapshot({ search: searchConfig(search) }),
      methods: harness.methods,
      metrics: harness.metrics,
      logger: harness.logger,
      cursorSecret: 'test-secret',
      resolvePacks: () => ({ ok: true, packs: harness.packs }),
    });
    if (load) {
      await created.loadPacks();
    }
    return created;
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

  describe('routing', () => {
    it('answers null on meilisearch', async () => {
      const created = await service({ backend: 'meilisearch' });
      expect(created.isServing()).toBe(false);
      expect(await created.searchMessages(contextFor(), 'word')).toBeNull();
      expect(await created.conversationMatches(contextFor(), 'word')).toBeNull();
      expect(await created.titleMatches(contextFor(), 'word')).toBeNull();
    });

    it('answers null by default, loading no pack and reading nothing', async () => {
      const load = jest.fn(async () => undefined);
      const created = createSearchService({
        config: createSearchConfigSnapshot({}),
        methods: harness.methods,
        metrics: harness.metrics,
        logger: harness.logger,
        cursorSecret: 'secret',
        resolvePacks: () => ({
          ok: true,
          packs: [{ ...harness.packs[0], load }],
        }),
      });
      await created.loadPacks();

      expect(load).not.toHaveBeenCalled();
      expect(harness.logged.filter(({ event }) => event === 'search.pack')).toEqual([]);
      expect(await created.searchMessages(contextFor(), 'word')).toBeNull();
    });
  });

  describe('packState', () => {
    it('search_busy while loading, and no read', async () => {
      const created = await service({}, false);
      expect(created.packState()).toBe('loading');
      await expect(created.searchMessages(contextFor(), 'blorg')).rejects.toMatchObject({
        code: 'search_busy',
      });
      await expect(created.conversationMatches(contextFor(), 'blorg')).rejects.toMatchObject({
        code: 'search_busy',
      });
    });

    it('search_failed when a pack failed, with chat unaffected', async () => {
      const failing = createFakeDictionaryPack({ failLoad: true });
      const created = createSearchService({
        config: createSearchConfigSnapshot({ search: searchConfig() }),
        methods: harness.methods,
        metrics: harness.metrics,
        logger: harness.logger,
        cursorSecret: 'secret',
        resolvePacks: () => ({ ok: true, packs: [failing] }),
      });

      await expect(created.loadPacks()).resolves.toBeUndefined();

      expect(created.packState()).toBe('failed');
      expect(
        harness.logged.find(({ event }) => event === '[search] Language pack failed')?.meta,
      ).toEqual({ id: 'fake', code: expect.any(String) });
      await expect(created.searchMessages(contextFor(), 'blorg')).rejects.toMatchObject({
        code: 'search_failed',
      });
      expect(harness.logged.find(({ event }) => event === 'search.pack')?.meta).toMatchObject({
        id: 'fake',
        state: 'failed',
      });
    });

    it('search_failed for an unregistered ID, emitted by its ID', async () => {
      const created = createSearchService({
        config: createSearchConfigSnapshot({ search: searchConfig({ languages: ['zz'] }) }),
        methods: harness.methods,
        metrics: harness.metrics,
        logger: harness.logger,
        cursorSecret: 'secret',
      });

      await created.loadPacks();

      expect(created.packState()).toBe('failed');
      expect(harness.logged.find(({ event }) => event === 'search.pack')?.meta).toMatchObject({
        id: 'zz',
        state: 'failed',
      });
    });

    it('search_failed with data off on the search backend, and no load', async () => {
      const created = await service({ data: false });
      await expect(created.searchMessages(contextFor(), 'blorg')).rejects.toMatchObject({
        code: 'search_failed',
      });
      expect(harness.logged.filter(({ event }) => event === 'search.pack')).toEqual([]);
    });

    it('emits a loaded event per pack with time and memory', async () => {
      await service();
      const events = harness.logged.filter(({ event }) => event === 'search.pack');
      expect(events.map(({ meta }) => (meta as { id: string }).id)).toEqual(['fake', 'en']);
      expect(events[0].meta).toEqual({
        id: 'fake',
        state: 'loaded',
        ms: expect.any(Number),
        rssDelta: expect.any(Number),
      });
    });
  });

  describe('searchMessages', () => {
    it('answers ranked hits for the session user only', async () => {
      await harness.seed({
        messages: [
          sourceMessage({ text: 'blorg', messageId: 'mine' }),
          sourceMessage({ text: 'blorg', messageId: 'theirs', user: 'user-b' }),
        ],
      });
      const created = await service();

      const result = await created.searchMessages(contextFor(), 'blorg');

      expect(result?.hits.map(({ messageId }) => messageId)).toEqual(['mine']);
      expect(result).toMatchObject({ tierReached: 'exact', words: 1 });
    });

    it('answers a reason for only stop words, with no read', async () => {
      const created = await service();
      const read = jest.spyOn(harness.methods, 'readRecordWindow');

      expect(await created.searchMessages(contextFor(), 'the zog')).toMatchObject({
        hits: [],
        reason: 'only_stop_words',
      });
      expect(await created.searchMessages(contextFor(), '   ')).toMatchObject({ hits: [] });
      expect((await created.searchMessages(contextFor(), '   '))?.reason).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
    });

    it('counts a search once against the cap, with both surfaces on one read', async () => {
      await harness.seed({
        messages: [sourceMessage({ text: 'blorg', messageId: 'one' })],
        conversations: [sourceConversation({ conversationId: 'convo-a', title: 'unrelated' })],
      });
      const created = await service({ maxConcurrentSearches: 1 });
      const read = jest.spyOn(harness.methods, 'readRecordWindow');

      const [page, sidebar] = await Promise.all([
        created.searchMessages(contextFor(), 'blorg'),
        created.conversationMatches(contextFor(), 'blorg'),
      ]);

      expect(page?.hits).toHaveLength(1);
      expect(sidebar?.partial).toBeUndefined();
      expect(sidebar?.conversationIds).toEqual(['convo-a']);
      const readsForOneToken = read.mock.calls.filter(([{ tokens }]) => tokens[0] === 'blorg');
      expect(readsForOneToken).toHaveLength(1);
    });

    it('keeps users apart in the shared read', async () => {
      await harness.seed({
        messages: [
          sourceMessage({ text: 'blorg', messageId: 'a' }),
          sourceMessage({ text: 'blorg', messageId: 'b', user: 'user-b' }),
        ],
      });
      const created = await service();

      const [first, second] = await Promise.all([
        created.searchMessages(contextFor('user-a'), 'blorg'),
        created.searchMessages(contextFor('user-b'), 'blorg'),
      ]);

      expect(first?.hits.map(({ messageId }) => messageId)).toEqual(['a']);
      expect(second?.hits.map(({ messageId }) => messageId)).toEqual(['b']);
    });

    it.each([200, 1000])(
      'gives the same first page whichever surface fired first, at limit %i',
      async (sidebarLimit) => {
        const messages = Array.from({ length: 60 }, (_, index) =>
          sourceMessage({
            text: index % 2 ? 'blorgum' : 'blorg',
            messageId: `m${index}`,
            conversationId: `c${index}`,
            createdAt: new Date(Date.UTC(2026, 0, 1 + index)),
          }),
        );
        await harness.seed({ messages });

        const pageFirst = await service({ sidebarLimit });
        const fromPage = await pageFirst.searchMessages(contextFor(), 'blorg');
        await pageFirst.conversationMatches(contextFor(), 'blorg');

        const sidebarFirst = await service({ sidebarLimit });
        await sidebarFirst.conversationMatches(contextFor(), 'blorg');
        const fromSidebar = await sidebarFirst.searchMessages(contextFor(), 'blorg');

        expect(fromPage?.hits).toHaveLength(SEARCH_PAGE_SIZE);
        expect(fromSidebar?.hits).toEqual(fromPage?.hits);
      },
    );

    it('fails as busy at the cap, at once', async () => {
      await harness.seed({ messages: [sourceMessage({ text: 'blorg' })] });
      const created = await service({ maxConcurrentSearches: 1 });
      const pending = created.searchMessages(contextFor(), 'blorg');

      await expect(created.searchMessages(contextFor(), 'horse')).rejects.toMatchObject({
        code: 'search_busy',
      });
      await pending;
    });

    it('reports failures by code, with no raw text, and does not keep them', async () => {
      await harness.seed({ messages: [sourceMessage({ text: 'blorg', messageId: 'hit' })] });
      const created = await service();
      const read = jest
        .spyOn(harness.methods, 'readRecordWindow')
        .mockRejectedValueOnce(new Error('SENTINEL_DRIVER_TEXT'));

      await expect(created.searchMessages(contextFor(), 'blorg')).rejects.toMatchObject({
        code: 'search_failed',
      });
      expect(JSON.stringify(harness.logged)).not.toContain('SENTINEL_DRIVER_TEXT');

      read.mockRestore();
      const retried = await created.searchMessages(contextFor(), 'blorg');
      expect(retried?.hits).toHaveLength(1);
    });
  });

  describe('conversationMatches', () => {
    it('is the union of title and message matches, within the sidebar limit', async () => {
      await harness.seed({
        messages: [
          sourceMessage({ text: 'blorg', conversationId: 'by-message' }),
          sourceMessage({
            text: 'blorg',
            conversationId: 'cut-by-limit',
            createdAt: new Date('2020-01-01'),
          }),
        ],
        conversations: [sourceConversation({ conversationId: 'by-title', title: 'blorg' })],
      });
      const created = await service({ sidebarLimit: 1 });

      const matches = await created.conversationMatches(contextFor(), 'blorg');

      expect(matches?.conversationIds.sort()).toEqual(['by-message', 'by-title']);
    });

    it('falls back to titles with partial when the message read fails, and emits it', async () => {
      await harness.seed({
        conversations: [sourceConversation({ conversationId: 'by-title', title: 'blorg' })],
      });
      const created = await service();
      jest.spyOn(harness.methods, 'readVocabFrequencies').mockRejectedValueOnce(new Error('down'));

      const matches = await created.conversationMatches(contextFor(), 'blorg');

      expect(matches).toEqual({ conversationIds: ['by-title'], partial: true });
      expect(harness.logged.find(({ event }) => event === 'search.partial')?.meta).toEqual({
        surface: 'conversations',
        code: 'search_failed',
      });
    });

    it('throws when the title read fails, discarding message hits', async () => {
      await harness.seed({ messages: [sourceMessage({ text: 'blorg' })] });
      const created = await service();
      jest
        .spyOn(harness.methods, 'readConversationRecords')
        .mockRejectedValueOnce(Object.assign(new Error('x'), { code: 50 }));

      await expect(created.conversationMatches(contextFor(), 'blorg')).rejects.toMatchObject({
        code: 'search_busy',
      });
    });

    it('takes no cap slot for titles', async () => {
      await harness.seed({
        conversations: [sourceConversation({ conversationId: 'by-title', title: 'blorg' })],
      });
      const created = await service({ maxConcurrentSearches: 1 });
      jest
        .spyOn(harness.methods, 'readVocabFrequencies')
        .mockImplementationOnce(() => new Promise(() => undefined));
      const controller = new AbortController();
      const stuck = created.searchMessages(contextFor('user-a', controller.signal), 'horse');

      await expect(created.titleMatches(contextFor(), 'blorg')).resolves.toEqual({
        conversationIds: ['by-title'],
      });

      controller.abort();
      await expect(stuck).rejects.toMatchObject({ code: 'search_busy' });
    });

    it('answers a reason for only stop words', async () => {
      const created = await service();
      expect(await created.conversationMatches(contextFor(), 'the')).toEqual({
        conversationIds: [],
        reason: 'only_stop_words',
      });
    });

    it('answers nothing for a query with no words', async () => {
      const created = await service();
      expect(await created.conversationMatches(contextFor(), '...')).toEqual({
        conversationIds: [],
      });
    });
  });

  describe('failures and limits across surfaces', () => {
    it('codes a pack throwing on a word, on the sidebar too, and logs no word', async () => {
      const created = createSearchService({
        config: createSearchConfigSnapshot({ search: searchConfig() }),
        methods: harness.methods,
        metrics: harness.metrics,
        logger: harness.logger,
        cursorSecret: 'secret',
        resolvePacks: () => ({
          ok: true,
          packs: [
            {
              ...harness.packs[0],
              lemmas: () => {
                throw new Error('failed on blorg');
              },
            },
            harness.packs[1],
          ],
        }),
      });
      await created.loadPacks();

      await expect(created.conversationMatches(contextFor(), 'blorg')).rejects.toMatchObject({
        name: 'SearchError',
        code: 'search_failed',
      });
      await expect(created.searchMessages(contextFor(), 'blorg')).rejects.toMatchObject({
        code: 'search_failed',
      });
    });

    it('holds a sidebar search to readConcurrency across title and message reads', async () => {
      await harness.seed({
        messages: [sourceMessage({ text: 'blorg' })],
        conversations: [sourceConversation({ title: 'blorg' })],
      });
      let active = 0;
      let most = 0;
      const tracked =
        <A extends unknown[], R>(read: (...args: A) => Promise<R>) =>
        async (...args: A): Promise<R> => {
          active += 1;
          most = Math.max(most, active);
          try {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return await read(...args);
          } finally {
            active -= 1;
          }
        };
      const { methods } = harness;
      const created = createSearchService({
        config: createSearchConfigSnapshot({ search: searchConfig({ readConcurrency: 1 }) }),
        methods: {
          ...methods,
          readVocabFrequencies: tracked(methods.readVocabFrequencies),
          readRecordWindow: tracked(methods.readRecordWindow),
          readConversationRecords: tracked(methods.readConversationRecords),
        },
        metrics: harness.metrics,
        logger: harness.logger,
        cursorSecret: 'secret',
        resolvePacks: () => ({ ok: true, packs: harness.packs }),
      });
      await created.loadPacks();

      const result = await created.conversationMatches(contextFor(), 'blorg');

      expect(result?.conversationIds.length).toBeGreaterThan(0);
      expect(most).toBe(1);
    });

    it('treats a client leaving during the message read as aborted, not partial', async () => {
      await harness.seed({
        conversations: [sourceConversation({ title: 'blorg' })],
      });
      const controller = new AbortController();
      const { methods } = harness;
      const created = createSearchService({
        config: createSearchConfigSnapshot({ search: searchConfig() }),
        methods: {
          ...methods,
          readRecordWindow: async () => {
            controller.abort();
            return [];
          },
        },
        metrics: harness.metrics,
        logger: harness.logger,
        cursorSecret: 'secret',
        resolvePacks: () => ({ ok: true, packs: harness.packs }),
      });
      await created.loadPacks();

      await expect(
        created.conversationMatches(contextFor('user-a', controller.signal), 'blorg'),
      ).rejects.toMatchObject({ code: 'search_busy' });
      expect(harness.logged.filter(({ event }) => event === 'search.partial')).toEqual([]);
    });

    it('never shares a read between tenants, for the same user ID', async () => {
      const { methods } = harness;
      const readRecordWindow = jest.fn(async () => []);
      const created = createSearchService({
        config: createSearchConfigSnapshot({ search: searchConfig() }),
        methods: { ...methods, readRecordWindow },
        metrics: harness.metrics,
        logger: harness.logger,
        cursorSecret: 'secret',
        resolvePacks: () => ({ ok: true, packs: harness.packs }),
      });
      await created.loadPacks();
      const search = (tenantId: string) =>
        tenantStorage.run({ tenantId }, async () => {
          await created.searchMessages(contextFor(), 'blorg');
          return readRecordWindow.mock.calls.length;
        });

      const afterFirst = await search('tenant-a');
      expect(afterFirst).toBeGreaterThan(0);
      expect(await search('tenant-a')).toBe(afterFirst);
      expect(await search('tenant-b')).toBeGreaterThan(afterFirst);
    });

    it('reports a served read as no reads of its own', async () => {
      await harness.seed({
        messages: [sourceMessage({ text: 'blorg' })],
        conversations: [sourceConversation({ title: 'other' })],
      });
      const created = await service();

      const first = await created.searchMessages(contextFor(), 'blorg');
      const second = await created.searchMessages(contextFor(), 'blorg');

      expect(first?.reads).toBeGreaterThan(0);
      expect(first?.rows).toBeGreaterThan(0);
      expect(second).toMatchObject({ reads: 0, rows: 0, words: 1 });
      expect(second?.hits).toEqual(first?.hits);
    });

    it('keeps a sidebar search figures for its event', async () => {
      await harness.seed({
        messages: [sourceMessage({ text: 'blorg' })],
        conversations: [sourceConversation({ title: 'other' })],
      });
      const created = await service();
      const context = contextFor();

      expect(created.readStats(context)).toEqual({});
      await created.conversationMatches(context, 'blorg');

      expect(created.readStats(context)).toEqual({
        words: 1,
        tierReached: 'exact',
        reads: expect.any(Number),
        rows: expect.any(Number),
      });
    });
  });

  describe('request notes', () => {
    it('is cold after 30 minutes with no search, and marks the largest user', async () => {
      let now = 1_000_000;
      const created = createSearchService({
        config: createSearchConfigSnapshot({
          search: searchConfig({ largestUserId: 'whale' }),
        }),
        methods: harness.methods,
        metrics: harness.metrics,
        logger: harness.logger,
        cursorSecret: 'secret',
        now: () => now,
      });

      expect(created.noteRequest('user-a').coldAfterIdle).toBe(true);
      now += 60_000;
      expect(created.noteRequest('user-a').coldAfterIdle).toBe(false);
      now += 30 * 60_000;
      expect(created.noteRequest('whale')).toEqual({ coldAfterIdle: true, isLargestUser: true });
      expect(created.noteRequest('user-a').isLargestUser).toBe(false);
    });

    it('never treats an unset largest user as a match', async () => {
      const created = await service();
      expect(created.noteRequest('').isLargestUser).toBe(false);
    });
  });
});
