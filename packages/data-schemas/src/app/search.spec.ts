import { configSchema } from 'librechat-data-provider';
import type { DeepPartial, TCustomConfig } from 'librechat-data-provider';
import type { AppConfig, IConfig } from '~/types';
import { mergeConfigOverrides } from './resolution';
import { loadSearchConfig } from './search';
import { AppService } from './service';
import logger from '~/config/winston';

jest.mock('~/config/winston', () => ({
  __esModule: true,
  default: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const asConfig = (search: unknown) => ({ search }) as DeepPartial<TCustomConfig>;

describe('loadSearchConfig', () => {
  const errorSpy = logger.error as jest.Mock;

  beforeEach(() => {
    errorSpy.mockClear();
  });

  it('gives the default-off configuration when the block is omitted', () => {
    const search = loadSearchConfig({});
    expect(search.data).toBe(false);
    expect(search.backend).toBe('meilisearch');
    expect(search.meiliResyncPending).toBe(false);
    expect(search.sidebarLimit).toBe(1000);
    expect(search.jobs).toEqual({
      batchSize: 200,
      batchDelayMs: 1000,
      vocabCopyBatchSize: 5000,
      backfillOnStart: false,
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('applies defaults under a partial block, including partial nested blocks', () => {
    const search = loadSearchConfig(asConfig({ data: true, jobs: { batchSize: 5 } }));
    expect(search.data).toBe(true);
    expect(search.jobs).toEqual({
      batchSize: 5,
      batchDelayMs: 1000,
      vocabCopyBatchSize: 5000,
      backfillOnStart: false,
    });
    expect(search.typo.maxCorrections).toBe(8);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs a configuration error for backend search with data off, keeping the values', () => {
    const search = loadSearchConfig(asConfig({ backend: 'search' }));
    expect(search.backend).toBe('search');
    expect(search.data).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('search.data');
  });

  it('accepts backend search with data on', () => {
    loadSearchConfig(asConfig({ backend: 'search', data: true }));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('no longer accepts the removed shadow backend', () => {
    const search = loadSearchConfig(asConfig({ backend: 'shadow', data: true }));
    expect(search.backend).toBe('meilisearch');
    expect(search.data).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the defaults on an invalid block that passed the file schema', () => {
    const search = loadSearchConfig(asConfig({ backend: 'elastic', data: true }));
    expect(search.backend).toBe('meilisearch');
    expect(search.data).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('AppService search config', () => {
  it('adds nothing to a serialized app config when the block is omitted', async () => {
    const appConfig = await AppService({ config: {} });
    expect(JSON.parse(JSON.stringify(appConfig))).not.toHaveProperty('search');
  });

  it('applies the defaults under a present block', async () => {
    const appConfig = await AppService({ config: asConfig({}) });
    expect(appConfig.search).toEqual(loadSearchConfig({}));
  });

  it('carries the block from a full config', async () => {
    const config = configSchema.parse({
      version: '1.3.0',
      search: { data: true, backend: 'search' },
    });
    const appConfig = await AppService({ config: config as DeepPartial<TCustomConfig> });
    expect(appConfig.search?.backend).toBe('search');
    expect(appConfig.search?.data).toBe(true);
  });

  it('does not fail startup on a cross-field mismatch', async () => {
    await expect(AppService({ config: asConfig({ backend: 'search' }) })).resolves.toBeDefined();
  });
});

describe('stored config documents', () => {
  const stored = (overrides: unknown, tombstones?: string[]) =>
    ({
      principalType: 'role',
      principalId: 'ADMIN',
      principalModel: 'Role',
      priority: 10,
      overrides,
      tombstones,
      isActive: true,
      configVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as unknown as IConfig;

  it('cannot change search, by override or by tombstone', async () => {
    const base = (await AppService({ config: asConfig({ data: true }) })) as AppConfig;
    const before = JSON.parse(JSON.stringify(base.search));

    const merged = mergeConfigOverrides(base, [
      stored({ search: { backend: 'search', data: false } }, ['search.data', 'search']),
    ]);

    expect(merged.search).toEqual(before);
  });
});
