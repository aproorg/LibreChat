import { tenantStorage } from '@librechat/data-schemas';
import type { SearchHarness } from '../__tests__/helpers/harness';
import {
  createSearchHarness,
  sourceConversation,
  sourceMessage,
} from '../__tests__/helpers/harness';
import { createSyncProcess, oid, sources, synced } from '../sync/__tests__/helpers/sync';
import { createRunner, settle, stateOf, storeSources } from './__tests__/helpers/jobs';
import { runSearchJobCommand } from './script';

/** Its own file, because the strict flag is read once per process. */
describe('search jobs under TENANT_ISOLATION_STRICT', () => {
  const original = process.env.TENANT_ISOLATION_STRICT;
  let harness: SearchHarness;

  beforeAll(async () => {
    process.env.TENANT_ISOLATION_STRICT = 'true';
    harness = await createSearchHarness();
  });

  afterAll(async () => {
    await harness.close();
    if (original === undefined) {
      delete process.env.TENANT_ISOLATION_STRICT;
    } else {
      process.env.TENANT_ISOLATION_STRICT = original;
    }
  });

  it('every job runs with no request context, and records keep their source tenant', async () => {
    await harness.reset();
    await expect(harness.models.MessageSearch.find({}).lean()).rejects.toThrow();
    await storeSources(harness, 'messages', [
      sourceMessage({ text: 'kerfi', tenantId: 'tenant-one' }),
      sourceMessage({ text: 'kerfi' }),
    ]);
    await storeSources(harness, 'conversations', [
      sourceConversation({ title: 'kerfi', tenantId: 'tenant-one' }),
    ]);
    const runner = createRunner(harness);

    await runSearchJobCommand({
      argv: ['backfill'],
      methods: harness.methods,
      print: () => undefined,
    });
    await settle(runner);

    expect(await stateOf(harness, 'verification')).toMatchObject({ status: 'passed', missing: 0 });

    const messages = await tenantStorage.run({ tenantId: 'tenant-one' }, async () =>
      harness.models.MessageSearch.find({ user: 'user-a' }).lean(),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ tenantId: 'tenant-one' });
    const conversations = await tenantStorage.run({ tenantId: 'tenant-one' }, async () =>
      harness.models.ConversationSearch.find({ user: 'user-a' }).lean(),
    );
    expect(conversations).toHaveLength(1);

    const elsewhere = await tenantStorage.run({ tenantId: 'tenant-two' }, async () =>
      harness.models.MessageSearch.find({ user: 'user-a' }).lean(),
    );
    expect(elsewhere).toHaveLength(0);
  }, 60_000);

  it('the sync writer and reconcile run with no request context, and keep the source tenant', async () => {
    const replica = await createSearchHarness({ replSet: true });
    const proc = createSyncProcess(replica);
    try {
      await replica.reset();
      await proc.start();
      await synced(replica);
      const row = sourceMessage({ text: 'kerfi live', tenantId: 'tenant-one' });
      await sources(replica, 'messages').insertOne({ ...row, _id: oid(String(row._id)) });
      await synced(replica);

      const found = await tenantStorage.run({ tenantId: 'tenant-one' }, async () =>
        replica.models.MessageSearch.find({ user: 'user-a' }).lean(),
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ tenantId: 'tenant-one', e: 1 });

      await replica.database.connection.db!.collection('msearch').deleteMany({});
      await replica.methods.writeSearchState('chain', { step: 'verify', finishedAt: new Date() });
      await runSearchJobCommand({
        argv: ['reconcile'],
        methods: replica.methods,
        print: () => undefined,
      });
      await settle(proc.runner);
      const repaired = await tenantStorage.run({ tenantId: 'tenant-one' }, async () =>
        replica.models.MessageSearch.find({ user: 'user-a' }).lean(),
      );
      expect(repaired).toHaveLength(1);
      expect(repaired[0]).toMatchObject({ tenantId: 'tenant-one' });
    } finally {
      await proc.stop();
      await replica.close();
    }
  }, 120_000);
});
