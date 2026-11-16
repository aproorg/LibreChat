const { inspect } = require('util');
const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { SEARCH_CURSOR_HEADER } = require('librechat-data-provider');
const { bindSearch, startSearchBackground } = require('@librechat/api');
const { logger, loadSearchConfig, SearchError } = require('@librechat/data-schemas');

jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());
jest.mock('~/server/middleware/optionalJwtAuth', () => (req, res, next) => next());
jest.mock('~/server/middleware/optionalShareFileAuth', () => (req, res, next) => next());
jest.mock('~/server/middleware/canAccessSharedLink', () => (req, res, next) => next());
jest.mock('~/server/middleware/config/app', () => (req, res, next) => next());
jest.mock('~/server/middleware/roles/capabilities', () => ({
  getHeldCapabilities: jest.fn().mockResolvedValue(new Set()),
  hasCapability: jest.fn().mockResolvedValue(false),
  hasConfigCapability: jest.fn().mockResolvedValue(false),
}));
jest.mock('~/server/middleware/limiters', () => {
  const pass = (req, res, next) => next();
  return {
    createForkLimiters: () => ({ forkIpLimiter: pass, forkUserLimiter: pass }),
    createShareLimiters: () => ({ shareIpLimiter: pass, shareUserLimiter: pass }),
  };
});
jest.mock('~/server/services/Config/app', () => ({
  getAppConfig: jest.fn().mockResolvedValue({}),
}));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
jest.mock('~/server/utils/import/fork', () => ({ forkSharedConversation: jest.fn() }));
jest.mock('~/server/middleware', () => {
  const pass = jest.fn((req, res, next) => next());
  return {
    requireJwtAuth: (req, res, next) => next(),
    validateMessageReq: pass,
    configMiddleware: pass,
    sendValidationResponse: jest.fn(),
    canReadActiveJobConversation: jest.fn().mockResolvedValue(false),
    prepareMessageRequestValidation: pass,
    createImportLimiters: () => ({ importIpLimiter: pass, importUserLimiter: pass }),
    createForkLimiters: () => ({ forkIpLimiter: pass, forkUserLimiter: pass }),
    validateConvoAccess: pass,
    messageIpLimiter: pass,
    messageUserLimiter: pass,
    moderateText: pass,
  };
});

/**
 * FR-018 through the real routes, the real database methods and the real service: a
 * search failure leaves as a stable code with its status, through each catch on its way,
 * and the default backend answers exactly as it does today. Failures are injected by
 * wrapping the database methods handed to the service. The pack is inline for the reason
 * `search-routes.spec.js` gives.
 */
const USER = 'route-user';
const VERSION = 'route-test';
const SENTINEL = 'SENTINEL_RAW_TEXT';
const BUSY = { code: 'search_busy' };
const FAILED = { code: 'search_failed' };
const inlinePack = {
  id: 'inline',
  version: '1',
  kind: 'dictionary',
  stopWords: new Set(['the']),
  knows: (word) => word === 'horse' || word === 'horses',
  lemmas: (word) => (word === 'horses' ? ['horse'] : []),
};

/** As the engine reports them: `read/retry.ts` recognises the code, and for a cursor the text. */
const cursorLimit = () =>
  Object.assign(new Error(`Cannot open a new cursor ${SENTINEL}`), { code: 2 });
const timeLimit = () => Object.assign(new Error(`${SENTINEL} exceeded time limit`), { code: 50 });
const otherFailure = () => new Error(`${SENTINEL} connection reset`);
const failingWith = (failure) =>
  jest.fn(async () => {
    throw failure();
  });

describe('search failures through the real routes', () => {
  let server;
  let db;
  let routes;
  let meili;
  let logs;
  const bound = [];

  const appFor = (binding) => {
    db.setSearchPort(binding?.service ?? null);
    const app = express();
    app.use((req, res, next) => {
      req.user = { id: USER };
      next();
    });
    if (binding) {
      app.locals.search = binding;
    }
    app.use('/api/messages', routes.messages);
    app.use('/api/convos', routes.convos);
    app.use('/api/share', routes.share);
    return app;
  };

  /** A binding over the real methods, with `overrides` standing in for the reads that fail. */
  const bind = async (searchConfig, overrides = {}) => {
    const binding = bindSearch({
      app: { locals: {} },
      appConfig: searchConfig ? { search: loadSearchConfig({ search: searchConfig }) } : {},
      methods: { ...db, ...overrides },
      setSearchPort: db.setSearchPort,
      jwtSecret: 'test',
      logger,
      ...(searchConfig?.languages?.[0] === inlinePack.id
        ? { resolvePacks: () => ({ ok: true, packs: [inlinePack] }) }
        : {}),
    });
    await startSearchBackground(binding);
    bound.push(binding);
    return binding;
  };

  const searching = (overrides) =>
    bind({ data: true, backend: 'search', languages: [inlinePack.id] }, overrides);

  /** Neither the response nor anything logged may hold the failure's own text. */
  const expectNoRawText = (response) => {
    expect(response.text).not.toContain(SENTINEL);
    for (const log of logs) {
      expect(inspect(log.mock.calls, { depth: 8 })).not.toContain(SENTINEL);
    }
  };

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    require('~/db/models');
    db = require('~/models');
    routes = {
      messages: require('../messages'),
      convos: require('../convos'),
      share: require('../share'),
    };

    const { Message, Conversation } = mongoose.models;
    meili = jest.fn();
    Message.meiliSearch = meili;
    Conversation.meiliSearch = meili;

    await db.ensureSearchCollections();
    await db.ensureSearchIndexes();
    const at = new Date('2026-01-01');
    const source = {
      _id: new mongoose.Types.ObjectId(),
      user: USER,
      conversationId: 'by-message',
      messageId: 'horses',
      text: 'The horses ran',
      isCreatedByUser: true,
      createdAt: at,
      updatedAt: at,
    };
    await mongoose.connection.db.collection('messages').insertOne(source);
    await mongoose.connection.db.collection('conversations').insertMany(
      ['by-message', 'by-title', 'unmatched'].map((conversationId) => ({
        _id: new mongoose.Types.ObjectId(),
        user: USER,
        conversationId,
        title: conversationId === 'by-title' ? 'Horses and more' : 'Something else',
        model: 'a-model',
        createdAt: at,
        updatedAt: at,
      })),
    );
    await mongoose.connection.db.collection('sharedlinks').insertMany(
      ['by-title', 'unmatched'].map((conversationId) => ({
        _id: new mongoose.Types.ObjectId(),
        user: USER,
        conversationId,
        shareId: `share-${conversationId}`,
        title: `Link ${conversationId}`,
        createdAt: at,
        updatedAt: at,
      })),
    );

    const tokens = ['horses', 'horse', 'ran'];
    const record = { h: 'h', v: VERSION, e: 0, tokens };
    await mongoose.connection.db.collection('msearch').insertOne({
      ...record,
      _id: source._id,
      user: USER,
      conversationId: source.conversationId,
      messageId: source.messageId,
      createdAt: at,
      n: tokens.length,
    });
    await mongoose.connection.db.collection('csearch').insertOne({
      ...record,
      _id: new mongoose.Types.ObjectId(),
      user: USER,
      conversationId: 'by-title',
    });
    await mongoose.connection.db
      .collection('search_vocab')
      .insertMany(tokens.map((token) => ({ _id: token, df: 3 })));
  });

  afterAll(async () => {
    await Promise.all(bound.map((binding) => binding.stopBackground()));
    db.setSearchPort(null);
    await mongoose.disconnect();
    await server.stop();
  });

  beforeEach(() => {
    meili.mockReset();
    meili.mockResolvedValue({ hits: [{ conversationId: 'by-title', messageId: 'horses' }] });
    logs = ['info', 'warn', 'error', 'debug'].map((level) =>
      jest.spyOn(logger, level).mockImplementation(() => logger),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('backend: search', () => {
    describe('GET /api/convos?search=', () => {
      it('answers with the matches, as the control', async () => {
        const response = await request(appFor(await searching()))
          .get('/api/convos')
          .query({ search: 'horse' });

        expect(response.status).toBe(200);
        expect(
          response.body.conversations.map(({ conversationId }) => conversationId).sort(),
        ).toEqual(['by-message', 'by-title']);
        expect(response.body).not.toHaveProperty('partial');
      });

      it.each([
        ['a cursor limit past its retries', cursorLimit, 503, BUSY],
        ['a timeout', timeLimit, 503, BUSY],
        ['any other failure', otherFailure, 500, FAILED],
      ])(
        'maps %s on the title read to its code, through the search catch in getConvosByCursor',
        async (_name, failure, status, body) => {
          const readConversationRecords = failingWith(failure);
          const response = await request(appFor(await searching({ readConversationRecords })))
            .get('/api/convos')
            .query({ search: 'horse' });

          expect(readConversationRecords).toHaveBeenCalled();
          expect(response.status).toBe(status);
          expect(response.body).toEqual(body);
          expectNoRawText(response);
          expect(meili).not.toHaveBeenCalled();
        },
      );

      it('answers 200 with title matches and partial when the message read fails', async () => {
        const readRecordWindow = failingWith(otherFailure);
        const response = await request(appFor(await searching({ readRecordWindow })))
          .get('/api/convos')
          .query({ search: 'horse' });

        expect(readRecordWindow).toHaveBeenCalled();
        expect(response.status).toBe(200);
        expect(response.body.partial).toBe(true);
        expect(response.body.conversations.map(({ conversationId }) => conversationId)).toEqual([
          'by-title',
        ]);
        expectNoRawText(response);
      });

      it('maps a failure of the conversation list read after the search to a code', async () => {
        const app = appFor(await searching());
        jest.spyOn(mongoose.models.Conversation, 'find').mockImplementation(() => {
          throw otherFailure();
        });

        const response = await request(app).get('/api/convos').query({ search: 'horse' });

        expect(response.status).toBe(500);
        expect(response.body).toEqual(FAILED);
        expect(response.text).not.toContain(SENTINEL);
      });

      it('answers failed when a pack failed to load', async () => {
        const failed = await bind({ data: true, backend: 'search', languages: ['nope'] });

        const response = await request(appFor(failed))
          .get('/api/convos')
          .query({ search: 'horse' });

        expect(response.status).toBe(500);
        expect(response.body).toEqual(FAILED);
      });
    });

    describe('GET /api/share?search=', () => {
      it('lists the links whose conversation title matches, with no new field', async () => {
        const response = await request(appFor(await searching()))
          .get('/api/share')
          .query({ search: 'horse' });

        expect(response.status).toBe(200);
        expect(response.body.links.map(({ shareId }) => shareId)).toEqual(['share-by-title']);
        expect(Object.keys(response.body).sort()).toEqual(['hasNextPage', 'links']);
        expect(meili).not.toHaveBeenCalled();
      });

      it('answers the stop-word reason with an empty list', async () => {
        const response = await request(appFor(await searching()))
          .get('/api/share')
          .query({ search: 'the' });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ links: [], hasNextPage: false, reason: 'only_stop_words' });
      });

      it('answers the ordinary empty list for a query with no usable word', async () => {
        const response = await request(appFor(await searching()))
          .get('/api/share')
          .query({ search: '???' });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ links: [], hasNextPage: false });
      });

      it.each([
        ['a cursor limit past its retries', cursorLimit, 503, BUSY],
        ['a timeout', timeLimit, 503, BUSY],
        ['any other failure', otherFailure, 500, FAILED],
      ])(
        'maps %s on the title read to its code, through both catches in getSharedLinks',
        async (_name, failure, status, body) => {
          const readConversationRecords = failingWith(failure);
          const response = await request(appFor(await searching({ readConversationRecords })))
            .get('/api/share')
            .query({ search: 'horse' });

          expect(readConversationRecords).toHaveBeenCalled();
          expect(response.status).toBe(status);
          /* Not the empty list of the inner catch, nor the `{ message }` of the outer one. */
          expect(response.body).toEqual(body);
          expectNoRawText(response);
          expect(meili).not.toHaveBeenCalled();
        },
      );

      it('maps a SearchError raised after the search, through the outer catch alone', async () => {
        const app = appFor(await searching());
        jest.spyOn(mongoose.models.SharedLink, 'find').mockImplementation(() => {
          throw new SearchError('search_busy');
        });

        const response = await request(app).get('/api/share').query({ search: 'horse' });

        expect(response.status).toBe(503);
        expect(response.body).toEqual(BUSY);
      });

      it('maps a failure of the link read after the search to a code', async () => {
        const app = appFor(await searching());
        jest.spyOn(mongoose.models.SharedLink, 'find').mockImplementation(() => {
          throw otherFailure();
        });

        const response = await request(app).get('/api/share').query({ search: 'horse' });

        expect(response.status).toBe(500);
        expect(response.body).toEqual(FAILED);
        expect(response.text).not.toContain(SENTINEL);
      });

      it('answers failed when a pack failed to load', async () => {
        const failed = await bind({ data: true, backend: 'search', languages: ['nope'] });

        const response = await request(appFor(failed)).get('/api/share').query({ search: 'horse' });

        expect(response.status).toBe(500);
        expect(response.body).toEqual(FAILED);
      });

      it('keeps today’s 500 for a list with no search', async () => {
        const app = appFor(await searching());
        jest.spyOn(mongoose.models.SharedLink, 'find').mockImplementation(() => {
          throw otherFailure();
        });

        const response = await request(app).get('/api/share');

        expect(response.status).toBe(500);
        expect(response.body).toEqual({ message: 'Error getting shared links' });
      });
    });
  });

  describe('default backend (FR-041)', () => {
    const bindings = [
      ['no binding', () => undefined],
      ['a default binding', () => bind()],
      ['backend: meilisearch with data on', () => bind({ data: true, backend: 'meilisearch' })],
    ];

    describe.each(bindings)('GET /api/share?search= with %s', (_name, makeBinding) => {
      it('answers today’s body, byte for byte', async () => {
        const response = await request(appFor(await makeBinding()))
          .get('/api/share')
          .query({ search: 'horse' });

        expect(response.status).toBe(200);
        expect(JSON.parse(response.text)).toEqual({
          links: [
            {
              shareId: 'share-by-title',
              title: 'Link by-title',
              createdAt: '2026-01-01T00:00:00.000Z',
              conversationId: 'by-title',
            },
          ],
          hasNextPage: false,
        });
        expect(response.text).toBe(
          '{"links":[{"shareId":"share-by-title","title":"Link by-title",' +
            '"createdAt":"2026-01-01T00:00:00.000Z","conversationId":"by-title"}],' +
            '"hasNextPage":false}',
        );
        expect(meili).toHaveBeenCalledTimes(1);
      });

      it('answers today’s empty 200 on a Meilisearch error', async () => {
        meili.mockRejectedValue(otherFailure());

        const response = await request(appFor(await makeBinding()))
          .get('/api/share')
          .query({ search: 'horse' });

        expect(response.status).toBe(200);
        expect(response.text).toBe('{"links":[],"hasNextPage":false}');
      });

      it.each([
        ['a failure of the link read', otherFailure],
        ['a SearchError, which no search here can raise', () => new SearchError('search_busy')],
      ])('answers today’s { message } 500 for %s', async (_case, failure) => {
        const app = appFor(await makeBinding());
        jest.spyOn(mongoose.models.SharedLink, 'find').mockImplementation(() => {
          throw failure();
        });

        const response = await request(app).get('/api/share').query({ search: 'horse' });

        expect(response.status).toBe(500);
        expect(response.text).toBe('{"message":"Error getting shared links"}');
      });
    });

    describe('a cursor on GET /api/messages?search= (T091)', () => {
      /** `via: 'header'` sends the cursor as today's client does; `'query'` as an older one. */
      const served = async (binding, cursor, via = 'query') => {
        meili.mockClear();
        const inQuery = via === 'query' && cursor !== undefined;
        const req = request(appFor(binding))
          .get('/api/messages')
          .query({ search: 'horse', ...(inQuery ? { cursor } : {}) });
        if (via === 'header' && cursor !== undefined) {
          req.set(SEARCH_CURSOR_HEADER, cursor);
        }
        const response = await req;
        return { status: response.status, text: response.text, searched: meili.mock.calls.length };
      };

      it.each(bindings.slice(1))(
        'rejects a new-search cursor with %s, before Meilisearch is asked',
        async (_name, makeBinding) => {
          const binding = await makeBinding();

          for (const via of ['header', 'query']) {
            for (const cursor of ['s1.', 's1.anything', `s1.${'A'.repeat(400)}`]) {
              const { status, text, searched } = await served(binding, cursor, via);
              expect(status).toBe(400);
              expect(text).toBe('{"code":"search_cursor_invalid"}');
              expect(searched).toBe(0);
            }
          }
        },
      );

      it.each(bindings.slice(1))(
        'leaves any other cursor to today’s code with %s',
        async (_name, makeBinding) => {
          const binding = await makeBinding();
          const cursors = [undefined, '', '2026-01-01T00:00:00.000Z', 'not-a-cursor', 's1', 'S1.x'];

          for (const via of ['header', 'query']) {
            for (const cursor of cursors) {
              const today = await served(undefined, cursor, via);
              const bound = await served(binding, cursor, via);
              expect(bound).toEqual(today);
              expect(bound.searched).toBe(1);
            }
          }
        },
      );
    });
  });
});
