import type { SearchHarness } from '../__tests__/helpers/harness';
import type { SyncProcess } from '../sync/__tests__/helpers/sync';
import type { LanguagePack } from './pack';
import {
  createSyncProcess,
  recordOf,
  sources,
  synced,
  waitFor,
  idFrom,
  oid,
} from '../sync/__tests__/helpers/sync';
import { settle, stateOf, storeSources, jobConfig } from '../jobs/__tests__/helpers/jobs';
import { createSearchHarness, sourceMessage } from '../__tests__/helpers/harness';
import { computeAnalyzerVersion } from '../analyzer/version';
import { runSearchJobCommand } from '../jobs/script';
import { createSearchStatus } from '../http/status';
import { createSearchService } from '../service';

const ATTRIBUTION = {
  text: 'Word forms from a throwaway test list.',
  url: 'https://example.com/words',
};
const ENDINGS = ['inna', 'um'];

/**
 * A stemmer for an invented language, written here and nowhere else: adding a language is one
 * pack, with no change to storage, reading or ranking. Its words mean nothing.
 */
const createThrowawayPack = (fields: Partial<LanguagePack> = {}): LanguagePack => ({
  id: 'tst',
  version: '1',
  kind: 'stemmer',
  stopWords: new Set<string>(),
  lemmas(word) {
    const ending = ENDINGS.find((suffix) => word.endsWith(suffix) && word.length > suffix.length);
    return ending ? [word.slice(0, -ending.length)] : [];
  },
  ...fields,
});

const SEARCH = { statusCacheSeconds: 1 };

/** T158: US4 scenarios 1 to 3, with real change streams. */
describe('re-analysis after the enabled packs change', () => {
  let harness: SearchHarness;
  let proc: SyncProcess | null = null;
  let en: LanguagePack;

  const request = (command: string) =>
    runSearchJobCommand({ argv: [command], methods: harness.methods, print: () => undefined });
  const context = () => ({
    user: 'user-a',
    signal: new AbortController().signal,
    startedAt: Date.now(),
  });

  /** One search service over these packs, as a process started with them enabled builds it. */
  const serviceWith = async (packs: LanguagePack[]) => {
    const service = createSearchService({
      config: jobConfig({ ...SEARCH, languages: packs.map(({ id }) => id) }),
      methods: harness.methods,
      metrics: harness.metrics,
      logger: harness.logger,
      cursorSecret: 'test-secret',
      resolvePacks: () => ({ ok: true, packs }),
    });
    await service.loadPacks();
    return service;
  };
  /** A restart: the last process stops, and one with these packs takes the lease and syncs. */
  const restartWith = async (packs: LanguagePack[]) => {
    await proc?.stop();
    const service = await serviceWith(packs);
    proc = createSyncProcess(harness, { search: SEARCH, service });
    await proc.start();
    await waitFor(
      async () => (await stateOf(harness, 'analyzer'))?.version === computeAnalyzerVersion(packs),
      { label: 'the writer to record its analyzer' },
    );
    return { service, runner: proc.runner };
  };
  /** A fresh service each time, so no earlier search's finished read answers this one. */
  const found = async (packs: LanguagePack[], query: string) => {
    const result = await (await serviceWith(packs)).searchMessages(context(), query);
    return (result?.hits ?? []).map(({ messageId }) => messageId);
  };
  const meta = (service: Awaited<ReturnType<typeof serviceWith>>) =>
    createSearchStatus({
      service,
      methods: harness.methods,
      logger: harness.logger,
      meili: { env: {} },
    }).meta();
  const backfill = async (runner: SyncProcess['runner']) => {
    await request('backfill');
    await settle(runner, 4);
    expect(await stateOf(harness, 'chain')).toMatchObject({ finishedAt: expect.any(Date) });
  };
  /** A message saved while the writer runs, as chat saves one. */
  const saveMessage = async (text: string) => {
    const id = idFrom(0);
    await sources(harness, 'messages').insertOne({
      ...sourceMessage({ text }),
      _id: oid(id),
      messageId: `m-${id}`,
    });
    await synced(harness);
    return id;
  };

  beforeAll(async () => {
    harness = await createSearchHarness({ replSet: true });
    en = harness.packs[1];
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

  it('a new pack’s tokens reach new messages at once, and older records when reconcile rewrites them', async () => {
    const before = [en];
    const after = [createThrowawayPack(), en];
    const older = sourceMessage({ text: 'plomfarinna' });
    const olderId = String(older._id);
    await storeSources(harness, 'messages', [older]);

    /* The tenant as it was: no pack for this language, every record from the older analyzer. */
    const first = await restartWith(before);
    await backfill(first.runner);
    expect(await recordOf(harness, 'msearch', olderId)).toMatchObject({
      v: computeAnalyzerVersion(before),
    });
    expect((await recordOf(harness, 'msearch', olderId))?.tokens).not.toContain('plomfar');

    /* The pack is enabled and the tenant restarts. The writer queues the re-analysis itself. */
    const second = await restartWith(after);
    expect((await harness.methods.listSearchJobRequests()).map(({ job }) => job)).toEqual([
      'reconcile',
    ]);

    /* Scenario 1: a message arriving now gets the new pack's tokens at once. */
    const newerId = await saveMessage('plomfarum');
    const newer = await recordOf(harness, 'msearch', newerId);
    expect(newer).toMatchObject({ v: computeAnalyzerVersion(after) });
    expect(newer?.tokens).toEqual(expect.arrayContaining(['plomfarum', 'plomfar']));

    /* Scenario 2, before the rewrite: the older record still matches by its exact form only. */
    expect(await recordOf(harness, 'msearch', olderId)).toMatchObject({
      v: computeAnalyzerVersion(before),
    });
    expect(await found(after, 'plomfarinna')).toContain(older.messageId);
    expect(await found(after, 'plomfarum')).toEqual([`m-${newerId}`]);

    /* Scenario 2, the rewrite: reconcile re-analyzes it, and the other form now finds it too. */
    await settle(second.runner, 4);
    expect(await stateOf(harness, 'reconcile')).toMatchObject({ status: 'finished', stale: 1 });
    const rewritten = await recordOf(harness, 'msearch', olderId);
    expect(rewritten).toMatchObject({ v: computeAnalyzerVersion(after) });
    expect(rewritten?.tokens).toEqual(expect.arrayContaining(['plomfarinna', 'plomfar']));
    expect((await found(after, 'plomfarum')).sort()).toEqual(
      [older.messageId, `m-${newerId}`].sort(),
    );
  }, 120_000);

  it('a removed pack’s attribution stays until reconcile has rewritten its records', async () => {
    const before = [createThrowawayPack({ attribution: ATTRIBUTION }), en];
    const after = [en];
    const older = sourceMessage({ text: 'plomfarinna' });
    const olderId = String(older._id);
    await storeSources(harness, 'messages', [older]);

    /* With the pack enabled, its attribution shows, and its tokens are in the records. */
    const first = await restartWith(before);
    await backfill(first.runner);
    expect(await meta(first.service)).toEqual({ attribution: ATTRIBUTION });
    expect((await recordOf(harness, 'msearch', olderId))?.tokens).toContain('plomfar');

    /* Scenario 3: the pack is disabled. Shared code names no language, so this comes from state. */
    const second = await restartWith(after);
    expect(second.service.jobAnalyzer()?.packs?.map(({ id }) => id)).toEqual(['en']);
    expect(await stateOf(harness, 'analyzer')).toMatchObject({
      attributionUntilReanalyzed: [{ id: 'tst', attribution: ATTRIBUTION }],
    });
    expect(await meta(second.service)).toEqual({ attribution: ATTRIBUTION });

    /* Until the rewrite, the record still carries the removed pack's tokens. */
    expect(await recordOf(harness, 'msearch', olderId)).toMatchObject({
      v: computeAnalyzerVersion(before),
    });
    expect(await found(after, 'plomfarinna')).toEqual([older.messageId]);

    /* Reconcile leaves no record from the older analyzer, and only then does it go. */
    await settle(second.runner, 4);
    const rewritten = await recordOf(harness, 'msearch', olderId);
    expect(rewritten).toMatchObject({ v: computeAnalyzerVersion(after) });
    expect(rewritten?.tokens).not.toContain('plomfar');
    expect((await stateOf(harness, 'analyzer'))?.attributionUntilReanalyzed).toBeNull();
    expect(await meta(second.service)).toEqual({});
    expect(await found(after, 'plomfarinna')).toEqual([older.messageId]);
  }, 120_000);
});
