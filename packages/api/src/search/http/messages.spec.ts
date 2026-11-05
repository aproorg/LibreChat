import type { SearchHarness } from '../__tests__/helpers/harness';
import {
  createSearchHarness,
  searchConfig,
  sourceConversation,
  sourceMessage,
} from '../__tests__/helpers/harness';
import { createSearchConfigSnapshot } from '../config';
import { createSearchMessagesRoute } from './messages';
import { createSearchService } from '../service';

describe('searchMessagesRoute', () => {
  let harness: SearchHarness;

  const routeFor = async (search: Parameters<typeof searchConfig>[0] = {}) => {
    const service = createSearchService({
      config: createSearchConfigSnapshot({ search: searchConfig(search) }),
      methods: harness.methods,
      metrics: harness.metrics,
      logger: harness.logger,
      cursorSecret: 'secret',
      resolvePacks: () => ({ ok: true, packs: harness.packs }),
    });
    await service.loadPacks();
    return createSearchMessagesRoute({
      service,
      methods: harness.methods,
      metrics: harness.metrics,
    });
  };

  const contextFor = (user = 'user-a') => ({
    user,
    signal: new AbortController().signal,
    startedAt: Date.now(),
  });

  const visible = (conversationId = 'convo-a', fields = {}) =>
    sourceConversation({ conversationId, title: 'A title', model: 'a-model', ...fields });

  const ids = (response: { body: unknown } | null) =>
    ((response?.body as { messages: Array<{ messageId: string }> }).messages ?? []).map(
      ({ messageId }) => messageId,
    );

  beforeAll(async () => {
    harness = await createSearchHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  it.each(['meilisearch', 'shadow'] as const)('answers null on %s', async (backend) => {
    const route = await routeFor({ backend });
    expect(await route(contextFor(), 'blorg', null)).toBeNull();
    expect(harness.logged.filter(({ event }) => event === 'search.request')).toEqual([]);
  });

  it('drops hits for a temporary, subagent, unfinished or expired message in a visible chat', async () => {
    const later = new Date(Date.now() + 3_600_000);
    const earlier = new Date(Date.now() - 3_600_000);
    /* A stale record whose source has since become unsearchable. */
    const stale: Array<[string, Record<string, unknown>]> = [
      ['temporary', { isTemporary: true, expiredAt: later }],
      ['subagent', { subagentTask: { attemptKey: 'k' } }],
      ['unfinished', { unfinished: true }],
      ['expired', { isTemporary: false, expiredAt: earlier }],
    ];
    await harness.seed({
      messages: [
        sourceMessage({ text: 'blorg', messageId: 'kept' }),
        ...stale.map(([messageId]) => sourceMessage({ text: 'blorg', messageId })),
      ],
      conversations: [visible()],
    });
    for (const [messageId, fields] of stale) {
      await harness.database.connection
        .db!.collection('messages')
        .updateOne({ messageId }, { $set: fields });
    }
    expect(await harness.models.MessageSearch.countDocuments({})).toBe(5);

    const response = await (await routeFor())(contextFor(), 'blorg', null);

    expect(response?.status).toBe(200);
    expect(ids(response)).toEqual(['kept']);
  });

  it('drops a hit whose source message is gone', async () => {
    await harness.seed({
      messages: [sourceMessage({ text: 'blorg', messageId: 'gone' })],
      conversations: [visible()],
    });
    await harness.database.connection.db!.collection('messages').deleteMany({});

    const response = await (await routeFor())(contextFor(), 'blorg', null);

    expect(ids(response)).toEqual([]);
    expect(response?.body).toMatchObject({ messages: [], nextCursor: null });
  });

  it.each([
    ['visible, the control', {}, ['hidden']],
    ['temporary', { isTemporary: true }, []],
    ['expired', { isTemporary: false, expiredAt: new Date(Date.now() - 3_600_000) }, []],
    ['subagent thread', { subagentThread: { parent: 'p' } }, []],
  ])('filters hits by their conversation: %s', async (_name, fields, expected) => {
    await harness.seed({
      messages: [sourceMessage({ text: 'blorg', messageId: 'hidden' })],
    });
    await harness.database.connection.db!.collection('conversations').insertOne({
      _id: new harness.database.Types.ObjectId(),
      user: 'user-a',
      conversationId: 'convo-a',
      title: 'Hidden',
      ...fields,
    } as never);

    const response = await (await routeFor())(contextFor(), 'blorg', null);

    expect(response?.status).toBe(200);
    expect(ids(response)).toEqual(expected);
  });

  it('never returns another user’s message, even from a shared conversation ID', async () => {
    await harness.seed({
      messages: [
        sourceMessage({ text: 'blorg', messageId: 'mine' }),
        sourceMessage({ text: 'blorg secretword', messageId: 'theirs', user: 'user-b' }),
      ],
      conversations: [visible(), visible('convo-a', { user: 'user-b' })],
    });

    const response = await (await routeFor())(contextFor(), 'blorg', null);

    expect(ids(response)).toEqual(['mine']);
    expect(JSON.stringify(response)).not.toContain('secretword');
  });

  it('renders the fields the client renders today, in ranked order', async () => {
    await harness.seed({
      messages: [
        sourceMessage({
          text: 'blorg',
          messageId: 'older-exact',
          sender: 'User',
          isCreatedByUser: true,
          endpoint: 'openAI',
          iconURL: 'https://icon.example/x.png',
          createdAt: new Date('2026-01-01'),
        }),
        sourceMessage({
          text: 'blorgkvartana',
          messageId: 'newer-part',
          createdAt: new Date('2026-06-01'),
        }),
      ],
      conversations: [visible()],
    });

    const response = await (await routeFor())(contextFor(), 'blorg', null);

    expect(ids(response)).toEqual(['older-exact', 'newer-part']);
    expect((response?.body as { messages: unknown[] }).messages[0]).toMatchObject({
      messageId: 'older-exact',
      conversationId: 'convo-a',
      text: 'blorg',
      sender: 'User',
      title: 'A title',
      model: 'a-model',
      isCreatedByUser: true,
      endpoint: 'openAI',
      iconURL: 'https://icon.example/x.png',
    });
  });

  it('never lets private fields leave (FR-014)', async () => {
    await harness.seed({
      messages: [
        sourceMessage({
          text: 'blorg',
          messageId: 'hit',
          contextMeta: { secret: 'PRIVATE_SENTINEL' },
          summary: 'PRIVATE_SENTINEL',
          clientId: 'PRIVATE_SENTINEL',
          metadata: { thoughtSignatures: ['PRIVATE_SENTINEL'] },
          _meiliIndex: true,
        }),
      ],
      conversations: [visible()],
    });

    const response = await (await routeFor())(contextFor(), 'blorg', null);

    const [message] = (response?.body as { messages: Array<Record<string, unknown>> }).messages;
    expect(JSON.stringify(message)).not.toContain('PRIVATE_SENTINEL');
    for (const field of ['_id', 'user', 'contextMeta', 'summary', '_meiliIndex', 'tokens']) {
      expect(message).not.toHaveProperty(field);
    }
  });

  it('has no pageSize: the page is always 25', async () => {
    await harness.seed({
      messages: Array.from({ length: 30 }, (_, index) =>
        sourceMessage({ text: 'blorg', messageId: `m${index}` }),
      ),
      conversations: [visible()],
    });

    const response = await (await routeFor())(contextFor(), 'blorg', null);

    expect(ids(response)).toHaveLength(25);
  });

  it('returns a null cursor until paging exists, and rejects any cursor sent', async () => {
    await harness.seed({
      messages: [sourceMessage({ text: 'blorg' })],
      conversations: [visible()],
    });
    const route = await routeFor();

    expect((await route(contextFor(), 'blorg', null))?.body).toMatchObject({ nextCursor: null });
    expect(await route(contextFor(), 'blorg', 's1.anything')).toEqual({
      status: 400,
      body: { code: 'search_cursor_invalid' },
    });
  });

  it('answers the stop-word reason with an empty list', async () => {
    const response = await (await routeFor())(contextFor(), 'the', null);
    expect(response).toEqual({
      status: 200,
      body: { messages: [], nextCursor: null, reason: 'only_stop_words' },
    });
  });

  it('answers an empty list for a query that is not text', async () => {
    const response = await (await routeFor())(contextFor(), ['a', 'b'] as never, null);
    expect(response?.body).toEqual({ messages: [], nextCursor: null });
  });

  it.each([
    ['a read failure', new Error('SENTINEL'), 500, 'search_failed'],
    [
      'a cursor limit',
      Object.assign(new Error('Cannot open a new cursor'), { code: 2 }),
      503,
      'search_busy',
    ],
  ])(
    'maps %s on a hydration read to its code, with no raw text',
    async (_name, failure, status, code) => {
      await harness.seed({
        messages: [sourceMessage({ text: 'blorg' })],
        conversations: [visible()],
      });
      const route = await routeFor();
      jest.spyOn(harness.methods, 'getSearchableMessages').mockRejectedValue(failure);

      const response = await route(contextFor(), 'blorg', null);

      expect(response).toEqual({ status, body: { code } });
      expect(JSON.stringify(harness.logged)).not.toContain('SENTINEL');
    },
  );

  it('emits search.request, with no query text', async () => {
    await harness.seed({
      messages: [sourceMessage({ text: 'blorg' })],
      conversations: [visible()],
    });

    await (
      await routeFor()
    )(contextFor(), 'blorg', null);

    const event = harness.logged.find(({ event: name }) => name === 'search.request');
    expect(event?.meta).toEqual({
      surface: 'messages',
      backend: 'search',
      detached: false,
      ms: expect.any(Number),
      reads: expect.any(Number),
      rows: expect.any(Number),
      words: 1,
      tierReached: 'exact',
      coldAfterIdle: true,
      isLargestUser: false,
      outcome: 'ok',
    });
    expect(JSON.stringify(harness.logged)).not.toContain('blorg');
  });
});
