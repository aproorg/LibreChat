import { createMethods, SearchError } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { SearchHarness } from '../__tests__/helpers/harness';
import {
  createSearchHarness,
  searchConfig,
  sourceConversation,
  sourceMessage,
} from '../__tests__/helpers/harness';
import { createConversationSearch } from './conversations';
import { createSearchConfigSnapshot } from '../config';
import { createSearchService } from '../service';

describe('createConversationSearch', () => {
  let harness: SearchHarness;

  const searchFor = async (search: Parameters<typeof searchConfig>[0] = {}) => {
    const service = createSearchService({
      config: createSearchConfigSnapshot({ search: searchConfig(search) }),
      methods: harness.methods,
      metrics: harness.metrics,
      logger: harness.logger,
      cursorSecret: 'secret',
      resolvePacks: () => ({ ok: true, packs: harness.packs }),
    });
    await service.loadPacks();
    return {
      service,
      conversations: createConversationSearch({
        service,
        metrics: harness.metrics,
        logger: harness.logger,
      }),
    };
  };

  const req = { user: { id: 'user-a' } } as unknown as Request;
  const res = { once: () => undefined, writableFinished: false } as unknown as Response;

  beforeAll(async () => {
    harness = await createSearchHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  it('builds no context on meilisearch', async () => {
    const { conversations } = await searchFor({ backend: 'meilisearch' });
    expect(conversations.context(req, res)).toBeUndefined();
    expect(harness.logged).toEqual([
      expect.objectContaining({ event: 'search.pack' }),
      expect.objectContaining({ event: 'search.pack' }),
    ]);
  });

  describe('US1 scenario 7', () => {
    const titleAndMessage = () =>
      harness.seed({
        messages: [
          sourceMessage({ text: 'blorg', conversationId: 'by-message' }),
          sourceMessage({
            text: 'blorg',
            conversationId: 'by-message-cut',
            createdAt: new Date('2020-01-01'),
          }),
        ],
        conversations: [
          sourceConversation({
            conversationId: 'by-title',
            title: 'blorg',
            updatedAt: new Date('2026-01-01'),
          }),
          sourceConversation({
            conversationId: 'by-message',
            title: 'other',
            updatedAt: new Date('2026-02-01'),
          }),
          sourceConversation({
            conversationId: 'by-message-cut',
            title: 'other',
            updatedAt: new Date('2026-03-01'),
          }),
          sourceConversation({
            conversationId: 'unmatched',
            title: 'other',
            updatedAt: new Date('2026-04-01'),
          }),
        ],
      });

    const sidebar = async (limit: number) => {
      const { service, conversations } = await searchFor({ sidebarLimit: limit });
      const methods = createMethods(harness.database, { getSearchPort: () => service });
      const searchContext = conversations.context(req, res);
      const result = await methods.getConvosByCursor('user-a', { search: 'blorg', searchContext });
      return { result, conversations, searchContext };
    };

    it('reports the search figures in its search.request', async () => {
      await titleAndMessage();
      const { result, conversations, searchContext } = await sidebar(1000);

      conversations.completed(searchContext, result);

      const event = harness.logged.find(({ event: name }) => name === 'search.request');
      expect(event?.meta).toMatchObject({
        surface: 'conversations',
        words: 1,
        tierReached: 'exact',
        outcome: 'ok',
      });
      expect((event?.meta as { reads: number }).reads).toBeGreaterThan(0);
      expect((event?.meta as { rows: number }).rows).toBeGreaterThan(0);
    });

    it('shows the union of title and message matches, sorted by last update', async () => {
      await titleAndMessage();
      const { result } = await sidebar(1000);
      expect(result.conversations.map(({ conversationId }) => conversationId)).toEqual([
        'by-message-cut',
        'by-message',
        'by-title',
      ]);
    });

    it('caps only the message window with a lowered sidebar limit', async () => {
      await titleAndMessage();
      const { result } = await sidebar(1);
      expect(result.conversations.map(({ conversationId }) => conversationId)).toEqual([
        'by-message',
        'by-title',
      ]);
    });
  });

  it('emits search.request on completion, with partial as its outcome', async () => {
    const { conversations } = await searchFor();
    const context = conversations.context(req, res)!;

    conversations.completed(context, { conversations: [{}], partial: true });
    conversations.completed(context, { conversations: [] });
    conversations.completed(context, { conversations: [{}] });

    const outcomes = harness.logged
      .filter(({ event }) => event === 'search.request')
      .map(({ meta }) => meta as { surface: string; outcome: string });
    expect(outcomes.map(({ outcome }) => outcome)).toEqual(['partial', 'empty', 'ok']);
    expect(outcomes[0].surface).toBe('conversations');
  });

  it('logs the sidebar request of a first-after-idle search as cold', async () => {
    const { service, conversations } = await searchFor();
    const noted = jest.spyOn(service, 'noteRequest');
    /* The messages route notes its request when it starts, a moment before the sidebar's. */
    expect(service.noteRequest('user-a').coldAfterIdle).toBe(true);

    const context = conversations.context(req, res);
    expect(noted).toHaveBeenCalledTimes(2);
    conversations.completed(context, { conversations: [] });

    /* Noted once, at the start: the end of the request must not move the idle clock. */
    expect(noted).toHaveBeenCalledTimes(2);
    const event = harness.logged.find(({ event: name }) => name === 'search.request');
    expect(event?.meta).toEqual(
      expect.objectContaining({ surface: 'conversations', coldAfterIdle: true }),
    );
  });

  it('maps a SearchError to its code, and emits it', async () => {
    const { conversations } = await searchFor();
    const context = conversations.context(req, res)!;

    expect(conversations.failure(context, new SearchError('search_busy'))).toEqual({
      status: 503,
      body: { code: 'search_busy' },
    });
    expect(harness.logged[harness.logged.length - 1]?.meta).toMatchObject({
      outcome: 'search_busy',
    });
  });

  it('answers with a code for a later failure, with no error text', async () => {
    const { conversations } = await searchFor();
    const context = conversations.context(req, res);

    expect(conversations.failure(context, new Error('raw detail'))).toEqual({
      status: 500,
      body: { code: 'search_failed' },
    });
    expect(harness.logged[harness.logged.length - 1]?.meta).toMatchObject({
      outcome: 'search_failed',
    });
    expect(JSON.stringify(harness.logged)).not.toContain('raw detail');
  });

  it('leaves everything to the route without a context, as today', async () => {
    const { conversations } = await searchFor();
    expect(conversations.failure(undefined, new Error('raw'))).toBeNull();
    expect(conversations.failure(undefined, new SearchError('search_busy'))).toBeNull();
  });
});
