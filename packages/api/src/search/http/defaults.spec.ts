import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { AppService, createMethods, createModels, loadSearchConfig } from '@librechat/data-schemas';
import type { SearchServiceDeps } from '../service';
import {
  createSearchConfigSnapshot,
  isSearchDataOn,
  isShadowRunEnabled,
  isSearchServing,
} from '../config';
import { bindSearch } from '../start';

/** Search with the default configuration leaves behaviour, data and API contracts as they are (FR-041). */
describe('search with the default configuration', () => {
  describe('storage', () => {
    let server: MongoMemoryServer;
    let database: mongoose.Mongoose;

    beforeAll(async () => {
      server = await MongoMemoryServer.create();
      database = new mongoose.Mongoose();
      await database.connect(server.getUri());
    });

    afterAll(async () => {
      await database.disconnect();
      await server.stop();
    });

    it('creates no search collection, with automatic creation on', async () => {
      const models = createModels(database);
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
  });

  describe('config', () => {
    it('keeps Meilisearch serving with search data off', () => {
      expect(loadSearchConfig({})).toMatchObject({
        data: false,
        backend: 'meilisearch',
        meiliResyncPending: false,
      });
    });

    it('reaches AppService and the process snapshot the same way', async () => {
      const appConfig = await AppService({ config: {} });
      const snapshot = createSearchConfigSnapshot(appConfig);

      expect(snapshot).toEqual(loadSearchConfig({}));
      expect(isSearchDataOn(snapshot)).toBe(false);
      expect(isSearchServing(snapshot)).toBe(false);
      expect(isShadowRunEnabled(snapshot)).toBe(false);
    });
  });
});

describe('search service with the default configuration', () => {
  const noRead = () => {
    throw new Error('a default-config search read');
  };
  const methods = new Proxy({}, { get: () => noRead }) as SearchServiceDeps['methods'];
  const context = {
    user: 'user-a',
    signal: new AbortController().signal,
    startedAt: Date.now(),
  };

  const bindDefault = () => {
    const logs: unknown[][] = [];
    const logger = {
      info: (...args: unknown[]) => void logs.push(args),
      warn: (...args: unknown[]) => void logs.push(args),
    };
    const app = { locals: {} as Record<string, unknown> };
    const setSearchPort = jest.fn();
    const binding = bindSearch({ app, appConfig: {}, methods, setSearchPort, logger });
    return { binding, logs, setSearchPort };
  };

  it('answers null on every surface, with no read and no event', async () => {
    const { binding, logs, setSearchPort } = bindDefault();
    await binding.startBackground();

    expect(setSearchPort).toHaveBeenCalledTimes(1);
    expect(await binding.service.searchMessages(context, 'word')).toBeNull();
    expect(await binding.service.conversationMatches(context, 'word')).toBeNull();
    expect(await binding.service.titleMatches(context, 'word')).toBeNull();
    expect(await binding.enabled()).toBeNull();
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
    expect(logs).toEqual([]);
  });

  it('leaves a failure on a default-config route to today’s handling', () => {
    const { binding } = bindDefault();
    expect(binding.conversations.failure(undefined, new Error('raw'))).toBeNull();
  });
});
