import {
  DEFAULT_MEILI_SYNC_THRESHOLD,
  isMeiliSyncCaughtUp,
  meiliSyncThreshold,
  isMeiliConfigured,
  isSearchEnvOn,
} from './meili';

describe('isMeiliConfigured', () => {
  it.each([
    [{ MEILI_HOST: 'http://meili.test:7700', MEILI_MASTER_KEY: 'key' }, true],
    [{ MEILI_HOST: 'http://meili.test:7700' }, false],
    [{ MEILI_MASTER_KEY: 'key' }, false],
    [{ MEILI_HOST: '', MEILI_MASTER_KEY: 'key' }, false],
    [{ MEILI_HOST: 'http://meili.test:7700', MEILI_MASTER_KEY: '' }, false],
    [{}, false],
  ])('%j is %s', (env, expected) => {
    expect(isMeiliConfigured(env)).toBe(expected);
  });

  it('does not depend on SEARCH, which the caller checks on its own', () => {
    const env = { SEARCH: 'false', MEILI_HOST: 'http://meili.test:7700', MEILI_MASTER_KEY: 'key' };
    expect(isMeiliConfigured(env)).toBe(true);
    expect(isSearchEnvOn(env)).toBe(false);
    expect(isSearchEnvOn({ SEARCH: 'true' })).toBe(true);
    expect(isSearchEnvOn({})).toBe(false);
  });
});

describe('meiliSyncThreshold', () => {
  it.each([
    [undefined, DEFAULT_MEILI_SYNC_THRESHOLD],
    ['', DEFAULT_MEILI_SYNC_THRESHOLD],
    ['250', 250],
    ['0', 0],
    ['nonsense', DEFAULT_MEILI_SYNC_THRESHOLD],
    ['-5', DEFAULT_MEILI_SYNC_THRESHOLD],
  ])('%s gives %s', (value, expected) => {
    expect(meiliSyncThreshold({ MEILI_SYNC_THRESHOLD: value })).toBe(expected);
  });

  it('defaults to the number indexSync uses', () => {
    expect(DEFAULT_MEILI_SYNC_THRESHOLD).toBe(1000);
  });
});

describe('isMeiliSyncCaughtUp', () => {
  const progress = (fields: object = {}) => ({
    totalProcessed: 100,
    totalDocuments: 100,
    pendingIndexing: 0,
    pendingCleanup: 0,
    ...fields,
  });

  it.each([
    ['everything processed', progress(), true],
    ['unprocessed at the threshold', progress({ totalDocuments: 110 }), true],
    ['unprocessed past the threshold', progress({ totalDocuments: 111 }), false],
    ['indexing pending', progress({ pendingIndexing: 1 }), false],
    ['cleanup pending', progress({ pendingCleanup: 1 }), false],
    ['no pending figures reported', { totalProcessed: 5, totalDocuments: 5 }, true],
  ])('%s: %j is %s', (_name, entry, expected) => {
    expect(isMeiliSyncCaughtUp(entry, 10)).toBe(expected);
  });

  it('does not read isComplete, which one aborted message leaves false for good', () => {
    const entry = { ...progress({ totalDocuments: 101 }), isComplete: false };
    expect(isMeiliSyncCaughtUp(entry, 10)).toBe(true);
  });
});
