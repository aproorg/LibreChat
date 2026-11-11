import { createMethods, SearchError } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { SearchHarness } from '../__tests__/helpers/harness';
import type { SearchHttpResponse } from './errors';
import {
  createSearchHarness,
  searchConfig,
  sourceConversation,
  sourceMessage,
} from '../__tests__/helpers/harness';
import { createFakeDictionaryPack } from '../languages/__tests__/helpers/fakeDictionary';
import { createConversationSearch } from './conversations';
import { createSearchConfigSnapshot } from '../config';
import { createSearchMessagesRoute } from './messages';
import { createSearchService } from '../service';
import { searchErrorResponse } from './errors';
import { createShareSearch } from './shares';

const SENTINEL = 'SENTINEL_RAW_TEXT';

type Methods = SearchHarness['methods'];
type ReadName =
  | 'readVocabFrequencies'
  | 'readVocabRange'
  | 'readRecordWindow'
  | 'readRecordTokens'
  | 'readMessageTexts'
  | 'readConversationRecords'
  | 'getSearchableMessages'
  | 'getSearchHitConversations';

/** As the engine reports it: `read/retry.ts` recognises the code and the text together. */
const cursorLimit = () =>
  Object.assign(new Error(`Cannot open a new cursor ${SENTINEL}`), { code: 2 });
const timeLimit = () => Object.assign(new Error(`${SENTINEL} exceeded time limit`), { code: 50 });
const otherFailure = () => new Error(`${SENTINEL} connection reset`);

const BUSY = { status: 503, body: { code: 'search_busy' } };
const FAILED = { status: 500, body: { code: 'search_failed' } };

/** FR-018: every failure leaves as a stable code with its status, and no error text anywhere. */
describe('search failures at the HTTP boundary (FR-018)', () => {
  let harness: SearchHarness;

  const req = { user: { id: 'user-a' } } as unknown as Request;
  const res = { once: () => undefined, writableFinished: false } as unknown as Response;

  const contextFor = (signal = new AbortController().signal) => ({
    user: 'user-a',
    signal,
    startedAt: Date.now(),
  });

  /** The surfaces as the server binds them, over methods with `overrides` in place. */
  const build = async (
    overrides: Partial<Methods> = {},
    {
      search = {},
      packs = harness.packs,
      load = true,
    }: {
      search?: Parameters<typeof searchConfig>[0];
      packs?: SearchHarness['packs'];
      load?: boolean;
    } = {},
  ) => {
    const methods = { ...harness.methods, ...overrides };
    const service = createSearchService({
      config: createSearchConfigSnapshot({ search: searchConfig(search) }),
      methods,
      metrics: harness.metrics,
      logger: harness.logger,
      cursorSecret: 'secret',
      resolvePacks: () => ({ ok: true, packs }),
    });
    if (load) {
      await service.loadPacks();
    }
    const database = createMethods(harness.database, { getSearchPort: () => service });
    const messages = createSearchMessagesRoute({ service, methods, metrics: harness.metrics });
    const conversations = createConversationSearch({
      service,
      metrics: harness.metrics,
      logger: harness.logger,
    });
    const shares = createShareSearch({ service, metrics: harness.metrics, logger: harness.logger });

    return {
      /** `/search`. */
      page: (query: string, signal?: AbortSignal) => messages(contextFor(signal), query, null),
      /** The sidebar, with the route's own try and catch around the database method. */
      async sidebar(query: string): Promise<SearchHttpResponse | null> {
        const searchContext = conversations.context(req, res);
        try {
          const result = await database.getConvosByCursor('user-a', {
            search: query,
            searchContext,
          });
          conversations.completed(searchContext, result);
          return { status: 200, body: result };
        } catch (error) {
          return conversations.failure(searchContext, error);
        }
      },
      /** The shared links list, the same way. */
      async links(query: string): Promise<SearchHttpResponse | null> {
        const searchContext = shares.context(req, res);
        try {
          const result = await database.getSharedLinks(
            'user-a',
            undefined,
            10,
            'createdAt',
            'desc',
            query,
            searchContext,
          );
          shares.completed(searchContext, result);
          return { status: 200, body: result };
        } catch (error) {
          return shares.failure(searchContext, error);
        }
      },
    };
  };

  /** A read that always fails, counting its calls. */
  const failing = (name: ReadName, failure: () => Error) => {
    const read = jest.fn(async () => {
      throw failure();
    });
    return { read, overrides: { [name]: read } as Partial<Methods> };
  };

  const outcomes = (surface: string) =>
    harness.logged
      .filter(({ event }) => event === 'search.request')
      .map(({ meta }) => meta as { surface: string; outcome: string })
      .filter((meta) => meta.surface === surface)
      .map(({ outcome }) => outcome);

  /** Neither the answer nor anything logged may hold the failure's own text. */
  const expectNoRawText = (response: unknown) => {
    expect(JSON.stringify(response)).not.toContain(SENTINEL);
    expect(JSON.stringify(harness.logged)).not.toContain(SENTINEL);
  };

  beforeAll(async () => {
    harness = await createSearchHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    await harness.seed({
      messages: [sourceMessage({ text: 'grumtak vindra', messageId: 'hit' })],
      conversations: [
        sourceConversation({ conversationId: 'convo-a', title: 'grumtak' }),
        sourceConversation({ conversationId: 'by-title', title: 'grumtak too' }),
      ],
    });
    harness.logged.length = 0;
  });

  describe('searchErrorResponse', () => {
    it.each([
      ['search_busy', 503],
      ['search_failed', 500],
      ['search_cursor_invalid', 400],
    ] as const)('maps %s to %i, with the code alone', (code, status) => {
      expect(searchErrorResponse(new SearchError(code))).toEqual({ status, body: { code } });
    });

    it.each([
      ['an error', new Error(SENTINEL)],
      ['an engine error with a code', cursorLimit()],
      ['a look-alike', { name: 'SearchError', code: 'search_busy', message: SENTINEL }],
      ['a string', SENTINEL],
      ['nothing', undefined],
    ])('maps %s that is not a SearchError to search_failed, with no text', (_name, error) => {
      const response = searchErrorResponse(error);
      expect(response).toEqual(FAILED);
      expect(JSON.stringify(response)).not.toContain(SENTINEL);
    });
  });

  describe('/search', () => {
    it('answers busy when the cursor limit outlasts two retries', async () => {
      const { read, overrides } = failing('readRecordWindow', cursorLimit);
      const { page } = await build(overrides);

      const response = await page('grumtak');

      expect(response).toEqual(BUSY);
      expect(read).toHaveBeenCalledTimes(3);
      expect(
        harness.logged
          .filter(({ event }) => event === 'search.cursor_error')
          .map(({ meta }) => meta),
      ).toEqual([
        { surface: 'messages', retries: 0, final: false },
        { surface: 'messages', retries: 1, final: false },
        { surface: 'messages', retries: 2, final: true },
      ]);
      expect(outcomes('messages')).toEqual(['search_busy']);
      expectNoRawText(response);
    });

    it('recovers when the cursor limit clears within the retries', async () => {
      const real = harness.methods.readRecordWindow;
      let calls = 0;
      const { page } = await build({
        readRecordWindow: (params, options) => {
          calls += 1;
          return calls <= 2 ? Promise.reject(cursorLimit()) : real(params, options);
        },
      });

      const response = await page('grumtak');

      expect(response?.status).toBe(200);
      expect(
        (response?.body as { messages: Array<{ messageId: string }> }).messages.map(
          ({ messageId }) => messageId,
        ),
      ).toEqual(['hit']);
      expectNoRawText(response);
    });

    it('answers busy at the per-process cap, at once', async () => {
      const hang = jest.fn(() => new Promise<never>(() => undefined));
      const { page } = await build(
        { readVocabFrequencies: hang },
        { search: { maxConcurrentSearches: 1 } },
      );
      const leaving = new AbortController();
      const first = page('grumtak', leaving.signal);
      await new Promise((resolve) => setImmediate(resolve));

      const second = await page('vindra');

      expect(second).toEqual(BUSY);
      expect(hang).toHaveBeenCalledTimes(1);
      leaving.abort();
      expect(await first).toEqual(BUSY);
      expect(outcomes('messages')).toEqual(['search_busy', 'aborted']);
      expectNoRawText(second);
    });

    it('answers busy when the search runs out of time', async () => {
      const { page } = await build(
        { readRecordWindow: () => new Promise<never>(() => undefined) },
        { search: { searchTimeoutMs: 150 } },
      );

      const response = await page('grumtak');

      expect(response).toEqual(BUSY);
      expect(outcomes('messages')).toEqual(['search_busy']);
    });

    it('answers busy when the engine reports its time limit', async () => {
      const { read, overrides } = failing('readRecordWindow', timeLimit);
      const { page } = await build(overrides);

      const response = await page('grumtak');

      expect(response).toEqual(BUSY);
      expect(read).toHaveBeenCalledTimes(1);
      expectNoRawText(response);
    });

    it('answers failed for any other failure, and logs no text', async () => {
      const { read, overrides } = failing('readRecordWindow', otherFailure);
      const { page } = await build(overrides);

      const response = await page('grumtak');

      expect(response).toEqual(FAILED);
      expect(read).toHaveBeenCalledTimes(1);
      expect(harness.logged.map(({ event }) => event)).toContain('[search] Read failed');
      expect(outcomes('messages')).toEqual(['search_failed']);
      expectNoRawText(response);
    });
  });

  describe('each read kind', () => {
    const kinds: Array<[string, ReadName, string]> = [
      ['document frequencies', 'readVocabFrequencies', 'grumtak'],
      ['the word list range', 'readVocabRange', 'grumtak'],
      ['a window', 'readRecordWindow', 'grumtak'],
      ['record tokens', 'readRecordTokens', 'grumtak vindra'],
      ['message texts', 'readMessageTexts', 'grumtak vindra'],
      ['message hydration', 'getSearchableMessages', 'grumtak'],
      ['conversation hydration', 'getSearchHitConversations', 'grumtak'],
    ];

    it.each(kinds)('answers busy for a cursor limit on %s', async (_name, method, query) => {
      const { read, overrides } = failing(method, cursorLimit);
      const { page } = await build(overrides);

      const response = await page(query);

      expect(response).toEqual(BUSY);
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(3);
      expectNoRawText(response);
    });

    it.each(kinds)('answers busy for a timeout on %s', async (_name, method, query) => {
      const { read, overrides } = failing(method, timeLimit);
      const { page } = await build(overrides);

      const response = await page(query);

      expect(response).toEqual(BUSY);
      expect(read).toHaveBeenCalled();
      expectNoRawText(response);
    });

    it.each(kinds)('answers failed for another failure on %s', async (_name, method, query) => {
      const { read, overrides } = failing(method, otherFailure);
      const { page } = await build(overrides);

      const response = await page(query);

      expect(response).toEqual(FAILED);
      expect(read).toHaveBeenCalled();
      expectNoRawText(response);
    });

    it.each([
      ['a cursor limit', cursorLimit],
      ['a timeout', timeLimit],
    ])('answers busy for %s on the title read, on both title surfaces', async (_name, failure) => {
      const { read, overrides } = failing('readConversationRecords', failure);
      const { sidebar, links } = await build(overrides);

      const fromSidebar = await sidebar('grumtak');
      const fromLinks = await links('grumtak');

      expect(fromSidebar).toEqual(BUSY);
      expect(fromLinks).toEqual(BUSY);
      expect(read).toHaveBeenCalled();
      expectNoRawText([fromSidebar, fromLinks]);
    });
  });

  describe('the sidebar', () => {
    it.each([
      ['fails', otherFailure, 'search_failed'],
      ['meets the cursor limit', cursorLimit, 'search_busy'],
      ['times out', timeLimit, 'search_busy'],
    ])(
      'answers 200 with title matches and partial when the message read %s',
      async (_name, failure, code) => {
        const { read, overrides } = failing('readRecordWindow', failure);
        const { sidebar } = await build(overrides);

        const response = await sidebar('grumtak');

        expect(read).toHaveBeenCalled();
        expect(response?.status).toBe(200);
        const body = response?.body as {
          conversations: Array<{ conversationId: string }>;
          partial?: boolean;
        };
        expect(body.partial).toBe(true);
        expect(body.conversations.map(({ conversationId }) => conversationId).sort()).toEqual([
          'by-title',
          'convo-a',
        ]);
        expect(
          harness.logged.filter(({ event }) => event === 'search.partial').map(({ meta }) => meta),
        ).toEqual([{ surface: 'conversations', code }]);
        expect(outcomes('conversations')).toEqual(['partial']);
        expectNoRawText(response);
      },
    );

    it('answers busy when the title read is busy, with no partial', async () => {
      const { overrides } = failing('readConversationRecords', timeLimit);
      const { sidebar } = await build(overrides);

      const response = await sidebar('grumtak');

      expect(response).toEqual(BUSY);
      expect(harness.logged.filter(({ event }) => event === 'search.partial')).toEqual([]);
      expect(outcomes('conversations')).toEqual(['search_busy']);
      expectNoRawText(response);
    });

    it('answers failed when the title read fails, discarding the message hits', async () => {
      const window = jest.spyOn(harness.methods, 'readRecordWindow');
      const { overrides } = failing('readConversationRecords', otherFailure);
      const { sidebar } = await build(overrides);

      const response = await sidebar('grumtak');

      expect(response).toEqual(FAILED);
      /* The message read ran and found its hit; none of it is in the answer. */
      expect(window).toHaveBeenCalled();
      expect(JSON.stringify(response)).not.toContain('convo-a');
      expect(outcomes('conversations')).toEqual(['search_failed']);
      expectNoRawText(response);
    });

    it('answers failed when the conversation list read fails after the search', async () => {
      const { sidebar } = await build();
      jest.spyOn(harness.models.Conversation, 'find').mockImplementation(() => {
        throw otherFailure();
      });

      const response = await sidebar('grumtak');

      expect(response).toEqual(FAILED);
      expect(outcomes('conversations')).toEqual(['search_failed']);
      expectNoRawText(response);
    });
  });

  describe('shared links', () => {
    it('answers busy when the title read is busy', async () => {
      const { overrides } = failing('readConversationRecords', cursorLimit);
      const { links } = await build(overrides);

      const response = await links('grumtak');

      expect(response).toEqual(BUSY);
      expect(outcomes('shares')).toEqual(['search_busy']);
      expectNoRawText(response);
    });

    it('answers failed when the title read fails otherwise, never an empty list', async () => {
      const { overrides } = failing('readConversationRecords', otherFailure);
      const { links } = await build(overrides);

      const response = await links('grumtak');

      expect(response).toEqual(FAILED);
      expect(outcomes('shares')).toEqual(['search_failed']);
      expectNoRawText(response);
    });

    it('answers failed when the title word list read fails', async () => {
      const { overrides } = failing('readVocabFrequencies', otherFailure);
      const { links } = await build(overrides);

      expect(await links('grumtak')).toEqual(FAILED);
    });

    it('answers failed when the link read fails after the search', async () => {
      const { links } = await build();
      jest.spyOn(harness.models.SharedLink, 'find').mockImplementation(() => {
        throw otherFailure();
      });

      const response = await links('grumtak');

      expect(response).toEqual(FAILED);
      expect(outcomes('shares')).toEqual(['search_failed']);
      expectNoRawText(response);
    });
  });

  describe('language packs', () => {
    it('answers failed on every surface when a pack failed to load', async () => {
      const { page, sidebar, links } = await build(
        {},
        { packs: [createFakeDictionaryPack({ failLoad: true })] },
      );

      const responses = [await page('grumtak'), await sidebar('grumtak'), await links('grumtak')];

      expect(responses).toEqual([FAILED, FAILED, FAILED]);
      expectNoRawText(responses);
    });

    it('answers busy on every surface while packs are loading', async () => {
      const { page, sidebar, links } = await build({}, { load: false });

      const responses = [await page('grumtak'), await sidebar('grumtak'), await links('grumtak')];

      expect(responses).toEqual([BUSY, BUSY, BUSY]);
    });

    it('answers failed on every surface when a pack throws on a word', async () => {
      const [fake, en] = harness.packs;
      const throwing = {
        ...fake,
        lemmas: () => {
          throw new Error(SENTINEL);
        },
      };
      const { page, sidebar, links } = await build({}, { packs: [throwing, en] });

      const responses = [await page('grumtak'), await sidebar('grumtak'), await links('grumtak')];

      expect(responses).toEqual([FAILED, FAILED, FAILED]);
      expectNoRawText(responses);
    });
  });
});
