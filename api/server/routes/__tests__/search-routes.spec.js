const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { bindSearch, startSearchBackground } = require('@librechat/api');
const { logger, loadSearchConfig } = require('@librechat/data-schemas');

jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());
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
 * The real routes and the real service over a real database: public CI's end-to-end
 * proof of `backend: search`, and of the default leaving the routes alone. The pack is
 * inline because Jest here cannot run the built package's `import()` without a Node flag;
 * `search-checkpoint.spec.js` runs the real packs under that flag.
 */
const USER = 'route-user';
const OTHER = 'other-user';
const VERSION = 'route-test';
const inlinePack = {
  id: 'inline',
  version: '1',
  kind: 'dictionary',
  stopWords: new Set(['the']),
  knows: (word) => word === 'horse' || word === 'horses',
  lemmas: (word) => (word === 'horses' ? ['horse'] : []),
};

describe('search through the real routes', () => {
  let server;
  let db;
  let messagesRoute;
  let convosRoute;
  let meili;

  const appFor = (user = USER, search) => {
    const app = express();
    app.use((req, res, next) => {
      req.user = { id: user };
      next();
    });
    if (search) {
      app.locals.search = search;
    }
    app.use('/api/messages', messagesRoute);
    app.use('/api/convos', convosRoute);
    return app;
  };

  const bind = async (searchConfig) => {
    const app = { locals: {} };
    const binding = bindSearch({
      app,
      appConfig: searchConfig ? { search: loadSearchConfig({ search: searchConfig }) } : {},
      methods: db,
      setSearchPort: db.setSearchPort,
      jwtSecret: 'test',
      logger,
      ...(searchConfig?.languages?.[0] === inlinePack.id
        ? { resolvePacks: () => ({ ok: true, packs: [inlinePack] }) }
        : {}),
    });
    await startSearchBackground(binding);
    return binding;
  };

  const message = (fields) => ({
    _id: new mongoose.Types.ObjectId(),
    user: USER,
    conversationId: 'convo-a',
    isCreatedByUser: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...fields,
  });
  const convo = (fields) => ({
    _id: new mongoose.Types.ObjectId(),
    user: USER,
    conversationId: 'convo-a',
    title: 'Something else',
    model: 'a-model',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...fields,
  });

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    require('~/db/models');
    db = require('~/models');
    messagesRoute = require('../messages');
    convosRoute = require('../convos');

    const { Message, Conversation } = mongoose.models;
    meili = jest.fn().mockResolvedValue({ hits: [] });
    Message.meiliSearch = meili;
    Conversation.meiliSearch = meili;

    await db.ensureSearchCollections();
    await db.ensureSearchIndexes();
    const sources = [
      message({ messageId: 'horses', text: 'The horses ran', updatedAt: new Date('2026-02-01') }),
      message({
        messageId: 'private',
        text: 'horses private',
        contextMeta: { secret: 'PRIVATE_SENTINEL' },
      }),
      message({
        messageId: 'theirs',
        user: OTHER,
        conversationId: 'convo-b',
        text: 'horses of OTHERSENTINEL',
      }),
      message({ messageId: 'stale', text: 'horses gone temporary', isTemporary: true }),
    ];
    await mongoose.connection.db.collection('messages').insertMany(sources);
    await mongoose.connection.db.collection('conversations').insertMany([
      convo({ updatedAt: new Date('2026-02-01') }),
      convo({
        conversationId: 'by-title',
        title: 'Horses and more',
        updatedAt: new Date('2026-03-01'),
      }),
      convo({ conversationId: 'convo-b', user: OTHER, title: 'OTHERSENTINEL horse' }),
      convo({
        conversationId: 'unmatched',
        title: 'Unrelated',
        updatedAt: new Date('2026-04-01'),
      }),
    ]);

    /* The stale record is written directly: `buildMessageRecord` would refuse its source. */
    const tokens = ['horses', 'horse', 'ran'];
    const record = (source) => ({
      _id: source._id,
      user: source.user,
      conversationId: source.conversationId,
      messageId: source.messageId,
      createdAt: source.createdAt,
      n: tokens.length,
      h: 'h',
      v: VERSION,
      e: 0,
      tokens,
    });
    await mongoose.connection.db.collection('msearch').insertMany(sources.map(record));
    await mongoose.connection.db.collection('csearch').insertMany([
      {
        _id: new mongoose.Types.ObjectId(),
        user: USER,
        conversationId: 'by-title',
        h: 'h',
        v: VERSION,
        e: 0,
        tokens,
      },
      {
        _id: new mongoose.Types.ObjectId(),
        user: OTHER,
        conversationId: 'convo-b',
        h: 'h',
        v: VERSION,
        e: 0,
        tokens,
      },
    ]);
    await mongoose.connection.db
      .collection('search_vocab')
      .insertMany(tokens.map((token) => ({ _id: token, df: 3 })));
  });

  afterAll(async () => {
    db.setSearchPort(null);
    await mongoose.disconnect();
    await server.stop();
  });

  describe('backend: search', () => {
    let binding;

    beforeAll(async () => {
      binding = await bind({ data: true, backend: 'search', languages: [inlinePack.id] });
    });

    it('finds an inflected word on /search, and only what the user may see', async () => {
      const response = await request(appFor(USER, binding))
        .get('/api/messages')
        .query({ search: 'horse', pageSize: 1 });

      expect(response.status).toBe(200);
      const messages = response.body.messages;
      expect(messages.map(({ messageId }) => messageId).sort()).toEqual(['horses', 'private']);
      expect(response.body.nextCursor).toBeNull();
      expect(messages[0]).toMatchObject({ title: 'Something else', model: 'a-model' });
      const body = JSON.stringify(response.body);
      for (const forbidden of ['OTHERSENTINEL', 'PRIVATE_SENTINEL', 'gone temporary', 'tokens']) {
        expect(body).not.toContain(forbidden);
      }
      expect(meili).not.toHaveBeenCalled();
    });

    it('never takes the user from the request', async () => {
      const response = await request(appFor(USER, binding))
        .get('/api/messages')
        .query({ search: 'horse', user: OTHER });
      expect(response.status).toBe(200);
      expect(response.body.messages.length).toBeGreaterThan(0);
      expect(JSON.stringify(response.body)).not.toContain('OTHERSENTINEL');
    });

    it('shows the union on the sidebar, by last update', async () => {
      const response = await request(appFor(USER, binding))
        .get('/api/convos')
        .query({ search: 'horse' });

      expect(response.status).toBe(200);
      expect(response.body.conversations.map(({ conversationId }) => conversationId)).toEqual([
        'by-title',
        'convo-a',
      ]);
      expect(response.body).not.toHaveProperty('partial');
      expect(meili).not.toHaveBeenCalled();
    });

    it('gives the other user only their own', async () => {
      const response = await request(appFor(OTHER, binding))
        .get('/api/messages')
        .query({ search: 'horse' });
      expect(response.body.messages.map(({ messageId }) => messageId)).toEqual(['theirs']);
    });

    it('answers the stop-word reason on both surfaces', async () => {
      const messages = await request(appFor(USER, binding))
        .get('/api/messages')
        .query({ search: 'the' });
      expect(messages.body).toEqual({ messages: [], nextCursor: null, reason: 'only_stop_words' });

      const convos = await request(appFor(USER, binding))
        .get('/api/convos')
        .query({ search: 'the' });
      expect(convos.body).toEqual({
        conversations: [],
        nextCursor: null,
        reason: 'only_stop_words',
      });
    });

    it('maps a failure to its code on both surfaces, with no raw text', async () => {
      const failed = await bind({ data: true, backend: 'search', languages: ['nope'] });

      const messages = await request(appFor(USER, failed))
        .get('/api/messages')
        .query({ search: 'horse' });
      expect(messages.status).toBe(500);
      expect(messages.body).toEqual({ code: 'search_failed' });

      const convos = await request(appFor(USER, failed))
        .get('/api/convos')
        .query({ search: 'horse' });
      expect(convos.status).toBe(500);
      expect(convos.body).toEqual({ code: 'search_failed' });

      db.setSearchPort(binding.service);
    });

    it('rejects a cursor it did not issue', async () => {
      const response = await request(appFor(USER, binding))
        .get('/api/messages')
        .query({ search: 'horse', cursor: 's1.forged' });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ code: 'search_cursor_invalid' });
    });
  });

  describe('default configuration (FR-041)', () => {
    it.each([
      ['no binding', () => undefined],
      ['a default binding', () => bind()],
    ])('runs today’s code with %s, and no response gains a field', async (_name, makeBinding) => {
      const binding = await makeBinding();
      db.setSearchPort(binding?.service ?? null);
      const app = appFor(USER, binding);
      meili.mockClear();
      meili.mockResolvedValue({ hits: [{ messageId: 'horses', conversationId: 'convo-a' }] });

      const messages = await request(app).get('/api/messages').query({ search: 'horse' });
      expect(messages.status).toBe(200);
      expect(Object.keys(messages.body).sort()).toEqual(['messages', 'nextCursor']);
      expect(meili).toHaveBeenCalled();

      meili.mockClear();
      const convos = await request(app).get('/api/convos').query({ search: 'horse' });
      expect(convos.status).toBe(200);
      expect(Object.keys(convos.body).sort()).toEqual(['conversations', 'nextCursor']);
      expect(meili).toHaveBeenCalled();
    });
  });
});
