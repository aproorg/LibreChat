const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  bindSearch,
  createAnalyzer,
  computeAnalyzerVersion,
  resolveSearchPacks,
  startSearchBackground,
} = require('@librechat/api');
const { logger, loadSearchConfig } = require('@librechat/data-schemas');
const { loadSearchRecords } = require(
  path.resolve(__dirname, '../../../../packages/api/src/search/__tests__/helpers/loader.ts'),
);

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
 * Phase 4's checkpoint: the real routes, service and `is` and `en` packs over a database
 * loaded with T049's loader. It needs the private language data and a Node flag, so it
 * skips in public CI:
 *
 *   SEARCH_LANGUAGE_DATA_DIR=<dir> NODE_OPTIONS=--experimental-vm-modules \
 *     npx jest server/routes/__tests__/search-checkpoint
 */
const languageDataDir = process.env.SEARCH_LANGUAGE_DATA_DIR;
const describeCheckpoint = languageDataDir ? describe : describe.skip;

const USER = 'checkpoint-user';
const OTHER = 'checkpoint-other';
const OTHER_SENTINEL = 'annarnotandi';

describeCheckpoint('Phase 4 checkpoint', () => {
  let server;
  let db;
  let app;
  let otherApp;
  let binding;

  const id = () => new mongoose.Types.ObjectId();
  const message = (messageId, text, fields = {}) => ({
    _id: id(),
    user: USER,
    conversationId: 'convo-main',
    messageId,
    text,
    isCreatedByUser: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...fields,
  });
  const convo = (conversationId, title, fields = {}) => ({
    _id: id(),
    user: USER,
    conversationId,
    title,
    model: 'a-model',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...fields,
  });

  const appFor = (user) => {
    const created = express();
    created.use((req, res, next) => {
      req.user = { id: user };
      next();
    });
    created.locals.search = binding;
    created.use('/api/messages', require('../messages'));
    created.use('/api/convos', require('../convos'));
    return created;
  };

  const search = async (query, on = app) => {
    const response = await request(on).get('/api/messages').query({ search: query });
    expect(response.status).toBe(200);
    return response.body.messages;
  };
  const ids = (messages) => messages.map(({ messageId }) => messageId);

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    require('~/db/models');
    db = require('~/models');
    await db.ensureSearchCollections();
    await db.ensureSearchIndexes();

    const sources = [
      message('m-hestinum', 'Hann gaf hestinum hey í gær'),
      message('m-tekjuskattur', 'Reikna þarf tekjuskattur af laununum'),
      message('m-bornum', 'Við lásum bók fyrir börnum í skólanum'),
      message('m-thjonustuver', 'Hringdu í þjónustuver bankans'),
      message('m-ver', 'Hann fór í ver við ströndina'),
      message('m-fyrirtaeki', 'Þetta fyrirtæki er gamalt'),
      message('m-skattur', 'Skattur er hár', { createdAt: new Date('2025-01-01') }),
      message('m-other', `hestinum tekjuskattur börnum ${OTHER_SENTINEL}`, {
        user: OTHER,
        conversationId: 'convo-other',
      }),
    ];
    const conversations = [
      convo('convo-main', 'Ýmislegt'),
      convo('convo-title', 'Um hesta', { updatedAt: new Date('2026-03-01') }),
      convo('convo-other', `Hestar ${OTHER_SENTINEL}`, { user: OTHER }),
    ];
    await mongoose.connection.db.collection('messages').insertMany(sources);
    await mongoose.connection.db.collection('conversations').insertMany(conversations);

    binding = bindSearch({
      app: { locals: {} },
      appConfig: {
        search: loadSearchConfig({
          search: { data: true, backend: 'search', languages: ['is', 'en'], languageDataDir },
        }),
      },
      methods: db,
      setSearchPort: db.setSearchPort,
      jwtSecret: 'test',
      logger,
    });
    await startSearchBackground(binding);

    const resolved = resolveSearchPacks(['is', 'en'], { languageDataDir });
    await Promise.all(resolved.packs.map((pack) => pack.load()));
    const analyzer = createAnalyzer({ packs: resolved.packs, cacheWords: 100000 });
    await loadSearchRecords(mongoose.models, {
      analyzer,
      version: computeAnalyzerVersion(resolved.packs),
      messages: sources.map((source) => ({ ...source, _id: String(source._id) })),
      conversations: conversations.map((source) => ({ ...source, _id: String(source._id) })),
      verificationPassed: true,
    });

    app = appFor(USER);
    otherApp = appFor(OTHER);
  }, 180000);

  afterAll(async () => {
    db?.setSearchPort(null);
    await mongoose.disconnect();
    await server?.stop();
  });

  it('loaded the real packs', () => {
    expect(binding.service.packState()).toBe('loaded');
  });

  it('reports /enable true', async () => {
    expect(await binding.enabled()).toBe(true);
  });

  it('hestur finds hestinum', async () => {
    expect(ids(await search('hestur'))).toContain('m-hestinum');
  });

  it('skattur finds tekjuskattur, ranked below the word itself', async () => {
    const found = ids(await search('skattur'));
    expect(found).toContain('m-tekjuskattur');
    expect(found.indexOf('m-skattur')).toBeLessThan(found.indexOf('m-tekjuskattur'));
  });

  it('bornum finds börnum', async () => {
    expect(ids(await search('bornum'))).toContain('m-bornum');
  });

  it('never splits a query word: þjónustuver does not reach ver', async () => {
    const found = ids(await search('þjónustuver'));
    expect(found).toContain('m-thjonustuver');
    expect(found).not.toContain('m-ver');
  });

  it('taka does not reach fyrirtæki', async () => {
    expect(ids(await search('taka'))).not.toContain('m-fyrirtaeki');
  });

  it.each(['hestur', 'skattur', 'bornum', OTHER_SENTINEL])(
    'never shows another user’s message for %s',
    async (query) => {
      const messages = await search(query);
      expect(ids(messages)).not.toContain('m-other');
      expect(JSON.stringify(messages)).not.toContain(OTHER_SENTINEL);
    },
  );

  it('gives the other user their own message only', async () => {
    expect(ids(await search('hestur', otherApp))).toEqual(['m-other']);
  });

  it('shows titles and messages on the sidebar, and nothing of the other user', async () => {
    const response = await request(app).get('/api/convos').query({ search: 'hestur' });

    expect(response.status).toBe(200);
    expect(response.body.conversations.map(({ conversationId }) => conversationId)).toEqual([
      'convo-title',
      'convo-main',
    ]);
    expect(JSON.stringify(response.body)).not.toContain(OTHER_SENTINEL);
  });
});
