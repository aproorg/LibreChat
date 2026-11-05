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

  it('with default config loads no pack and answers null everywhere', async () => {
    const resolvePacks = jest.fn();
    const { binding } = bind(undefined, { resolvePacks });

    await startSearchBackground(binding);

    expect(resolvePacks).not.toHaveBeenCalled();
    expect(harness.logged.filter(({ event }) => event === 'search.pack')).toEqual([]);
    expect(binding.service.isServing()).toBe(false);
    expect(await binding.enabled()).toBeNull();
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
