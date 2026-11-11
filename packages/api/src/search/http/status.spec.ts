import type { MeiliStatusDeps, MeiliSyncProgress } from '../meili';
import type { SearchHarness } from '../__tests__/helpers/harness';
import type { LanguagePack } from '../languages/pack';
import { createSearchHarness, searchConfig } from '../__tests__/helpers/harness';
import { checkObserved, recordObserved } from '../sync/observed';
import { createSearchConfigSnapshot } from '../config';
import { createSearchService } from '../service';
import { createSearchStatus } from './status';

const SEARCH_ON = { SEARCH: 'true' };
const MEILI_ON = { ...SEARCH_ON, MEILI_HOST: 'http://meili.test:7700', MEILI_MASTER_KEY: 'key' };
const CAUGHT_UP: MeiliSyncProgress = {
  totalProcessed: 10,
  totalDocuments: 10,
  pendingIndexing: 0,
  pendingCleanup: 0,
};

describe('createSearchStatus', () => {
  let harness: SearchHarness;
  let now: number;

  const status = async (
    search: Parameters<typeof searchConfig>[0] = {},
    load = true,
    meili: MeiliStatusDeps = { env: SEARCH_ON },
    packs: LanguagePack[] = harness.packs,
  ) => {
    const service = createSearchService({
      config: createSearchConfigSnapshot({ search: searchConfig(search) }),
      methods: harness.methods,
      metrics: harness.metrics,
      logger: harness.logger,
      cursorSecret: 'secret',
      resolvePacks: () => ({ ok: true, packs }),
    });
    if (load) {
      await service.loadPacks();
    }
    return createSearchStatus({
      service,
      methods: harness.methods,
      logger: harness.logger,
      meili,
      now: () => now,
    });
  };

  /** A Meilisearch whose health and sync progress the test sets. */
  const meilisearch = (env: MeiliStatusDeps['env'] = MEILI_ON) => {
    const health = jest.fn(async () => ({ status: 'available' }));
    const built = jest.fn();
    class MeiliSearch {
      constructor(options: { host: string; apiKey: string }) {
        built(options);
      }

      health = health;
    }
    const progress = { Message: { ...CAUGHT_UP }, Conversation: { ...CAUGHT_UP } };
    const getSyncProgress = {
      Message: jest.fn(async () => progress.Message),
      Conversation: jest.fn(async () => progress.Conversation),
    };
    const deps: MeiliStatusDeps = {
      env,
      MeiliSearch,
      models: {
        Message: { getSyncProgress: getSyncProgress.Message },
        Conversation: { getSyncProgress: getSyncProgress.Conversation },
      },
    };
    return { deps, health, built, progress, getSyncProgress };
  };

  const verification = (fields: Record<string, unknown>) =>
    harness.models.SearchState.updateOne(
      { _id: 'verification' },
      { $set: fields },
      { upsert: true },
    );

  beforeAll(async () => {
    harness = await createSearchHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    now = Date.now();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('SEARCH off', () => {
    it.each([
      ['search', { env: {} }],
      ['search', { env: { SEARCH: 'false' } }],
      ['meilisearch', { env: { ...MEILI_ON, SEARCH: 'false' } }],
    ] as const)('is never true on %s with %j, reading nothing', async (backend, meili) => {
      await verification({ status: 'passed', passedAt: new Date() });
      const read = jest.spyOn(harness.methods, 'readSearchState');
      const fake = meilisearch(meili.env);

      expect(await (await status({ backend }, true, fake.deps)).enabled()).toBe(false);

      expect(read).not.toHaveBeenCalled();
      expect(fake.built).not.toHaveBeenCalled();
    });
  });

  describe('backend meilisearch', () => {
    const meiliStatus = (
      fake: ReturnType<typeof meilisearch>,
      search: Parameters<typeof searchConfig>[0] = {},
    ) => status({ backend: 'meilisearch', ...search }, true, fake.deps);

    it('is true when Meilisearch is healthy, reading no search state', async () => {
      const read = jest.spyOn(harness.methods, 'readSearchState');
      const fake = meilisearch();

      expect(await (await meiliStatus(fake)).enabled()).toBe(true);

      expect(fake.built).toHaveBeenCalledWith({ host: MEILI_ON.MEILI_HOST, apiKey: 'key' });
      expect(read).not.toHaveBeenCalled();
      expect(fake.getSyncProgress.Message).not.toHaveBeenCalled();
    });

    it('asks health on every call, as today, through one client', async () => {
      const fake = meilisearch();
      const created = await meiliStatus(fake);

      await created.enabled();
      await created.enabled();

      expect(fake.health).toHaveBeenCalledTimes(2);
      expect(fake.built).toHaveBeenCalledTimes(1);
    });

    it('is false when Meilisearch is not available', async () => {
      const fake = meilisearch();
      fake.health.mockResolvedValue({ status: 'unavailable' });
      expect(await (await meiliStatus(fake)).enabled()).toBe(false);
    });

    it('is false when the health check fails, with nothing raw logged', async () => {
      const fake = meilisearch();
      fake.health.mockRejectedValue(new Error('SENTINEL_HEALTH_TEXT'));

      expect(await (await meiliStatus(fake)).enabled()).toBe(false);
      expect(JSON.stringify(harness.logged)).not.toContain('SENTINEL_HEALTH_TEXT');
    });

    it.each([
      ['MEILI_HOST', { ...SEARCH_ON, MEILI_MASTER_KEY: 'key' }],
      ['MEILI_MASTER_KEY', { ...SEARCH_ON, MEILI_HOST: MEILI_ON.MEILI_HOST }],
    ])('is false without %s, and builds no client', async (_name, env) => {
      const fake = meilisearch(env);

      expect(await (await meiliStatus(fake)).enabled()).toBe(false);

      expect(fake.built).not.toHaveBeenCalled();
      expect(fake.health).not.toHaveBeenCalled();
    });

    it('is false when the client cannot be built, and does not try again', async () => {
      const built = jest.fn(() => {
        throw new Error('SENTINEL_CLIENT_TEXT');
      });
      class MeiliSearch {
        constructor() {
          built();
        }

        health = async () => ({ status: 'available' });
      }
      const created = await status({ backend: 'meilisearch' }, true, {
        env: MEILI_ON,
        MeiliSearch,
      });

      expect(await created.enabled()).toBe(false);
      expect(await created.enabled()).toBe(false);

      expect(built).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(harness.logged)).not.toContain('SENTINEL_CLIENT_TEXT');
    });

    describe('meiliResyncPending', () => {
      const pending = (fake: ReturnType<typeof meilisearch>) =>
        meiliStatus(fake, { meiliResyncPending: true });

      it('is true once both models have caught up', async () => {
        const fake = meilisearch();
        expect(await (await pending(fake)).enabled()).toBe(true);
        expect(fake.getSyncProgress.Message).toHaveBeenCalledTimes(1);
        expect(fake.getSyncProgress.Conversation).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['indexing pending on messages', 'Message', { pendingIndexing: 1 }],
        ['cleanup pending on conversations', 'Conversation', { pendingCleanup: 1 }],
        ['unprocessed messages past the threshold', 'Message', { totalDocuments: 1011 }],
      ] as const)('is false with %s', async (_name, model, fields) => {
        const fake = meilisearch();
        Object.assign(fake.progress[model], fields);
        expect(await (await pending(fake)).enabled()).toBe(false);
      });

      it('passes with an aborted message written after the full sync, where isComplete is false', async () => {
        const fake = meilisearch();
        /* One message the sync never attempted: nothing pending, one unprocessed, never complete. */
        Object.assign(fake.progress.Message, {
          totalProcessed: 10,
          totalDocuments: 11,
          isComplete: false,
        });

        expect(await (await pending(fake)).enabled()).toBe(true);
      });

      it('counts unprocessed documents against MEILI_SYNC_THRESHOLD', async () => {
        const within = meilisearch({ ...MEILI_ON, MEILI_SYNC_THRESHOLD: '5' });
        Object.assign(within.progress.Message, { totalDocuments: 15 });
        expect(await (await pending(within)).enabled()).toBe(true);

        const past = meilisearch({ ...MEILI_ON, MEILI_SYNC_THRESHOLD: '5' });
        Object.assign(past.progress.Message, { totalDocuments: 16 });
        expect(await (await pending(past)).enabled()).toBe(false);
      });

      it('caches the check for 60 seconds while it has not passed', async () => {
        const fake = meilisearch();
        fake.progress.Message.pendingIndexing = 3;
        const created = await pending(fake);

        expect(await created.enabled()).toBe(false);
        fake.progress.Message.pendingIndexing = 0;
        now += 59_000;
        expect(await created.enabled()).toBe(false);
        expect(fake.getSyncProgress.Message).toHaveBeenCalledTimes(1);

        now += 2_000;
        expect(await created.enabled()).toBe(true);
        expect(fake.getSyncProgress.Message).toHaveBeenCalledTimes(2);
      });

      it('is not checked again in this process once it has passed', async () => {
        const fake = meilisearch();
        const created = await pending(fake);
        expect(await created.enabled()).toBe(true);

        fake.progress.Message.pendingIndexing = 9;
        now += 10 * 60_000;

        expect(await created.enabled()).toBe(true);
        expect(fake.getSyncProgress.Message).toHaveBeenCalledTimes(1);
        expect(fake.health).toHaveBeenCalledTimes(2);
      });

      it('shares one check between requests that arrive together', async () => {
        const fake = meilisearch();
        const created = await pending(fake);

        expect(await Promise.all([created.enabled(), created.enabled()])).toEqual([true, true]);
        expect(fake.getSyncProgress.Message).toHaveBeenCalledTimes(1);
      });

      it('still needs Meilisearch healthy, and skips the counts when it is not', async () => {
        const fake = meilisearch();
        fake.health.mockResolvedValue({ status: 'unavailable' });

        expect(await (await pending(fake)).enabled()).toBe(false);
        expect(fake.getSyncProgress.Message).not.toHaveBeenCalled();
      });

      it('is false when the progress read fails, with nothing raw logged', async () => {
        const fake = meilisearch();
        fake.getSyncProgress.Conversation.mockRejectedValueOnce(new Error('SENTINEL_SYNC_TEXT'));

        expect(await (await pending(fake)).enabled()).toBe(false);
        expect(JSON.stringify(harness.logged)).not.toContain('SENTINEL_SYNC_TEXT');
      });

      it('is false where the models carry no sync progress', async () => {
        const fake = meilisearch();
        const created = await status({ backend: 'meilisearch', meiliResyncPending: true }, true, {
          ...fake.deps,
          models: {},
        });
        expect(await created.enabled()).toBe(false);
      });

      it('is not consulted on the search backend', async () => {
        await verification({ status: 'passed', passedAt: new Date() });
        const fake = meilisearch();
        const created = await status({ meiliResyncPending: true }, true, fake.deps);

        expect(await created.enabled()).toBe(true);
        expect(fake.built).not.toHaveBeenCalled();
        expect(fake.getSyncProgress.Message).not.toHaveBeenCalled();
      });
    });
  });

  it('is true with data on, packs loaded and a passed verification', async () => {
    await verification({ status: 'passed', passedAt: new Date() });
    expect(await (await status()).enabled()).toBe(true);
  });

  it('is false with no verification record', async () => {
    expect(await (await status()).enabled()).toBe(false);
  });

  it.each(['pending', 'failed'])('is false with verification %s', async (value) => {
    await verification({ status: value, passedAt: new Date() });
    expect(await (await status()).enabled()).toBe(false);
  });

  it('is false for a pass older than invalidatedAt', async () => {
    await verification({
      status: 'passed',
      passedAt: new Date('2026-01-01'),
      invalidatedAt: new Date('2026-02-01'),
    });
    expect(await (await status()).enabled()).toBe(false);
  });

  it('is true for a pass later than invalidatedAt', async () => {
    await verification({
      status: 'passed',
      passedAt: new Date('2026-03-01'),
      invalidatedAt: new Date('2026-02-01'),
    });
    expect(await (await status()).enabled()).toBe(true);
  });

  it('is false with data off, reading nothing', async () => {
    await verification({ status: 'passed', passedAt: new Date() });
    const read = jest.spyOn(harness.methods, 'readSearchState');
    expect(await (await status({ data: false })).enabled()).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('is false while packs load', async () => {
    await verification({ status: 'passed', passedAt: new Date() });
    expect(await (await status({}, false)).enabled()).toBe(false);
  });

  it('is false when a pack failed', async () => {
    await verification({ status: 'passed', passedAt: new Date() });
    const service = createSearchService({
      config: createSearchConfigSnapshot({ search: searchConfig({ languages: ['zz'] }) }),
      methods: harness.methods,
      metrics: harness.metrics,
      logger: harness.logger,
      cursorSecret: 'secret',
    });
    await service.loadPacks();
    const created = createSearchStatus({
      service,
      methods: harness.methods,
      logger: harness.logger,
      meili: { env: SEARCH_ON },
    });
    expect(await created.enabled()).toBe(false);
    expect(harness.logged.find(({ event }) => event === 'search.pack')?.meta).toMatchObject({
      state: 'failed',
    });
  });

  it('caches its read for statusCacheSeconds', async () => {
    await verification({ status: 'passed', passedAt: new Date() });
    const read = jest.spyOn(harness.methods, 'readSearchState');
    const created = await status({ statusCacheSeconds: 15 });

    await created.enabled();
    now += 14_000;
    await created.enabled();
    expect(read).toHaveBeenCalledTimes(1);

    now += 2_000;
    await created.enabled();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('is false on a failed read, with no raw text, and does not cache it', async () => {
    await verification({ status: 'passed', passedAt: new Date() });
    const created = await status();
    jest
      .spyOn(harness.methods, 'readSearchState')
      .mockRejectedValueOnce(new Error('SENTINEL_READ_TEXT'));

    expect(await created.enabled()).toBe(false);
    expect(JSON.stringify(harness.logged)).not.toContain('SENTINEL_READ_TEXT');
    expect(await created.enabled()).toBe(true);
  });

  describe('across restarts', () => {
    /** One process start, as `bindSearch` runs it: the observed check, then the status it serves. */
    const restart = async (
      config: { backend: 'meilisearch' | 'search'; data: boolean },
      meili: MeiliStatusDeps = { env: SEARCH_ON },
    ) => {
      now += 1000;
      await checkObserved({ methods: harness.methods, config, now: () => now });
      if (config.data) {
        await recordObserved({ methods: harness.methods, config, now: () => now });
      }
      return status(config, true, meili);
    };
    const pass = () => verification({ status: 'passed', passedAt: new Date(now) });

    it('a restart from search to meilisearch and back leaves the old pass unusable', async () => {
      const first = await restart({ backend: 'search', data: true });
      await pass();
      expect(await first.enabled()).toBe(true);

      const fake = meilisearch();
      const rolledBack = await restart({ backend: 'meilisearch', data: true }, fake.deps);
      expect(await rolledBack.enabled()).toBe(true);
      expect(fake.health).toHaveBeenCalledTimes(1);

      const returned = await restart({ backend: 'search', data: true });
      expect(await returned.enabled()).toBe(false);

      now += 1000;
      await pass();
      expect(await (await restart({ backend: 'search', data: true })).enabled()).toBe(true);
    });

    it('data off then on leaves the old pass unusable until a later one', async () => {
      const first = await restart({ backend: 'search', data: true });
      await pass();
      expect(await first.enabled()).toBe(true);

      expect(await (await restart({ backend: 'search', data: false })).enabled()).toBe(false);

      const back = await restart({ backend: 'search', data: true });
      expect(await back.enabled()).toBe(false);

      now += 1000;
      await pass();
      expect(await (await restart({ backend: 'search', data: true })).enabled()).toBe(true);
    });
  });

  describe('meta', () => {
    const ATTRIBUTION = { text: 'Word forms from a test dictionary.', url: 'https://example.com' };
    const attributed = (): LanguagePack => ({ ...harness.packs[0], attribution: ATTRIBUTION });
    const analyzerState = (fields: Record<string, unknown>) =>
      harness.models.SearchState.updateOne({ _id: 'analyzer' }, { $set: fields }, { upsert: true });

    it('is empty with data off, reading nothing', async () => {
      await analyzerState({ packs: [{ id: 'fake', attribution: ATTRIBUTION }] });
      const read = jest.spyOn(harness.methods, 'readSearchState');

      for (const backend of ['meilisearch', 'search'] as const) {
        expect(await (await status({ backend, data: false })).meta()).toEqual({});
      }
      expect(read).not.toHaveBeenCalled();
    });

    it.each(['meilisearch', 'search'] as const)(
      'gives an enabled pack’s attribution with data on, on %s, without a read',
      async (backend) => {
        const read = jest.spyOn(harness.methods, 'readSearchState');
        const created = await status({ backend }, true, { env: {} }, [
          attributed(),
          harness.packs[1],
        ]);

        expect(await created.meta()).toEqual({ attribution: ATTRIBUTION });
        expect(read).not.toHaveBeenCalled();
      },
    );

    it('is empty with data on and no attributed pack, enabled or recorded', async () => {
      await analyzerState({ version: 'v', packs: [{ id: 'fake' }, { id: 'en' }] });
      expect(await (await status()).meta()).toEqual({});
    });

    it('keeps a disabled pack’s attribution from search_state until re-analysis clears it', async () => {
      await analyzerState({
        packs: [{ id: 'en' }],
        attributionUntilReanalyzed: [{ id: 'fake', attribution: ATTRIBUTION }],
      });
      const created = await status({ statusCacheSeconds: 15 }, true, { env: {} }, [
        harness.packs[1],
      ]);

      expect(await created.meta()).toEqual({ attribution: ATTRIBUTION });

      await analyzerState({ attributionUntilReanalyzed: null });
      now += 16_000;
      expect(await created.meta()).toEqual({});
    });

    it('reads the packs the writer recorded while this process’s own are still loading', async () => {
      await analyzerState({ packs: [{ id: 'fake', attribution: ATTRIBUTION }] });
      expect(await (await status({}, false)).meta()).toEqual({ attribution: ATTRIBUTION });
    });

    it('caches the state read for statusCacheSeconds', async () => {
      const read = jest.spyOn(harness.methods, 'readSearchState');
      const created = await status({ statusCacheSeconds: 15 });

      await created.meta();
      now += 14_000;
      await created.meta();
      expect(read).toHaveBeenCalledTimes(1);

      now += 2_000;
      await created.meta();
      expect(read).toHaveBeenCalledTimes(2);
    });

    it('ignores a recorded attribution that is not text and a link', async () => {
      await analyzerState({
        attributionUntilReanalyzed: [{ id: 'fake', attribution: { text: 5, url: {} } }],
        packs: 'not-a-list',
      });
      expect(await (await status()).meta()).toEqual({});
    });

    it('is empty on a failed read, with no raw text, and does not cache it', async () => {
      await analyzerState({
        attributionUntilReanalyzed: [{ id: 'fake', attribution: ATTRIBUTION }],
      });
      const created = await status();
      jest
        .spyOn(harness.methods, 'readSearchState')
        .mockRejectedValueOnce(new Error('SENTINEL_META_TEXT'));

      expect(await created.meta()).toEqual({});
      expect(JSON.stringify(harness.logged)).not.toContain('SENTINEL_META_TEXT');
      expect(await created.meta()).toEqual({ attribution: ATTRIBUTION });
    });
  });
});
