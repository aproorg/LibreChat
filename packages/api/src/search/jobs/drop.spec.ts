import { getTenantId, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import type { SearchHarness } from '../__tests__/helpers/harness';
import { createSearchHarness, sourceMessage } from '../__tests__/helpers/harness';
import { storeSources, withMethods } from './__tests__/helpers/jobs';
import { dropSearchData } from './drop';

const SEARCH_COLLECTIONS = ['csearch', 'msearch', 'search_state', 'search_vocab'];

/** T103: `drop` removes the four search collections only, and refuses while search data is on. */
describe('dropSearchData', () => {
  let harness: SearchHarness;
  const NOW = Date.parse('2026-06-01T12:00:00Z');
  const now = () => NOW;

  const collections = async () =>
    (await harness.database.connection.db!.listCollections().toArray()).map(({ name }) => name);
  const searchCollections = async () =>
    (await collections()).filter((name) => SEARCH_COLLECTIONS.includes(name)).sort();

  beforeAll(async () => {
    harness = await createSearchHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  it('removes the four search collections and leaves every other one as it was', async () => {
    const db = harness.database.connection.db!;
    await storeSources(harness, 'messages', [sourceMessage({ text: 'kept' })]);
    await db.collection('conversations').insertOne({ conversationId: 'kept' });
    await db.collection('search_unrelated').insertOne({ kept: true });
    await harness.methods.writeSearchState('verification', { status: 'passed' });
    await harness.methods.incrementSearchVocab({ counts: [['word', 1]], run: null });

    const result = await dropSearchData({ methods: harness.methods, config: { data: false }, now });

    expect(result.ok && [...result.value.dropped].sort()).toEqual(SEARCH_COLLECTIONS);
    expect((await collections()).sort()).toEqual(['conversations', 'messages', 'search_unrelated']);
    expect(await db.collection('messages').countDocuments()).toBe(1);
    expect(await db.collection('conversations').countDocuments()).toBe(1);
    expect(await db.collection('search_unrelated').countDocuments()).toBe(1);
  });

  it('refuses while search data is on, reading and removing nothing', async () => {
    const readSearchState = jest.fn(harness.methods.readSearchState);
    const dropSearchCollections = jest.fn(harness.methods.dropSearchCollections);

    const result = await dropSearchData({
      methods: withMethods(harness, { readSearchState, dropSearchCollections }),
      config: { data: true },
      now,
    });

    expect(result).toEqual({ ok: false, error: { code: 'search_data_on' } });
    expect(readSearchState).not.toHaveBeenCalled();
    expect(dropSearchCollections).not.toHaveBeenCalled();
    expect(await searchCollections()).toEqual(SEARCH_COLLECTIONS);
  });

  it('refuses while a process holds the lease, and goes ahead once it has run out', async () => {
    await harness.methods.writeSearchState('lease', { leaseUntil: new Date(NOW + 1) });

    expect(
      await dropSearchData({ methods: harness.methods, config: { data: false }, now }),
    ).toEqual({ ok: false, error: { code: 'search_lease_held' } });
    expect(await searchCollections()).toEqual(SEARCH_COLLECTIONS);

    const later = await dropSearchData({
      methods: harness.methods,
      config: { data: false },
      now: () => NOW + 1,
    });

    expect(later.ok).toBe(true);
    expect(await searchCollections()).toEqual([]);
  });

  it('is safe to repeat, and creates nothing where search was never on', async () => {
    await harness.database.connection.db!.dropDatabase();

    expect(
      await dropSearchData({ methods: harness.methods, config: { data: false }, now }),
    ).toEqual({ ok: true, value: { dropped: [] } });
    expect(await collections()).toEqual([]);
  });

  it('runs in the system context', async () => {
    const seen: Array<string | undefined> = [];
    const methods = withMethods(harness, {
      readSearchState: async (...args) => {
        seen.push(getTenantId());
        return harness.methods.readSearchState(...args);
      },
      dropSearchCollections: async () => {
        seen.push(getTenantId());
        return [];
      },
    });

    await dropSearchData({ methods, config: { data: false }, now });

    expect(seen).toEqual([SYSTEM_TENANT_ID, SYSTEM_TENANT_ID]);
  });

  it('lets a failed drop reach the caller rather than report success', async () => {
    const methods = withMethods(harness, {
      dropSearchCollections: () => Promise.reject(new Error('drop failed')),
    });

    await expect(dropSearchData({ methods, config: { data: false }, now })).rejects.toThrow(
      'drop failed',
    );
  });
});
