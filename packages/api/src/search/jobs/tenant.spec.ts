import { tenantStorage } from '@librechat/data-schemas';
import type { SearchHarness } from '../__tests__/helpers/harness';
import {
  createSearchHarness,
  sourceConversation,
  sourceMessage,
} from '../__tests__/helpers/harness';
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
});
