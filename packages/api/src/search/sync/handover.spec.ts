import type { SearchHarness } from '../__tests__/helpers/harness';
import type { SyncProcess } from './__tests__/helpers/sync';
import {
  createSyncProcess,
  eventsOf,
  idFrom,
  oid,
  recordOf,
  sources,
  synced,
} from './__tests__/helpers/sync';
import {
  createSearchHarness,
  sourceConversation,
  sourceMessage,
} from '../__tests__/helpers/harness';
import { createRunner, settle, stateOf, storeSources } from '../jobs/__tests__/helpers/jobs';
import { runSearchJobCommand } from '../jobs/script';

/**
 * A tenant whose first backfill ran with no writer, as the first live test did: the chain has
 * finished, verification passed up to the backfill's position, and every message written since
 * has no record. The writer's first start must leave every source with its record.
 */
describe('the writer arriving on a backfilled tenant', () => {
  let harness: SearchHarness;
  let proc: SyncProcess | null = null;

  const request = (command: string) =>
    runSearchJobCommand({ argv: [command], methods: harness.methods, print: () => undefined });
  const messages = () => sources(harness, 'messages');
  /** Written after the backfill and before the writer, minted two minutes ago, past the age floor. */
  const writeWhileNoWriter = async (text: string, fields: Record<string, unknown> = {}) => {
    const row = sourceMessage({ text, ...fields });
    const id = idFrom(120_000);
    await messages().insertOne({ ...row, _id: oid(id), messageId: `m-${id}` });
    return id;
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

  it('backfill finished, writes while no writer ran, writer starts, verification passes over every source', async () => {
    /* 1. The first backfill, with no writer: the chain finishes and verification passes. */
    const early = [sourceMessage({ text: 'kerfi early' }), sourceMessage({ text: 'kerfi edited' })];
    await storeSources(harness, 'messages', [...early, sourceMessage({ text: 'kerfi deleted' })]);
    await storeSources(harness, 'conversations', [sourceConversation({ title: 'kerfi' })]);
    const backfillOnly = createRunner(harness);
    await request('backfill');
    await settle(backfillOnly, 4);
    await backfillOnly.stop();
    expect(await stateOf(harness, 'chain')).toMatchObject({ finishedAt: expect.any(Date) });
    expect(await stateOf(harness, 'verification')).toMatchObject({
      status: 'passed',
      mode: 'backfill',
    });

    /* 2. Chat goes on with no writer: new messages, an edit, a delete, a turn to temporary. */
    const added = await Promise.all(['one', 'two', 'three'].map((n) => writeWhileNoWriter(n)));
    const temporary = await writeWhileNoWriter('soon temporary');
    await messages().updateOne(
      { _id: oid(String(early[1]._id)) },
      { $set: { text: 'kerfi rewritten', updatedAt: new Date() } },
    );
    await messages().deleteOne({ text: 'kerfi deleted' });
    await messages().updateOne(
      { _id: oid(temporary) },
      { $set: { isTemporary: true, expiredAt: new Date(Date.now() + 1e6) } },
    );
    for (const id of added) {
      expect(await recordOf(harness, 'msearch', id)).toBeNull();
    }

    /* 3. The writer's first start: no saved position after a finished chain is a gap. */
    proc = createSyncProcess(harness);
    await proc.start();
    await synced(harness);
    expect(eventsOf(harness, 'search.sync_gap')).toEqual([
      { resumeFailed: false, restartedAt: expect.any(Number) },
    ]);
    const queued = await harness.methods.listSearchJobRequests();
    expect(queued.map(({ job }) => job)).toEqual(['reconcile']);

    /* 4. The lease holder runs the reconcile the gap queued. */
    await settle(proc.runner, 4);
    expect(await stateOf(harness, 'reconcile')).toMatchObject({
      status: 'finished',
      missing: 3,
      stale: 1,
      orphans: 1,
    });
    for (const id of added) {
      expect(await recordOf(harness, 'msearch', id)).not.toBeNull();
    }
    expect((await recordOf(harness, 'msearch', String(early[1]._id)))?.tokens).toContain(
      'rewritten',
    );

    /* 5. A message while the writer runs is indexed by the writer itself. */
    const live = await writeWhileNoWriter('written live');
    await synced(harness);
    expect(await recordOf(harness, 'msearch', live)).toMatchObject({ e: proc.lease.epoch() });

    /* 6. Verification now checks every source, with no backfill bound, and passes. */
    await request('verify');
    await settle(proc.runner, 4);
    const verification = await stateOf(harness, 'verification');
    expect(verification).toMatchObject({
      status: 'passed',
      mode: 'writer',
      missing: 0,
      orphans: 0,
      changedSinceBackfill: 0,
    });
    /* Messages: three backfilled less one deleted, four written with no writer, one live. One conversation. */
    expect(verification?.checked).toBe(8);
  });

  it('a verification before the reconcile catches up fails, and the mismatch loop mends it', async () => {
    await storeSources(harness, 'messages', [sourceMessage({ text: 'kerfi' })]);
    const backfillOnly = createRunner(harness);
    await request('backfill');
    await settle(backfillOnly, 4);
    await backfillOnly.stop();
    const missed = await writeWhileNoWriter('missed');
    /* The gap's reconcile request is dropped, as if an operator had cleared it. */
    proc = createSyncProcess(harness);
    await proc.start();
    await synced(harness);
    for (const { _id } of await harness.methods.listSearchJobRequests()) {
      await harness.methods.deleteSearchState(_id);
    }

    await request('verify');
    await settle(proc.runner, 1);
    expect(await stateOf(harness, 'verification')).toMatchObject({
      status: 'failed',
      mode: 'writer',
      missing: 1,
    });

    await settle(proc.runner, 4);
    expect(await recordOf(harness, 'msearch', missed)).not.toBeNull();
    expect(await stateOf(harness, 'verification')).toMatchObject({ status: 'passed', rounds: 2 });
  });
});
