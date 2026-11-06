import type { SearchHarness } from '../__tests__/helpers/harness';
import { createSearchHarness, searchConfig } from '../__tests__/helpers/harness';
import { createSearchConfigSnapshot } from '../config';
import { createSearchService } from '../service';
import { createSearchStatus } from './status';

describe('createSearchStatus', () => {
  let harness: SearchHarness;
  let now: number;

  const status = async (search: Parameters<typeof searchConfig>[0] = {}, load = true) => {
    const service = createSearchService({
      config: createSearchConfigSnapshot({ search: searchConfig(search) }),
      methods: harness.methods,
      metrics: harness.metrics,
      logger: harness.logger,
      cursorSecret: 'secret',
      resolvePacks: () => ({ ok: true, packs: harness.packs }),
    });
    if (load) {
      await service.loadPacks();
    }
    return createSearchStatus({
      service,
      methods: harness.methods,
      logger: harness.logger,
      now: () => now,
    });
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

  it.each(['meilisearch', 'shadow'] as const)(
    'answers null on %s, so the route keeps today’s check, reading nothing',
    async (backend) => {
      const read = jest.spyOn(harness.methods, 'readSearchState');
      const created = await status({ backend });
      expect(await created.enabled()).toBeNull();
      expect(read).not.toHaveBeenCalled();
    },
  );

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
    });
    expect(await created.enabled()).toBe(false);
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
});
