import type { SearchHarness } from './__tests__/helpers/harness';
import { createSearchHarness, searchConfig } from './__tests__/helpers/harness';
import { bindSearch, startSearchBackground } from './start';

describe('search startup', () => {
  let harness: SearchHarness;

  const bind = (search?: Parameters<typeof searchConfig>[0], overrides = {}) => {
    const app = { locals: {} as Record<string, unknown> };
    const setSearchPort = jest.fn();
    const binding = bindSearch({
      app,
      appConfig: search === undefined ? {} : { search: searchConfig(search) },
      methods: harness.methods,
      setSearchPort,
      jwtSecret: 'test-secret',
      logger: harness.logger,
      ...overrides,
    });
    return { app, setSearchPort, binding };
  };

  beforeAll(async () => {
    harness = await createSearchHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  it('bindSearch binds the port and app.locals.search synchronously, and reads nothing', () => {
    const read = jest.spyOn(harness.methods, 'readSearchState');
    const { app, setSearchPort, binding } = bind();

    expect(app.locals.search).toBe(binding);
    expect(setSearchPort).toHaveBeenCalledWith(binding.service);
    expect(read).not.toHaveBeenCalled();
  });

  it('with default config loads no pack and leaves every surface to today’s code', async () => {
    const resolvePacks = jest.fn();
    const { binding } = bind(undefined, { resolvePacks });

    await startSearchBackground(binding);

    expect(resolvePacks).not.toHaveBeenCalled();
    expect(harness.logged.filter(({ event }) => event === 'search.pack')).toEqual([]);
    expect(binding.service.isServing()).toBe(false);
    expect(await binding.enabled()).toBe(false);
    expect(await binding.meta()).toEqual({});
    expect(
      await binding.messages(
        { user: { id: 'user-a' } } as never,
        { once: () => undefined } as never,
        'word',
        null,
      ),
    ).toBeNull();
    expect(binding.conversations.context({} as never, {} as never)).toBeUndefined();
  });

  it('with data on loads enabled packs after bind, not during it', async () => {
    const load = jest.fn(async () => undefined);
    const { binding } = bind(
      { languages: ['fake'] },
      { resolvePacks: () => ({ ok: true, packs: [{ ...harness.packs[0], load }] }) },
    );

    expect(load).not.toHaveBeenCalled();
    expect(binding.service.packState()).toBe('loading');

    await startSearchBackground(binding);

    expect(load).toHaveBeenCalledTimes(1);
    expect(binding.service.packState()).toBe('loaded');
  });

  describe('with search data on', () => {
    afterEach(async () => {
      await started?.stopBackground();
      started = null;
    });

    let started: ReturnType<typeof bind>['binding'] | null = null;

    it('loads packs, then ensures the collections, then starts the runner', async () => {
      const order: string[] = [];
      const load = jest.fn(async () => void order.push('packs'));
      const methods = {
        ...harness.methods,
        ensureSearchCollections: async () => {
          order.push('collections');
          await harness.methods.ensureSearchCollections();
        },
        acquireSearchLease: async (
          claim: Parameters<typeof harness.methods.acquireSearchLease>[0],
        ) => {
          order.push('lease');
          return harness.methods.acquireSearchLease(claim);
        },
      };
      const { binding } = bind(
        { languages: ['fake'] },
        { methods, resolvePacks: () => ({ ok: true, packs: [{ ...harness.packs[0], load }] }) },
      );
      started = binding;
      expect(binding.jobs()).toBeNull();

      await startSearchBackground(binding);
      await binding.jobs()?.tick();

      expect(order.slice(0, 3)).toEqual(['packs', 'collections', 'lease']);
      expect(binding.jobs()).not.toBeNull();
    });

    it('reads observed, loads packs, ensures the collections, records observed, then starts the runner and the writer', async () => {
      const order: string[] = [];
      const note = (step: string) => void order.push(step);
      const methods = {
        ...harness.methods,
        readSearchState: (key: string, options: { maxTimeMS: number }) => {
          if (key === 'observed') {
            note('observed read');
          }
          return harness.methods.readSearchState(key, options);
        },
        writeSearchState: (key: string, fields: Record<string, unknown>) => {
          if (key === 'observed') {
            note('observed write');
          }
          return harness.methods.writeSearchState(key, fields);
        },
        ensureSearchCollections: async () => {
          note('collections');
          await harness.methods.ensureSearchCollections();
        },
        acquireSearchLease: (claim: Parameters<typeof harness.methods.acquireSearchLease>[0]) => {
          note('lease');
          return harness.methods.acquireSearchLease(claim);
        },
        /* No replica set here: the stream opens and ends at once. */
        watchSearchSources: async function* () {
          note('watch');
          yield* [];
        },
      };
      const { binding } = bind(
        { languages: ['fake'] },
        {
          methods,
          resolvePacks: () => ({
            ok: true,
            packs: [{ ...harness.packs[0], load: async () => note('packs') }],
          }),
        },
      );
      started = binding;

      await startSearchBackground(binding);
      await binding.jobs()?.tick();
      while (!order.includes('watch')) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect([...new Set(order)]).toEqual([
        'observed read',
        'packs',
        'collections',
        'observed write',
        'lease',
        'watch',
      ]);
      expect(binding.writer()).not.toBeNull();
    });

    it('stopBackground stops the writer and gives the lease up at once', async () => {
      const { binding } = bind(
        { languages: ['fake'] },
        { resolvePacks: () => ({ ok: true, packs: [harness.packs[0]] }) },
      );
      await startSearchBackground(binding);
      await binding.jobs()?.tick();
      expect(binding.jobs()?.isHolder()).toBe(true);

      await binding.stopBackground();

      const lease = await harness.methods.readSearchState('lease', { maxTimeMS: 5000 });
      expect((lease?.leaseUntil as Date).getTime()).toBe(0);
      expect(binding.jobs()?.isHolder()).toBe(false);
    });

    it('stopBackground returns within its bound even when the database never answers', async () => {
      const { binding } = bind(
        { languages: ['fake'] },
        {
          methods: {
            ...harness.methods,
            acquireSearchLease: () => new Promise(() => undefined),
          },
          resolvePacks: () => ({ ok: true, packs: [harness.packs[0]] }),
        },
      );
      await startSearchBackground(binding);
      const startedAt = Date.now();

      await binding.stopBackground();

      /* The bound is 5 s. The margin is for a loaded machine, not for the code. */
      expect(Date.now() - startedAt).toBeLessThan(12_000);
    }, 30_000);

    it('a stop that arrives while packs load starts nothing afterwards', async () => {
      let finishLoad: () => void = () => undefined;
      let loadStarted: () => void = () => undefined;
      const loading = new Promise<void>((resolve) => (loadStarted = resolve));
      const { binding } = bind(
        { languages: ['fake'] },
        {
          resolvePacks: () => ({
            ok: true,
            packs: [
              {
                ...harness.packs[0],
                load: () =>
                  new Promise<void>((done) => {
                    finishLoad = done;
                    loadStarted();
                  }),
              },
            ],
          }),
        },
      );
      const starting = startSearchBackground(binding);
      /* Not a fixed wait: on a loaded machine the read before the packs can take longer. */
      await loading;

      await binding.stopBackground();
      finishLoad();
      await starting;

      expect(binding.jobs()).toBeNull();
      expect(binding.writer()).toBeNull();
      expect(await harness.methods.readSearchState('lease', { maxTimeMS: 5000 })).toBeNull();
    });

    it('a failed observed read leaves the process up, and sync still starts', async () => {
      const { binding } = bind(
        { languages: ['fake'] },
        {
          methods: {
            ...harness.methods,
            readSearchState: (key: string, options: { maxTimeMS: number }) =>
              key === 'observed'
                ? Promise.reject(new Error('SENTINEL_OBSERVED'))
                : harness.methods.readSearchState(key, options),
          },
          resolvePacks: () => ({ ok: true, packs: [harness.packs[0]] }),
        },
      );
      started = binding;

      await expect(startSearchBackground(binding)).resolves.toBeUndefined();

      expect(binding.jobs()).not.toBeNull();
      expect(binding.writer()).not.toBeNull();
      expect(JSON.stringify(harness.logged)).not.toContain('SENTINEL_OBSERVED');
      /* It never compared, so it must not store its own settings over the evidence (FR-037). */
      expect(await harness.methods.readSearchState('observed', { maxTimeMS: 5000 })).toBeNull();
    });

    it('a rollback start whose first observed read fails still invalidates the old pass', async () => {
      await harness.methods.ensureSearchCollections();
      await harness.methods.writeSearchState('observed', { backend: 'search', data: true });
      let reads = 0;
      const { binding } = bind(
        { languages: ['fake'], backend: 'meilisearch' },
        {
          methods: {
            ...harness.methods,
            readSearchState: (key: string, options: { maxTimeMS: number }) => {
              if (key === 'observed') {
                reads += 1;
                if (reads === 1) {
                  return Promise.reject(new Error('SENTINEL_OBSERVED'));
                }
              }
              return harness.methods.readSearchState(key, options);
            },
          },
          resolvePacks: () => ({ ok: true, packs: [harness.packs[0]] }),
        },
      );
      started = binding;

      await startSearchBackground(binding);

      /* The second look, once the collections are known to exist, sees the move off `search`. */
      const verification = await harness.methods.readSearchState('verification', {
        maxTimeMS: 5000,
      });
      expect(verification?.invalidatedAt).toBeInstanceOf(Date);
      expect(await harness.methods.readSearchState('observed', { maxTimeMS: 5000 })).toMatchObject({
        backend: 'meilisearch',
        data: true,
      });
    });

    it('a failed pack starts no runner and takes no lease', async () => {
      const acquire = jest.spyOn(harness.methods, 'acquireSearchLease');
      const { binding } = bind({ languages: ['zz'] });

      await startSearchBackground(binding);

      expect(binding.jobs()).toBeNull();
      expect(acquire).not.toHaveBeenCalled();
      acquire.mockRestore();
    });

    it('a rejected collection step leaves the process up and starts no runner', async () => {
      const { binding } = bind(
        { languages: ['fake'] },
        {
          methods: {
            ...harness.methods,
            ensureSearchCollections: () => Promise.reject(new Error('SENTINEL_START_DB')),
          },
          resolvePacks: () => ({ ok: true, packs: [harness.packs[0]] }),
        },
      );

      started = binding;

      await expect(startSearchBackground(binding)).resolves.toBeUndefined();

      expect(binding.jobs()).toBeNull();
      expect(JSON.stringify(harness.logged)).not.toContain('SENTINEL_START_DB');
    });

    it('tries the collection step again, so a database blip at start does not end sync for good', async () => {
      let calls = 0;
      const { binding } = bind(
        { languages: ['fake'] },
        {
          methods: {
            ...harness.methods,
            ensureSearchCollections: async () => {
              calls += 1;
              if (calls === 1) {
                throw new Error('SENTINEL_START_DB');
              }
              await harness.methods.ensureSearchCollections();
            },
            /* No replica set here: the stream opens and ends at once. */
            watchSearchSources: async function* () {
              yield* [];
            },
          },
          resolvePacks: () => ({ ok: true, packs: [harness.packs[0]] }),
          startRetryMs: 10,
        },
      );
      started = binding;

      await startSearchBackground(binding);
      expect(binding.jobs()).toBeNull();

      const deadline = Date.now() + 10_000;
      while (binding.jobs() === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(binding.jobs()).not.toBeNull();
      expect(binding.writer()).not.toBeNull();
      expect(calls).toBe(2);
    });

    it('does not try again once the process is stopping', async () => {
      let calls = 0;
      const { binding } = bind(
        { languages: ['fake'] },
        {
          methods: {
            ...harness.methods,
            ensureSearchCollections: async () => {
              calls += 1;
              throw new Error('SENTINEL_START_DB');
            },
          },
          resolvePacks: () => ({ ok: true, packs: [harness.packs[0]] }),
          startRetryMs: 10,
        },
      );

      await startSearchBackground(binding);
      await binding.stopBackground();
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(calls).toBe(1);
      expect(binding.jobs()).toBeNull();
    });

    it('readiness does not wait on the runner, even if its first read never answers', async () => {
      const { binding } = bind(
        { languages: ['fake'] },
        {
          methods: {
            ...harness.methods,
            acquireSearchLease: () => new Promise(() => undefined),
          },
          resolvePacks: () => ({ ok: true, packs: [harness.packs[0]] }),
        },
      );

      await expect(startSearchBackground(binding)).resolves.toBeUndefined();

      expect(binding.jobs()).not.toBeNull();
    });

    it('a job heartbeat failing never rejects', async () => {
      const { binding } = bind(
        { languages: ['fake'] },
        {
          methods: {
            ...harness.methods,
            acquireSearchLease: () => Promise.reject(new Error('SENTINEL_LEASE')),
          },
          resolvePacks: () => ({ ok: true, packs: [harness.packs[0]] }),
        },
      );
      started = binding;

      await expect(startSearchBackground(binding)).resolves.toBeUndefined();
      await expect(binding.jobs()!.tick()).resolves.toBeUndefined();

      expect(JSON.stringify(harness.logged)).not.toContain('SENTINEL_LEASE');
    });
  });

  it('with a search block and data off, a restart from search invalidates the pass and starts nothing', async () => {
    await harness.methods.writeSearchState('observed', { backend: 'search', data: true });
    const { binding } = bind({ data: false, backend: 'meilisearch' });

    await startSearchBackground(binding);

    expect(binding.jobs()).toBeNull();
    expect(binding.writer()).toBeNull();
    expect(
      (await harness.methods.readSearchState('verification', { maxTimeMS: 5000 }))?.invalidatedAt,
    ).toBeInstanceOf(Date);
  });

  it('with data off, tries the comparison again after a failed read, so the rollback still invalidates', async () => {
    await harness.methods.writeSearchState('observed', { backend: 'search', data: true });
    let reads = 0;
    const { binding } = bind(
      { data: false, backend: 'meilisearch' },
      {
        startRetryMs: 10,
        methods: {
          ...harness.methods,
          readSearchState: (key: string, options: { maxTimeMS: number }) => {
            if (key === 'observed') {
              reads += 1;
              if (reads <= 2) {
                return Promise.reject(new Error('SENTINEL_OBSERVED'));
              }
            }
            return harness.methods.readSearchState(key, options);
          },
        },
      },
    );

    await startSearchBackground(binding);
    const invalidatedAt = async () =>
      (await harness.methods.readSearchState('verification', { maxTimeMS: 5000 }))?.invalidatedAt;
    expect(await invalidatedAt()).toBeUndefined();

    for (let waited = 0; waited < 200 && (await invalidatedAt()) == null; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(await invalidatedAt()).toBeInstanceOf(Date);
    expect(reads).toBe(3);
    expect(await harness.methods.readSearchState('observed', { maxTimeMS: 5000 })).toMatchObject({
      data: false,
    });
    await binding.stopBackground();
    expect(JSON.stringify(harness.logged)).not.toContain('SENTINEL_OBSERVED');
  });

  it('an unregistered ID leaves the process up and the service failed', async () => {
    const { binding } = bind({ languages: ['zz'] });

    await expect(startSearchBackground(binding)).resolves.toBeUndefined();

    expect(binding.service.packState()).toBe('failed');
    expect(harness.logged.find(({ event }) => event === 'search.pack')?.meta).toMatchObject({
      id: 'zz',
      state: 'failed',
    });
  });

  it('a rejection inside never reaches the caller, and logs safe metadata only', async () => {
    const { binding } = bind(
      { languages: ['en'] },
      {
        resolvePacks: () => {
          throw new Error('SENTINEL_START_TEXT');
        },
      },
    );

    await expect(startSearchBackground(binding)).resolves.toBeUndefined();

    expect(JSON.stringify(harness.logged)).not.toContain('SENTINEL_START_TEXT');
    expect(binding.service.packState()).toBe('failed');
  });
});
