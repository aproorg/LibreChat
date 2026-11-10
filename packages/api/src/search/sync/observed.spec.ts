import type { SearchHarness } from '../__tests__/helpers/harness';
import { createSearchHarness } from '../__tests__/helpers/harness';
import { checkObserved, recordObserved } from './observed';
import { stateOf } from '../jobs/__tests__/helpers/jobs';

type Observed = Parameters<typeof checkObserved>[0]['config'];

/** T115: readiness notices an abort or a stopped sync across restarts (FR-037). */
describe('observed config', () => {
  let harness: SearchHarness;
  let clock = Date.UTC(2026, 0, 1);
  const now = () => clock;

  /** One process start: the read in every process, then the upsert with data on. */
  const restart = async (config: Observed) => {
    clock += 1000;
    await checkObserved({ methods: harness.methods, config, now });
    if (config.data) {
      await harness.methods.ensureSearchCollections();
      await recordObserved({ methods: harness.methods, config, now });
    }
  };
  const invalidatedAt = async () => (await stateOf(harness, 'verification'))?.invalidatedAt;
  const collections = async () =>
    (await harness.database.connection.db!.listCollections().toArray()).map(({ name }) => name);

  beforeAll(async () => {
    harness = await createSearchHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.database.connection.db!.dropDatabase();
    harness.logged.length = 0;
  });

  it('a default tenant reads nothing back and writes nothing', async () => {
    await restart({ backend: 'meilisearch', data: false });
    await restart({ backend: 'meilisearch', data: false });

    expect(await collections()).toEqual([]);
  });

  it('start, restart, roll back: the rollback invalidates the pass', async () => {
    await restart({ backend: 'search', data: true });
    await harness.methods.writeSearchState('verification', {
      status: 'passed',
      passedAt: new Date(clock),
    });
    await restart({ backend: 'search', data: true });
    expect(await invalidatedAt()).toBeUndefined();

    await restart({ backend: 'meilisearch', data: true });

    expect(await invalidatedAt()).toEqual(new Date(clock));
    expect(await stateOf(harness, 'observed')).toMatchObject({ backend: 'meilisearch' });
  });

  it('from shadow to meilisearch invalidates too', async () => {
    await restart({ backend: 'shadow', data: true });
    await restart({ backend: 'meilisearch', data: true });

    expect(await invalidatedAt()).toEqual(new Date(clock));
  });

  it('data going off invalidates, and coming back on discards the stream position', async () => {
    await restart({ backend: 'search', data: true });
    await harness.methods.writeSearchState('stream', { resumeToken: { scope: 'database' } });

    await restart({ backend: 'search', data: false });
    expect(await invalidatedAt()).toEqual(new Date(clock));
    expect(await stateOf(harness, 'observed')).toMatchObject({ data: false });
    expect(await stateOf(harness, 'stream')).toMatchObject({ resumeToken: { scope: 'database' } });

    await restart({ backend: 'search', data: true });
    expect(await stateOf(harness, 'stream')).toMatchObject({ resumeToken: null });
  });

  it('a first start with data on writes the first value, and invalidates nothing', async () => {
    await restart({ backend: 'search', data: true });

    expect(await stateOf(harness, 'observed')).toMatchObject({ backend: 'search', data: true });
    expect(await stateOf(harness, 'verification')).toBeNull();
  });
});
