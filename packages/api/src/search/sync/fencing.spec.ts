import { SearchStreamError } from '@librechat/data-schemas';
import type { SearchSourceEvent } from '@librechat/data-schemas';
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
import { recordCount, stateOf, withMethods } from '../jobs/__tests__/helpers/jobs';
import { createSearchHarness, sourceMessage } from '../__tests__/helpers/harness';
import { computeAnalyzerVersion } from '../analyzer/version';
import { applyChanges, lastChanges } from './apply';
import { startSyncStatus } from './writer';

/** T101: one writer at a time, and what a paused or failing one cannot do. */
describe('search sync fencing', () => {
  let harness: SearchHarness;
  const running: SyncProcess[] = [];

  const messages = () => sources(harness, 'messages');
  const version = () => computeAnalyzerVersion(harness.packs);
  const insertMessage = async (fields: Record<string, unknown>) => {
    const row = sourceMessage(fields);
    await messages().insertOne({ ...row, _id: oid(String(row._id)) });
    return String(row._id);
  };
  const start = async (overrides: Parameters<typeof createSyncProcess>[1] = {}) => {
    const proc = createSyncProcess(harness, overrides);
    running.push(proc);
    await proc.start();
    return proc;
  };
  const finishChain = () =>
    harness.methods.writeSearchState('chain', { step: 'verify', finishedAt: new Date() });
  const reconcileRequests = async () =>
    (await harness.methods.listSearchJobRequests()).filter(({ job }) => job === 'reconcile');
  const upsert = (id: string, text: string, at = Date.now()): SearchSourceEvent => ({
    type: 'upsert',
    collection: 'messages',
    id,
    at,
    source: { ...sourceMessage({ text }), _id: id },
  });
  const turn = (epoch: number, holds = () => true, replayBefore = 0) => ({
    epoch,
    replayBefore,
    holds,
  });
  const apply = (events: SearchSourceEvent[], epoch: number, overrides = {}) =>
    applyChanges(lastChanges(events), {
      methods: harness.methods,
      analyzer: harness.analyzer,
      version: version(),
      turn: turn(epoch),
      vocab: { add: () => undefined },
      ...overrides,
    });

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
    while (running.length > 0) {
      await running.pop()?.stop();
    }
  });

  it('a new process takes over within the configured time, and carries on from the saved position', async () => {
    const first = await start({ search: { syncTakeoverSeconds: 1 } });
    await synced(harness);
    await insertMessage({ text: 'before the pause' });
    await synced(harness);
    /* Paused: its heartbeat stops, so its lease runs out, but it never gives it up. */
    const pausedAt = Date.now();
    const second = createSyncProcess(harness, { search: { syncTakeoverSeconds: 1 } });
    running.push(second);
    await waitFor(async () => (await second.runner.tick(), second.lease.isHeld()), {
      label: 'the takeover',
    });
    const tookMs = Date.now() - pausedAt;
    expect(tookMs).toBeLessThan(1000 + 500);
    expect(second.lease.epoch()).toBe((first.lease.epoch() ?? 0) + 1);
    second.writer.start();

    const after = await insertMessage({ text: 'after the takeover' });
    await synced(harness);
    expect(await recordOf(harness, 'msearch', after)).toMatchObject({ e: 2 });
    expect(eventsOf(harness, 'search.lease')).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 'acquired', epoch: 2 })]),
    );
  });

  it('a paused writer cannot overwrite a newer record, even one replayed unchanged', async () => {
    const id = '0000000000000000000000a1';
    await apply([upsert(id, 'old words')], 1);
    await apply([upsert(id, 'new words')], 1);

    /* The new holder replays the same event: `h` is unchanged, and `e` still rises. */
    await applyChanges(lastChanges([upsert(id, 'new words', 0)]), {
      methods: harness.methods,
      analyzer: harness.analyzer,
      version: version(),
      turn: turn(2, () => true, Date.now()),
      vocab: { add: () => undefined },
    });
    expect(await recordOf(harness, 'msearch', id)).toMatchObject({ e: 2 });

    /* The paused writer wakes up still believing it holds epoch 1. */
    const stale = await apply([upsert(id, 'old words')], 1);
    expect(stale.written).toBe(0);
    expect(await recordOf(harness, 'msearch', id)).toMatchObject({
      e: 2,
      tokens: expect.arrayContaining(['new']),
    });
    await apply([{ type: 'delete', collection: 'messages', id, at: Date.now() }], 1);
    expect(await recordOf(harness, 'msearch', id)).not.toBeNull();
  });

  it('a write completed after losing the turn is corrected by the source check', async () => {
    const id = await insertMessage({ text: 'still here' });
    await messages().deleteOne({ _id: oid(id) });
    let checks = 0;

    const result = await applyChanges(lastChanges([upsert(id, 'resurrected')]), {
      methods: harness.methods,
      analyzer: harness.analyzer,
      version: version(),
      /* Held before the write, lost by the check after it. */
      turn: turn(1, () => (checks += 1) === 1),
      vocab: { add: () => undefined },
    });

    expect(result.lost).toBe(true);
    expect(await recordOf(harness, 'msearch', id)).toBeNull();
  });

  it('applies only the last event per row, and an edit survives its bookkeeping event', () => {
    const changes = lastChanges([
      upsert('0000000000000000000000b1', 'first'),
      upsert('0000000000000000000000b1', 'second'),
      { type: 'meili', collection: 'messages', id: '0000000000000000000000b1', at: 0 },
      { type: 'delete', collection: 'messages', id: '0000000000000000000000b2', at: 0 },
      upsert('0000000000000000000000b2', 'back'),
    ]);

    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      type: 'upsert',
      source: expect.objectContaining({ text: 'second' }),
    });
    expect(changes[1]).toMatchObject({ type: 'upsert', id: '0000000000000000000000b2' });
  });

  it('an edit and its `_meiliIndex: true` event in one batch still write the record', async () => {
    const first = await start();
    await synced(harness);
    const id = await insertMessage({ text: 'draft' });
    await synced(harness);
    await first.stop();
    running.pop();

    await messages().updateOne({ _id: oid(id) }, { $set: { text: 'final', _meiliIndex: false } });
    await messages().updateOne({ _id: oid(id) }, { $set: { _meiliIndex: true } });
    await start();
    await synced(harness);

    expect((await recordOf(harness, 'msearch', id))?.tokens).toContain('final');
  });

  it('skips `_meiliIndex: true` with no record read', async () => {
    const stamps = jest.fn(harness.methods.readSearchRecordStamps);
    await start({ methods: withMethods(harness, { readSearchRecordStamps: stamps }) });
    await synced(harness);
    const id = await insertMessage({ text: 'kerfi' });
    await synced(harness);
    const reads = stamps.mock.calls.length;

    await messages().updateOne({ _id: oid(id) }, { $set: { _meiliIndex: true } });
    await synced(harness);

    expect(stamps.mock.calls.length).toBe(reads);
  });

  it('skips a poison event with an IDs-only alarm, and writes the rest of its batch', async () => {
    const replace = harness.methods.replaceSearchRecords;
    let poison = '';
    await start({
      methods: withMethods(harness, {
        replaceSearchRecords: async (collection, records) => {
          if (records.some(({ _id }) => _id === poison)) {
            throw Object.assign(new Error('bad one'), { name: 'ValidationError' });
          }
          return replace(collection, records);
        },
      }),
    });
    await synced(harness);
    /* The poison row first, so its place in the batch decides nothing. */
    const rows = [sourceMessage({ text: 'bad one' }), sourceMessage({ text: 'good one' })];
    poison = String(rows[0]._id);
    await messages().insertMany(rows.map((row) => ({ ...row, _id: oid(String(row._id)) })));
    await synced(harness);

    expect(await recordOf(harness, 'msearch', String(rows[1]._id))).not.toBeNull();
    expect(await recordOf(harness, 'msearch', poison)).toBeNull();
    expect(eventsOf(harness, 'search.sync_skip')).toEqual([
      { id: poison, attempts: 3, code: 'write_failed' },
    ]);
    expect(JSON.stringify(harness.logged)).not.toContain('bad one');
  });

  it('a record the real write path rejects in validation is skipped, not retried forever', async () => {
    const replace = harness.methods.replaceSearchRecords;
    let poison = '';
    await start({
      methods: withMethods(harness, {
        /* Past the schema's token cap, so Mongoose itself refuses the write. */
        replaceSearchRecords: (collection, records) =>
          replace(
            collection,
            records.map((record) =>
              record._id === poison
                ? { ...record, tokens: Array.from({ length: 3001 }, (_, i) => `t${i}`) }
                : record,
            ),
          ),
      }),
    });
    await synced(harness);
    const rows = [sourceMessage({ text: 'too many' }), sourceMessage({ text: 'fine one' })];
    poison = String(rows[0]._id);
    await messages().insertMany(rows.map((row) => ({ ...row, _id: oid(String(row._id)) })));
    await synced(harness);

    expect(eventsOf(harness, 'search.sync_skip')).toEqual([
      { id: poison, attempts: 3, code: 'write_failed' },
    ]);
    expect(await recordOf(harness, 'msearch', String(rows[1]._id))).not.toBeNull();
  });

  it('a database outage during a batch ends the turn and retries it, skipping nothing', async () => {
    const replace = harness.methods.replaceSearchRecords;
    let failures = 8;
    await start({
      methods: withMethods(harness, {
        replaceSearchRecords: async (collection, records) => {
          if (records.length > 0 && failures > 0) {
            failures -= 1;
            throw new Error('connection reset');
          }
          return replace(collection, records);
        },
      }),
    });
    await synced(harness);
    const ids = await Promise.all(['one', 'two'].map((text) => insertMessage({ text })));
    await waitFor(async () => (await recordCount(harness, 'msearch')) === 2, {
      label: 'the retried batch',
    });

    expect(failures).toBe(0);
    expect(eventsOf(harness, 'search.sync_skip')).toEqual([]);
    for (const id of ids) {
      expect(await recordOf(harness, 'msearch', id)).not.toBeNull();
    }
  });

  it('a skipped event queues reconcile once a chain has finished', async () => {
    await finishChain();
    const replace = harness.methods.replaceSearchRecords;
    let poison = '';
    await start({
      methods: withMethods(harness, {
        replaceSearchRecords: async (collection, records) => {
          if (records.some(({ _id }) => _id === poison)) {
            throw Object.assign(new Error('invalid'), { name: 'ValidationError' });
          }
          return replace(collection, records);
        },
      }),
    });
    await synced(harness);
    const row = sourceMessage({ text: 'bad one' });
    poison = String(row._id);
    await messages().insertOne({ ...row, _id: oid(poison) });
    await synced(harness);

    expect(eventsOf(harness, 'search.sync_skip')).toEqual([
      { id: poison, attempts: 3, code: 'write_failed' },
    ]);
    expect((await reconcileRequests()).map(({ _id }) => _id)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^jobRequest:skip-/)]),
    );
  });

  it("a skip during the chain's reconcile step queues reconcile too", async () => {
    await harness.methods.writeSearchState('chain', { step: 'reconcile' });
    const replace = harness.methods.replaceSearchRecords;
    let poison = '';
    await start({
      methods: withMethods(harness, {
        replaceSearchRecords: async (collection, records) => {
          if (records.some(({ _id }) => _id === poison)) {
            throw Object.assign(new Error('invalid'), { name: 'ValidationError' });
          }
          return replace(collection, records);
        },
      }),
    });
    await synced(harness);
    const before = (await reconcileRequests()).length;
    const row = sourceMessage({ text: 'bad one' });
    poison = String(row._id);
    await messages().insertOne({ ...row, _id: oid(poison) });
    await synced(harness);

    expect((await reconcileRequests()).length).toBe(before + 1);
  });

  it("a gap during the chain's reconcile step queues reconcile, which waits for the chain", async () => {
    await harness.methods.writeSearchState('chain', { step: 'reconcile' });
    await start();
    await synced(harness);

    expect(eventsOf(harness, 'search.sync_gap')).toHaveLength(1);
    expect(await reconcileRequests()).toHaveLength(1);
  });

  it.each([
    ['an oversized event', 'oversized' as const, false],
    ['a resume failure', 'resume_failed' as const, true],
  ])(
    '%s counts as a gap: alarm, restart where the stream is, reconcile',
    async (_, code, resumeFailed) => {
      await finishChain();
      await harness.methods.writeSearchState('stream', {
        resumeToken: { scope: 'database', tokens: {} },
      });
      const watch = harness.methods.watchSearchSources;
      let failed = false;
      const resumes: unknown[] = [];
      await start({
        methods: withMethods(harness, {
          watchSearchSources: (params) => {
            resumes.push(params.resumeToken);
            if (!failed) {
              failed = true;
              throw new SearchStreamError(code);
            }
            return watch(params);
          },
        }),
      });
      await synced(harness);

      expect(resumes.slice(0, 2)).toEqual([{ scope: 'database', tokens: {} }, null]);
      expect(eventsOf(harness, 'search.sync_gap')).toEqual([
        { resumeFailed, restartedAt: expect.any(Number) },
      ]);
      expect(await reconcileRequests()).toHaveLength(1);
      const id = await insertMessage({ text: 'after the gap' });
      await synced(harness);
      expect(await recordOf(harness, 'msearch', id)).not.toBeNull();
    },
  );

  it('a saved position this watch mode cannot resume is a gap too', async () => {
    await finishChain();
    /* A position from the other watch mode can never be resumed here. */
    await harness.methods.writeSearchState('stream', {
      resumeToken: { scope: 'collections', tokens: { messages: { _data: '00' } } },
    });
    await start();
    await synced(harness);

    expect(eventsOf(harness, 'search.sync_gap')).toEqual([
      { resumeFailed: true, restartedAt: expect.any(Number) },
    ]);
    expect(await reconcileRequests()).toHaveLength(1);
  });

  it('a dropped source collection is a gap, and the stream carries on', async () => {
    await finishChain();
    await insertMessage({ text: 'kerfi' });
    await harness.database.connection.db!.collection('conversations').insertOne({ title: 'x' });
    await start();
    await synced(harness);

    await harness.database.connection.db!.collection('conversations').drop();
    await synced(harness);
    const id = await insertMessage({ text: 'after the drop' });
    await synced(harness);

    expect(eventsOf(harness, 'search.sync_gap').length).toBeGreaterThanOrEqual(2);
    expect(await recordOf(harness, 'msearch', id)).not.toBeNull();
  });

  it('with watch: collections, both collections sync, and an invalidate is a gap', async () => {
    await finishChain();
    await harness.database.connection.db!.collection('conversations').insertOne({ title: 'x' });
    await start({ search: { sync: { watch: 'collections' } } });
    await synced(harness);
    const id = await insertMessage({ text: 'per collection' });
    await synced(harness);
    expect(await recordOf(harness, 'msearch', id)).not.toBeNull();
    expect(await stateOf(harness, 'stream')).toMatchObject({
      resumeToken: { scope: 'collections' },
    });

    /* A collection stream is invalidated when its collection is dropped. */
    await harness.database.connection.db!.collection('conversations').drop();
    await synced(harness);
    const after = await insertMessage({ text: 'after the invalidate' });
    await synced(harness);

    expect(eventsOf(harness, 'search.sync_gap').length).toBeGreaterThanOrEqual(2);
    expect(await recordOf(harness, 'msearch', after)).not.toBeNull();
  });

  it('a stale writer cannot move the saved position back', async () => {
    expect(
      await harness.methods.saveSearchStreamState({ epoch: 2, fields: { resumeToken: { at: 2 } } }),
    ).toBe(true);
    expect(
      await harness.methods.saveSearchStreamState({ epoch: 1, fields: { resumeToken: { at: 1 } } }),
    ).toBe(false);
    expect(await stateOf(harness, 'stream')).toMatchObject({ epoch: 2, resumeToken: { at: 2 } });
  });

  it('a gap before any chain has finished alarms nothing and queues no reconcile', async () => {
    await harness.methods.writeSearchState('chain', { step: 'backfill' });
    await start();
    await synced(harness);

    expect(eventsOf(harness, 'search.sync_gap')).toEqual([]);
    expect(await reconcileRequests()).toEqual([]);
  });

  it('a second non-null tenantId stops the writer and alarms, writing nothing for it', async () => {
    const proc = await start();
    await synced(harness);
    const first = await insertMessage({ text: 'tenant one', tenantId: 'tenant-one' });
    await synced(harness);
    const second = await insertMessage({ text: 'tenant two', tenantId: 'tenant-two' });
    await waitFor(() => proc.writer.halted(), { label: 'the writer to stop' });

    expect(await recordOf(harness, 'msearch', first)).toMatchObject({ tenantId: 'tenant-one' });
    expect(await recordOf(harness, 'msearch', second)).toBeNull();
    expect(await stateOf(harness, 'analyzer')).toMatchObject({ tenantId: 'tenant-one' });
    expect(eventsOf(harness, 'search.sync_stop')).toEqual([{ code: 'tenant_mismatch' }]);
    expect(JSON.stringify(harness.logged)).not.toContain('tenant-two');
  });

  it('a stalled writer trips search.sync_status: an old save, and no holder', async () => {
    await harness.methods.writeSearchState('stream', { savedAt: new Date(Date.now() - 600_000) });
    await harness.methods.writeSearchState('lease', { leaseUntil: new Date(Date.now() - 1000) });
    const status = startSyncStatus({
      methods: harness.methods,
      metrics: harness.metrics,
      logger: harness.logger,
      isHolder: () => false,
    });
    await status.emit();
    status.stop();

    const [event] = eventsOf(harness, 'search.sync_status') as Array<{ savedAgeMs: number }>;
    expect(event).toMatchObject({ hasHolder: false, isHolder: false });
    expect(event.savedAgeMs).toBeGreaterThanOrEqual(600_000);
  });

  it('a process whose pack failed takes no lease and writes nothing', async () => {
    const proc = await start({ service: { jobAnalyzer: () => null } });
    await insertMessage({ text: 'kerfi' });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(proc.lease.isHeld()).toBe(false);
    expect(await recordCount(harness, 'msearch')).toBe(0);
    expect(await stateOf(harness, 'stream')).toBeNull();
  });

  it('stopping gives the lease up, so the next process starts at once', async () => {
    const first = await start();
    await synced(harness);
    await first.stop();
    running.pop();

    const next = createSyncProcess(harness);
    running.push(next);
    await next.runner.tick();
    expect(next.lease.isHeld()).toBe(true);
  });
});
