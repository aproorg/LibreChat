import type { SearchHarness } from '../__tests__/helpers/harness';
import {
  createSearchHarness,
  sourceConversation,
  sourceMessage,
  searchConfig,
} from '../__tests__/helpers/harness';
import { recordCount, settle, stateOf, storeSources } from './__tests__/helpers/jobs';
import { readSearchJobStatus, runSearchJobCommand } from './script';
import { bindSearch, startSearchBackground } from '../start';

/** The whole path an operator takes: a started server, the script's request, search shown. */
describe('backfill chain, end to end', () => {
  let harness: SearchHarness;

  beforeAll(async () => {
    harness = await createSearchHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.database.connection.db!.dropDatabase();
  });

  it('fills the collections from the script request, and /enable turns true', async () => {
    await storeSources(harness, 'messages', [
      sourceMessage({ text: 'kerfi hello', conversationId: 'convo-a' }),
      sourceMessage({ text: 'kerfi again', conversationId: 'convo-a' }),
      sourceMessage({ text: 'other words', conversationId: 'convo-a' }),
      sourceMessage({
        text: 'hidden kerfi',
        conversationId: 'convo-a',
        isTemporary: true,
        expiredAt: new Date(Date.now() + 1e7),
      }),
      sourceMessage({ text: 'kerfi', user: 'user-b', conversationId: 'convo-b' }),
    ]);
    await storeSources(harness, 'conversations', [
      sourceConversation({ title: 'kerfi title', conversationId: 'convo-a' }),
      sourceConversation({ title: 'something', user: 'user-b', conversationId: 'convo-b' }),
    ]);

    const database = harness.database.connection.db!;
    const snapshot = async () => ({
      messages: await database.collection('messages').find().sort({ _id: 1 }).toArray(),
      conversations: await database.collection('conversations').find().sort({ _id: 1 }).toArray(),
    });
    const collectionNames = async () =>
      (await database.listCollections().toArray()).map(({ name }) => name);
    const sourcesBefore = await snapshot();
    const namesBefore = await collectionNames();

    const app = { locals: {} as Record<string, unknown> };
    const binding = bindSearch({
      app,
      appConfig: {
        search: searchConfig({
          languages: ['fake', 'en'],
          statusCacheSeconds: 1,
          jobs: { batchSize: 2, batchDelayMs: 1 },
        }),
      },
      methods: harness.methods,
      setSearchPort: () => undefined,
      jwtSecret: 'test-secret',
      logger: harness.logger,
      resolvePacks: () => ({ ok: true, packs: harness.packs }),
    });

    await startSearchBackground(binding);
    const jobs = binding.jobs()!;
    expect(jobs).not.toBeNull();
    expect(await binding.enabled()).toBe(false);

    const code = await runSearchJobCommand({
      argv: ['backfill'],
      methods: harness.methods,
      print: () => undefined,
    });
    expect(code).toBe(0);

    await settle(jobs, 4);

    /* The sources are untouched, and only search collections appeared. */
    expect(await snapshot()).toEqual(sourcesBefore);
    expect((await collectionNames()).filter((name) => !namesBefore.includes(name)).sort()).toEqual([
      'csearch',
      'msearch',
      'search_state',
      'search_vocab',
    ]);

    /* Records exist. */
    expect(await recordCount(harness, 'msearch')).toBe(4);
    expect(await recordCount(harness, 'csearch')).toBe(2);

    /* Indexes exist. */
    const db = harness.database.connection.db!;
    const messageIndexes = (await db.collection('msearch').indexes()).map(({ name }) => name);
    expect(messageIndexes).toContain('user_tokens_created');
    const titleIndexes = await db.collection('csearch').indexes();
    expect(titleIndexes.some(({ key }) => key.tokens === 1 && key.user === 1)).toBe(true);

    /* The word list is right. */
    const counts: Record<string, number> = {};
    for (const name of ['msearch', 'csearch']) {
      for (const { tokens } of await db.collection(name).find().toArray()) {
        for (const token of tokens as string[]) {
          counts[token] = (counts[token] ?? 0) + 1;
        }
      }
    }
    const words = await db.collection('search_vocab').find().toArray();
    expect(Object.fromEntries(words.map(({ _id, df }) => [String(_id), df]))).toEqual(counts);
    expect(counts.kerfi).toBe(4);

    /* Verification passes. */
    expect(await stateOf(harness, 'verification')).toMatchObject({ status: 'passed', missing: 0 });

    /* The operator can see it. */
    const status = await readSearchJobStatus(harness.methods);
    expect(status.chain.finishedAt).toBeInstanceOf(Date);
    expect(status.collections.messages).toMatchObject({
      status: 'finished',
      processed: 5,
      total: 5,
    });
    expect(status.verification).toMatchObject({ status: 'passed' });

    /* The cached `false` above expires, then `/enable` answers true with `backend: search`. */
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(binding.config.backend).toBe('search');
    expect(await binding.enabled()).toBe(true);

    /* And search finds it, for this user alone. */
    const hits = await binding.service.searchMessages(
      { user: 'user-a', signal: new AbortController().signal, startedAt: Date.now() },
      'kerfi',
    );
    expect(hits?.hits).toHaveLength(2);

    await jobs.stop();
  }, 60_000);
});
