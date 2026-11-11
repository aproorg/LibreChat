import type { SearchStreamBatch } from '@librechat/data-schemas';
import type { SearchHarness } from '../__tests__/helpers/harness';
import type { SyncProcess } from './__tests__/helpers/sync';
import {
  createSyncProcess,
  eventsOf,
  oid,
  recordOf,
  sources,
  synced,
  waitFor,
} from './__tests__/helpers/sync';
import {
  recordCount,
  stateOf,
  storeSources,
  withMethods,
  writerSaved,
} from '../jobs/__tests__/helpers/jobs';
import {
  createSearchHarness,
  sourceConversation,
  sourceMessage,
} from '../__tests__/helpers/harness';
import { computeAnalyzerVersion } from '../analyzer/version';
import { runSearchJobCommand } from '../jobs/script';

/** T100: §9's list and quickstart §5, against a real change stream. */
describe('search sync writer', () => {
  let harness: SearchHarness;
  let proc: SyncProcess | null = null;

  const messages = () => sources(harness, 'messages');
  const conversations = () => sources(harness, 'conversations');
  const insertMessage = async (fields: Record<string, unknown>) => {
    const row = sourceMessage(fields);
    await messages().insertOne({ ...row, _id: oid(String(row._id)) });
    return String(row._id);
  };
  const tokensOf = async (name: 'msearch' | 'csearch', id: string) =>
    ((await recordOf(harness, name, id))?.tokens as string[] | undefined) ?? null;
  const startWriter = async (overrides: Parameters<typeof createSyncProcess>[1] = {}) => {
    proc = createSyncProcess(harness, overrides);
    await proc.start();
    await synced(harness);
    return proc;
  };

  beforeAll(async () => {
    harness = await createSearchHarness({ replSet: true });
  }, 120_000);

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  afterEach(async () => {
    await proc?.stop();
    proc = null;
  });

  it('indexes an insert, with the writer epoch, and only into search collections', async () => {
    await startWriter();
    const id = await insertMessage({ text: 'kerfi word' });
    await synced(harness);

    const record = await recordOf(harness, 'msearch', id);
    expect(record).toMatchObject({ user: 'user-a', conversationId: 'convo-a', e: 1 });
    expect(record?.tokens).toEqual(expect.arrayContaining(['kerfi', 'word']));
    expect(JSON.stringify(record)).not.toContain('kerfi word');
    const names = (await harness.database.connection.db!.listCollections().toArray())
      .map(({ name }) => name)
      .sort();
    expect(names).toEqual(['csearch', 'messages', 'msearch', 'search_state', 'search_vocab']);
    /* What `status` shows as `last change`: proof that the stream delivers. */
    expect((await stateOf(harness, 'stream'))?.lastEventAt).toBeInstanceOf(Date);
  });

  it('rewrites a record on an edit, and writes nothing on a metadata-only update', async () => {
    const replace = jest.fn(harness.methods.replaceSearchRecords);
    await startWriter({ methods: withMethods(harness, { replaceSearchRecords: replace }) });
    const id = await insertMessage({ text: 'first word' });
    await synced(harness);
    const before = await recordOf(harness, 'msearch', id);

    await messages().updateOne({ _id: oid(id) }, { $set: { text: 'second word' } });
    await synced(harness);
    const edited = await recordOf(harness, 'msearch', id);
    expect(edited?.tokens).toEqual(expect.arrayContaining(['second']));
    expect(edited?.h).not.toBe(before?.h);

    const writes = replace.mock.calls.flatMap(([, records]) => records).length;
    const analyzed = jest.spyOn(harness.analyzer, 'analyzeMessage');
    await messages().updateOne({ _id: oid(id) }, { $set: { feedback: { rating: 'up' } } });
    await synced(harness);
    expect(replace.mock.calls.flatMap(([, records]) => records)).toHaveLength(writes);
    expect(await recordOf(harness, 'msearch', id)).toEqual(edited);
    /* An unchanged row is told from its stored stamp, before any analysis. */
    expect(analyzed).not.toHaveBeenCalled();
    analyzed.mockRestore();
  });

  it('indexes a bulkWrite import in batches', async () => {
    await startWriter();
    const rows = Array.from({ length: 60 }, (_, index) =>
      sourceMessage({ text: `import word${index}` }),
    );
    await messages().bulkWrite(
      rows.map((row) => ({ insertOne: { document: { ...row, _id: oid(String(row._id)) } } })),
    );
    await synced(harness);

    expect(await recordCount(harness, 'msearch')).toBe(60);
    expect(eventsOf(harness, 'search.sync_lag').length).toBeGreaterThan(0);
  });

  it('reads an import larger than the batch cap in more than one batch', async () => {
    const seen: SearchStreamBatch[] = [];
    const watch = harness.methods.watchSearchSources;
    await startWriter({
      methods: withMethods(harness, {
        watchSearchSources: async function* (params) {
          for await (const batch of watch(params)) {
            seen.push(batch);
            yield batch;
          }
        },
      }),
    });
    const rows = Array.from({ length: 600 }, (_, index) => sourceMessage({ text: `w${index}` }));
    await messages().insertMany(rows.map((row) => ({ ...row, _id: oid(String(row._id)) })));
    await synced(harness);

    const withEvents = seen.filter(({ events }) => events.length > 0);
    expect(withEvents.length).toBeGreaterThan(1);
    expect(withEvents.every(({ events }) => events.length <= 500)).toBe(true);
    expect(await recordCount(harness, 'msearch')).toBe(600);
  });

  it('removes records on an updateMany to temporary, and on a single temporary flip and back', async () => {
    await startWriter();
    const ids = await Promise.all(['one', 'two', 'three'].map((text) => insertMessage({ text })));
    await synced(harness);
    expect(await recordCount(harness, 'msearch')).toBe(3);

    await messages().updateOne(
      { _id: oid(ids[0]) },
      { $set: { isTemporary: true, expiredAt: new Date(Date.now() + 1e6) } },
    );
    await synced(harness);
    expect(await recordOf(harness, 'msearch', ids[0])).toBeNull();

    await messages().updateOne(
      { _id: oid(ids[0]) },
      { $set: { isTemporary: false }, $unset: { expiredAt: '' } },
    );
    await synced(harness);
    expect(await recordOf(harness, 'msearch', ids[0])).not.toBeNull();

    await messages().updateMany(
      {},
      { $set: { isTemporary: true, expiredAt: new Date(Date.now() + 1e6) } },
    );
    await synced(harness);
    expect(await recordCount(harness, 'msearch')).toBe(0);
  });

  it('follows a title edit, a tag rename and a tag deletion', async () => {
    await startWriter();
    const convo = sourceConversation({ title: 'kerfi', tags: ['alpha'] });
    const id = String(convo._id);
    await conversations().insertOne({ ...convo, _id: oid(id) });
    await synced(harness);
    expect(await tokensOf('csearch', id)).toEqual(expect.arrayContaining(['kerfi', 'alpha']));

    await conversations().updateOne({ _id: oid(id) }, { $set: { title: 'renamed' } });
    await conversations().updateOne({ _id: oid(id) }, { $set: { 'tags.0': 'beta' } });
    await synced(harness);
    const renamed = await tokensOf('csearch', id);
    expect(renamed).toEqual(expect.arrayContaining(['renamed', 'beta']));
    expect(renamed).not.toContain('alpha');

    await conversations().updateOne({ _id: oid(id) }, { $pull: { tags: 'beta' } as never });
    await synced(harness);
    expect(await tokensOf('csearch', id)).not.toContain('beta');
  });

  it('keeps subagent and unfinished messages out, and indexes a message once it finishes', async () => {
    await startWriter();
    const subagent = await insertMessage({ text: 'subagent', subagentTask: { id: 'task' } });
    const streaming = await insertMessage({ text: 'partial', unfinished: true });
    await synced(harness);
    expect(await recordOf(harness, 'msearch', subagent)).toBeNull();
    expect(await recordOf(harness, 'msearch', streaming)).toBeNull();

    await messages().updateOne(
      { _id: oid(streaming) },
      { $set: { unfinished: false, text: 'finished answer' } },
    );
    await synced(harness);
    expect(await tokensOf('msearch', streaming)).toEqual(expect.arrayContaining(['finished']));
  });

  it('removes records on an external deleteMany', async () => {
    await startWriter();
    await Promise.all(['one', 'two'].map((text) => insertMessage({ text })));
    await synced(harness);
    expect(await recordCount(harness, 'msearch')).toBe(2);

    await messages().deleteMany({});
    await synced(harness);
    expect(await recordCount(harness, 'msearch')).toBe(0);
  });

  it('resumes after a restart from the saved position, with no gap', async () => {
    const first = await startWriter();
    await insertMessage({ text: 'before' });
    await synced(harness);
    await first.stop();
    proc = null;

    const missed = await insertMessage({ text: 'while stopped' });
    const edited = await insertMessage({ text: 'edited before' });
    await messages().updateOne({ _id: oid(edited) }, { $set: { text: 'edited after' } });

    await startWriter();
    await synced(harness);
    expect(await recordOf(harness, 'msearch', missed)).not.toBeNull();
    expect(await tokensOf('msearch', edited)).toEqual(expect.arrayContaining(['after']));
    expect(eventsOf(harness, 'search.sync_gap')).toEqual([]);
  });

  it('removes the record of a message the TTL monitor deletes', async () => {
    const db = harness.database.connection.db!;
    await db.admin().command({ setParameter: 1, ttlMonitorSleepSecs: 1 });
    await messages().createIndex({ expiredAt: 1 }, { expireAfterSeconds: 0 });
    await startWriter();
    const id = await insertMessage({
      text: 'kept a while',
      isTemporary: false,
      expiredAt: new Date(Date.now() + 1500),
    });
    await synced(harness);
    expect(await recordOf(harness, 'msearch', id)).not.toBeNull();

    await waitFor(async () => (await messages().countDocuments({ _id: oid(id) })) === 0, {
      label: 'the TTL monitor',
    });
    await synced(harness);
    expect(await recordOf(harness, 'msearch', id)).toBeNull();
  }, 60_000);

  it('treats an update whose row is gone by lookup time as a delete', async () => {
    const seen: SearchStreamBatch[] = [];
    const watch = harness.methods.watchSearchSources;
    const recorded = withMethods(harness, {
      watchSearchSources: async function* (params) {
        for await (const batch of watch(params)) {
          seen.push(batch);
          yield batch;
        }
      },
    });
    const first = await startWriter({ methods: recorded });
    const id = await insertMessage({ text: 'short lived' });
    await synced(harness);
    await first.stop();
    proc = null;

    await messages().updateOne({ _id: oid(id) }, { $set: { text: 'changed' } });
    await messages().deleteOne({ _id: oid(id) });
    seen.length = 0;
    await startWriter({ methods: recorded });
    await synced(harness);

    const events = seen.flatMap(({ events: batch }) => batch).filter((event) => 'id' in event);
    expect(events.filter((event) => event.type !== 'meili' && event.id === id)).toEqual([
      expect.objectContaining({ type: 'delete', id }),
      expect.objectContaining({ type: 'delete', id }),
    ]);
    expect(await recordOf(harness, 'msearch', id)).toBeNull();
  });

  it('treats a replace event as a full change', async () => {
    await startWriter();
    const row = sourceMessage({ text: 'original words' });
    const id = String(row._id);
    await messages().insertOne({ ...row, _id: oid(id) });
    await synced(harness);

    await messages().replaceOne({ _id: oid(id) }, { ...row, _id: oid(id), text: 'replaced' });
    await synced(harness);
    const tokens = await tokensOf('msearch', id);
    expect(tokens).toContain('replaced');
    expect(tokens).not.toContain('original');
  });

  describe('the analyzer at start', () => {
    const analyzerState = () => stateOf(harness, 'analyzer');
    const version = () => computeAnalyzerVersion(harness.packs);
    const requests = () => harness.methods.listSearchJobRequests();

    it('writes a baseline on a first start, and queues nothing', async () => {
      await startWriter();

      expect(await analyzerState()).toMatchObject({ version: version() });
      expect(await requests()).toEqual([]);
    });

    it('queues nothing on a token change before a chain has finished', async () => {
      await harness.methods.writeSearchState('analyzer', { version: 'older' });
      await storeSources(harness, 'messages', [sourceMessage({ text: 'kerfi' })]);
      await harness.methods.writeSearchState('chain', { step: 'backfill' });

      await startWriter();

      expect(await analyzerState()).toMatchObject({ version: version() });
      expect((await requests()).filter(({ job }) => job === 'reconcile')).toEqual([]);
    });

    it('queues reconcile on a token change once a chain has finished and records exist', async () => {
      await storeSources(harness, 'messages', [sourceMessage({ text: 'kerfi' })]);
      proc = createSyncProcess(harness);
      /* The chain's verify needs a saved position, and the writer has not started yet. */
      await writerSaved(harness);
      await runSearchJobCommand({
        argv: ['backfill'],
        methods: harness.methods,
        print: () => undefined,
      });
      for (let round = 0; round < 3; round += 1) {
        await proc.runner.tick();
        await proc.runner.idle();
      }
      await proc.runner.stop();
      /* Back to no stream state, so `synced` below waits for this writer and not the stand-in. */
      await harness.methods.deleteSearchState('stream');
      await harness.methods.writeSearchState('analyzer', { version: 'older' });

      await startWriter();

      const reconcile = (await requests()).filter(({ job }) => job === 'reconcile');
      expect(reconcile.map(({ _id }) => _id)).toContain(`jobRequest:analyzer-${version()}`);
    });

    it('queues reconcile on a token change while the chain is at its verify step', async () => {
      await startWriter();
      await insertMessage({ text: 'kerfi' });
      await synced(harness);
      await proc?.stop();
      /* The chain's reconcile walk is over, so only a new reconcile can rewrite this record. */
      await harness.methods.writeSearchState('analyzer', { version: 'older' });
      await harness.methods.writeSearchState('chain', { step: 'verify' });

      await startWriter();

      const reconcile = (await requests()).filter(({ job }) => job === 'reconcile');
      expect(reconcile.map(({ _id }) => _id)).toContain(`jobRequest:analyzer-${version()}`);
    });

    it('records attribution, and keeps a removed pack’s until reconcile clears it', async () => {
      await harness.methods.writeSearchState('analyzer', {
        version: version(),
        packs: [
          { id: 'gone', attribution: { text: 'Gone data', url: 'https://example.org/gone' } },
        ],
      });
      const attributed = harness.packs.map((pack, index) =>
        index === 0
          ? { ...pack, attribution: { text: 'Fake data', url: 'https://example.org/fake' } }
          : pack,
      );

      await startWriter({
        service: {
          jobAnalyzer: () => ({
            analyzer: harness.analyzer,
            version: version(),
            packs: attributed,
          }),
        },
      });

      const state = await analyzerState();
      expect(state?.packs).toEqual(
        expect.arrayContaining([
          {
            id: attributed[0].id,
            attribution: { text: 'Fake data', url: 'https://example.org/fake' },
          },
        ]),
      );
      expect(state?.attributionUntilReanalyzed).toEqual([
        { id: 'gone', attribution: { text: 'Gone data', url: 'https://example.org/gone' } },
      ]);
    });
  });
});
