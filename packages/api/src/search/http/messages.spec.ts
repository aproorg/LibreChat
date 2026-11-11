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

  it('answers null on meilisearch', async () => {
    const route = await routeFor({ backend: 'meilisearch' });
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

  it('returns a null cursor when one page holds everything, and rejects a cursor that is not its own', async () => {
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

  describe('load-more', () => {
    interface Page {
      status: number;
      body: { messages: Array<{ messageId: string }>; nextCursor: string | null };
    }

    const matching = (count: number) =>
      harness.seed({
        messages: Array.from({ length: count }, (_, index) =>
          sourceMessage({
            text: 'blorg',
            messageId: `m${String(index).padStart(2, '0')}`,
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
          }),
        ),
        conversations: [visible()],
      });

    /** Follows `nextCursor` to the end, bounded so a cursor that never ends fails the test. */
    const pagesFrom = async (
      route: Awaited<ReturnType<typeof routeFor>>,
      first: Page,
    ): Promise<Page[]> => {
      const pages = [first];
      for (let step = 0; step < 20 && pages[pages.length - 1].body.nextCursor !== null; step += 1) {
        const next = await route(contextFor(), 'blorg', pages[pages.length - 1].body.nextCursor);
        expect(next?.status).toBe(200);
        pages.push(next as Page);
      }
      expect(pages[pages.length - 1].body.nextCursor).toBeNull();
      return pages;
    };

    it('returns a cursor when more than a page matches, and pages to the end with no repeats', async () => {
      await matching(60);
      const route = await routeFor();

      const first = (await route(contextFor(), 'blorg', null)) as Page;
      expect(first.body.messages).toHaveLength(25);
      expect(first.body.nextCursor).toEqual(expect.stringMatching(/^s1\./));

      const pages = await pagesFrom(route, first);
      const served = pages.flatMap(({ body }) => body.messages.map(({ messageId }) => messageId));

      expect(new Set(served).size).toBe(served.length);
      expect([...served].sort()).toEqual(
        Array.from({ length: 60 }, (_, index) => `m${String(index).padStart(2, '0')}`),
      );
      /* One word, one tier and one length: the order is newest first across every page. */
      expect(served).toEqual([...served].sort().reverse());
      expect(pages[1].body.messages).toHaveLength(25);
    });

    it('returns a null cursor when exactly one page matches', async () => {
      await matching(25);

      const first = (await (await routeFor())(contextFor(), 'blorg', null)) as Page;

      expect(first.body.messages).toHaveLength(25);
      const pages = await pagesFrom(await routeFor(), first);
      expect(pages.flatMap(({ body }) => body.messages)).toHaveLength(25);
    });

    it.each([
      ['deleted', (ids: string[]) => ({ op: 'delete' as const, ids })],
      ['hidden', (ids: string[]) => ({ op: 'hide' as const, ids })],
    ])(
      'keeps the cursor when every source message of the next page was %s',
      async (_name, change) => {
        await matching(60);
        const route = await routeFor();
        const first = (await route(contextFor(), 'blorg', null)) as Page;
        /* Newest first, so the second page is the next 25 by date: m34 down to m10. */
        const { op, ids: second } = change(
          Array.from({ length: 25 }, (_, index) => `m${String(34 - index).padStart(2, '0')}`),
        );
        const stored = harness.database.connection.db!.collection('messages');
        if (op === 'delete') {
          await stored.deleteMany({ messageId: { $in: second } });
        } else {
          await stored.updateMany({ messageId: { $in: second } }, { $set: { unfinished: true } });
        }

        const emptied = (await route(contextFor(), 'blorg', first.body.nextCursor)) as Page;

        expect(emptied.status).toBe(200);
        expect(emptied.body.messages).toEqual([]);
        expect(emptied.body.nextCursor).toEqual(expect.stringMatching(/^s1\./));

        const pages = await pagesFrom(route, emptied);
        const rest = pages.flatMap(({ body }) => body.messages.map(({ messageId }) => messageId));
        expect(rest).toEqual(
          Array.from({ length: 10 }, (_, index) => `m${String(9 - index).padStart(2, '0')}`),
        );
      },
    );

    describe('a cursor the request may not use', () => {
      const INVALID = { status: 400, body: { code: 'search_cursor_invalid' } };

      const issued = async () => {
        await harness.seed({
          messages: [
            ...Array.from({ length: 30 }, () => sourceMessage({ text: 'blorg horses' })),
            ...Array.from({ length: 30 }, () =>
              sourceMessage({ text: 'blorg horses', user: 'user-b' }),
            ),
          ],
          conversations: [visible(), visible('convo-a', { user: 'user-b' })],
        });
        const route = await routeFor();
        const first = (await route(contextFor(), 'blorg', null)) as Page;
        return { route, cursor: first.body.nextCursor as string };
      };

      it('is accepted for the same user and query', async () => {
        const { route, cursor } = await issued();
        const next = (await route(contextFor(), 'blorg', cursor)) as Page;
        expect(next.status).toBe(200);
        expect(next.body.messages).toHaveLength(5);
      });

      it('is rejected for another user', async () => {
        const { route, cursor } = await issued();
        expect(await route(contextFor('user-b'), 'blorg', cursor)).toEqual(INVALID);
      });

      it('is rejected for another query', async () => {
        const { route, cursor } = await issued();
        expect(await route(contextFor(), 'horses', cursor)).toEqual(INVALID);
        expect(await route(contextFor(), 'blorg horses', cursor)).toEqual(INVALID);
      });

      it('is rejected when tampered with', async () => {
        const { route, cursor } = await issued();
        const middle = Math.floor(cursor.length / 2);
        const swapped = cursor[middle] === 'A' ? 'B' : 'A';
        const tampered = cursor.slice(0, middle) + swapped + cursor.slice(middle + 1);

        expect(await route(contextFor(), 'blorg', tampered)).toEqual(INVALID);
        expect(await route(contextFor(), 'blorg', cursor.slice(0, -4))).toEqual(INVALID);
        expect(await route(contextFor(), 'blorg', `${cursor}AAAA`)).toEqual(INVALID);
      });

      it.each([
        ['a date, as Meilisearch paging sends', '2026-01-01T00:00:00.000Z'],
        ['plain text', 'not-a-cursor'],
        ['the prefix alone', 's1.'],
        ['a list', ['s1.x']],
        ['a number', 7],
      ])('is rejected when it is %s', async (_name, value) => {
        const { route } = await issued();
        expect(await route(contextFor(), 'blorg', value)).toEqual(INVALID);
      });

      it('emits the code as the outcome, and no cursor text', async () => {
        const { route, cursor } = await issued();
        harness.logged.length = 0;

        await route(contextFor('user-b'), 'blorg', cursor);

        const events = harness.logged.filter(({ event }) => event === 'search.request');
        expect(events.map(({ meta }) => (meta as { outcome: string }).outcome)).toEqual([
          'search_cursor_invalid',
        ]);
        expect(JSON.stringify(harness.logged)).not.toContain(cursor);
      });
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
