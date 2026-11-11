import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  AppService,
  createMethods,
  createModels,
  loadSearchConfig,
  SearchError,
} from '@librechat/data-schemas';
import type { BindSearchDeps } from '../start';
import { createSearchConfigSnapshot, isSearchDataOn, isSearchServing } from '../config';
import { bindSearch } from '../start';

/** Search with the default configuration leaves behaviour, data and API contracts as they are (FR-041). */
describe('search with the default configuration', () => {
  describe('storage', () => {
    let server: MongoMemoryServer;
    let database: mongoose.Mongoose;
    let models: ReturnType<typeof createModels>;

    beforeAll(async () => {
      server = await MongoMemoryServer.create();
      database = new mongoose.Mongoose();
      await database.connect(server.getUri());
      /* Here and not in the first test, so each test below can run alone. */
      models = createModels(database);
    });

    afterAll(async () => {
      await database.disconnect();
      await server.stop();
    });

    it('creates no search collection, with automatic creation on', async () => {
      createMethods(database);
      await Promise.all(Object.values(models).map((model) => model.init().catch(() => undefined)));

      const collections = await database.connection.db!.listCollections().toArray();
      const names = collections.map(({ name }) => name);

      expect(names).toContain('messages');
      expect(names).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^(msearch|csearch|search_vocab|search_state)$/),
        ]),
      );
      /* Builds every model's indexes, which can pass the default limit on a loaded machine. */
    }, 120_000);

    it('startup with no `search` block creates no collection and starts no runner', async () => {
      const methods = createMethods(database) as unknown as BindSearchDeps['methods'];
      const resolvePacks = jest.fn();
      const binding = bindSearch({
        app: { locals: {} },
        appConfig: {},
        methods,
        setSearchPort: () => undefined,
        logger: { info: () => undefined, warn: () => undefined },
        resolvePacks,
      });

      await binding.startBackground();

      expect(binding.jobs()).toBeNull();
      expect(binding.writer()).toBeNull();
      expect(resolvePacks).not.toHaveBeenCalled();
      const names = (await database.connection.db!.listCollections().toArray()).map(
        ({ name }) => name,
      );
      for (const name of ['msearch', 'csearch', 'search_vocab', 'search_state']) {
        expect(names).not.toContain(name);
      }
    }, 60_000);

    it('lists shared links as today, with no search context and no new field', async () => {
      const methods = createMethods(database) as unknown as BindSearchDeps['methods'];
      const binding = bindSearch({
        app: { locals: {} },
        appConfig: {},
        methods,
        setSearchPort: () => undefined,
        logger: { info: () => undefined, warn: () => undefined },
      });
      const titleMatches = jest.spyOn(binding.service, 'titleMatches');
      const meiliSearch = jest.fn(async () => ({ hits: [{ conversationId: 'shared-convo' }] }));
      Object.assign(database.models.Conversation, { meiliSearch });
      await database.models.SharedLink.create([
        { conversationId: 'shared-convo', user: 'user-a', shareId: 'share-1', title: 'Shared' },
        { conversationId: 'other-convo', user: 'user-a', shareId: 'share-2', title: 'Other' },
      ]);
      const searchContext = binding.shares.context(
        { user: { id: 'user-a' } },
        { writableFinished: false, once: jest.fn() },
      );

      const result = await createMethods(database, {
        getSearchPort: () => binding.service,
      }).getSharedLinks('user-a', undefined, 10, 'createdAt', 'desc', 'word', searchContext);

      expect(searchContext).toBeUndefined();
      expect(titleMatches).not.toHaveBeenCalled();
      expect(meiliSearch).toHaveBeenCalledTimes(1);
      expect(Object.keys(result).sort()).toEqual(['hasNextPage', 'links', 'nextCursor']);
      expect(result).not.toHaveProperty('reason');
      expect(result.links).toEqual([
        {
          shareId: 'share-1',
          title: 'Shared',
          createdAt: expect.any(Date),
          conversationId: 'shared-convo',
        },
      ]);
      expect(Object.keys(result.links[0]).sort()).toEqual([
        'conversationId',
        'createdAt',
        'shareId',
        'title',
      ]);
    }, 60_000);
  });

  describe('config', () => {
    it('keeps Meilisearch serving with search data off', () => {
      expect(loadSearchConfig({})).toMatchObject({
        data: false,
        backend: 'meilisearch',
        meiliResyncPending: false,
        jobs: { backfillOnStart: false },
      });
    });

    it('reaches AppService and the process snapshot the same way', async () => {
      const appConfig = await AppService({ config: {} });
      const snapshot = createSearchConfigSnapshot(appConfig);

      expect(snapshot).toEqual(loadSearchConfig({}));
      expect(isSearchDataOn(snapshot)).toBe(false);
      expect(isSearchServing(snapshot)).toBe(false);
    });
  });
});

describe('search service with the default configuration', () => {
  const noRead = () => {
    throw new Error('a default-config search read');
  };
  const methods = new Proxy({}, { get: () => noRead }) as BindSearchDeps['methods'];
  const context = {
    user: 'user-a',
    signal: new AbortController().signal,
    startedAt: Date.now(),
  };

  const bindDefault = (meili?: BindSearchDeps['meili']) => {
    const logs: unknown[][] = [];
    const logger = {
      info: (...args: unknown[]) => void logs.push(args),
      warn: (...args: unknown[]) => void logs.push(args),
    };
    const app = { locals: {} as Record<string, unknown> };
    const setSearchPort = jest.fn();
    const binding = bindSearch({
      app,
      appConfig: {},
      methods,
      setSearchPort,
      logger,
      ...(meili ? { meili } : {}),
    });
    return { binding, logs, setSearchPort };
  };

  /** Meilisearch as the server entry points hand it over, with the health the test sets. */
  const meilisearch = (env: NonNullable<BindSearchDeps['meili']>['env'], status = 'available') => {
    const health = jest.fn(async () => ({ status }));
    const built = jest.fn();
    const getSyncProgress = jest.fn();
    class MeiliSearch {
      constructor() {
        built();
      }

      health = health;
    }
    return {
      deps: {
        env,
        MeiliSearch,
        models: { Message: { getSyncProgress }, Conversation: { getSyncProgress } },
      },
      health,
      built,
      getSyncProgress,
    };
  };
  const MEILI_ENV = { SEARCH: 'true', MEILI_HOST: 'http://meili.test:7700', MEILI_MASTER_KEY: 'k' };

  it('answers null on every surface, with no read and no event', async () => {
    const { binding, logs, setSearchPort } = bindDefault();
    await binding.startBackground();

    expect(setSearchPort).toHaveBeenCalledTimes(1);
    expect(await binding.service.searchMessages(context, 'word')).toBeNull();
    expect(await binding.service.conversationMatches(context, 'word')).toBeNull();
    expect(await binding.service.titleMatches(context, 'word')).toBeNull();
    expect(await binding.enabled()).toBe(false);
    expect(await binding.meta()).toEqual({});
    expect(
      await binding.messages(
        { user: { id: 'user-a' } },
        { writableFinished: false, once: jest.fn() },
        'word',
        null,
      ),
    ).toBeNull();
    expect(
      binding.conversations.context({}, { writableFinished: false, once: jest.fn() }),
    ).toBeUndefined();
    expect(
      binding.shares.context({}, { writableFinished: false, once: jest.fn() }),
    ).toBeUndefined();
    binding.shares.completed(undefined, { links: [{}] });
    expect(logs).toEqual([]);
  });

  describe('/enable and /meta', () => {
    it('/enable is today’s check: SEARCH on and Meilisearch healthy, with no database read', async () => {
      const fake = meilisearch(MEILI_ENV);
      const { binding, logs } = bindDefault(fake.deps);

      expect(await binding.enabled()).toBe(true);
      expect(await binding.enabled()).toBe(true);

      expect(fake.health).toHaveBeenCalledTimes(2);
      expect(fake.built).toHaveBeenCalledTimes(1);
      expect(fake.getSyncProgress).not.toHaveBeenCalled();
      expect(logs).toEqual([]);
    });

    it('/enable is false when Meilisearch is unhealthy, as today', async () => {
      const { binding } = bindDefault(meilisearch(MEILI_ENV, 'unavailable').deps);
      expect(await binding.enabled()).toBe(false);
    });

    it.each([
      ['SEARCH off', { ...MEILI_ENV, SEARCH: 'false' }],
      ['SEARCH unset', { MEILI_HOST: MEILI_ENV.MEILI_HOST, MEILI_MASTER_KEY: 'k' }],
      ['MEILI_HOST unset', { SEARCH: 'true', MEILI_MASTER_KEY: 'k' }],
      ['MEILI_MASTER_KEY unset', { SEARCH: 'true', MEILI_HOST: MEILI_ENV.MEILI_HOST }],
    ])('/enable is false with %s, and builds no Meilisearch client', async (_name, env) => {
      const fake = meilisearch(env);
      const { binding, logs } = bindDefault(fake.deps);

      expect(await binding.enabled()).toBe(false);

      expect(fake.built).not.toHaveBeenCalled();
      expect(fake.health).not.toHaveBeenCalled();
      expect(logs).toEqual([]);
    });

    it('/meta is empty, with no read and no pack', async () => {
      const { binding, logs } = bindDefault(meilisearch(MEILI_ENV).deps);

      expect(await binding.meta()).toEqual({});
      expect(binding.service.jobAnalyzer()).toBeNull();
      expect(logs).toEqual([]);
    });
  });

  it('leaves a failure on a default-config route to today’s handling', () => {
    const { binding } = bindDefault();
    expect(binding.conversations.failure(undefined, new Error('raw'))).toBeNull();
    expect(binding.shares.failure(undefined, new Error('raw'))).toBeNull();
    expect(binding.shares.failure(undefined, new SearchError('search_busy'))).toBeNull();
  });
});
