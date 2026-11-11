import mongoose from 'mongoose';
import { ContentTypes } from 'librechat-data-provider';
import type { SearchHarness } from '../__tests__/helpers/harness';
import {
  freeControl,
  objectId,
  recordCount,
  stateOf,
  storeSources,
  withMethods,
  writerSaved,
} from './__tests__/helpers/jobs';
import {
  createSearchHarness,
  sourceConversation,
  sourceMessage,
} from '../__tests__/helpers/harness';
import { computeAnalyzerVersion } from '../analyzer/version';
import { buildMessageRecord } from '../sync/record';
import { runVocabRebuild } from './vocabRebuild';
import { runReconcile } from './reconcile';
import { BACKFILL_KEYS } from './control';
import { runBackfill } from './backfill';
import { runVerify } from './verify';

describe('search jobs', () => {
  let harness: SearchHarness;

  const backfillDeps = (control = freeControl(), methods = harness.methods) => ({
    methods,
    analyzer: harness.analyzer,
    version: computeAnalyzerVersion(harness.packs),
    control,
    metrics: harness.metrics,
  });
  const verify = (methods = harness.methods) =>
    runVerify({
      methods,
      control: freeControl(),
      metrics: harness.metrics,
      version: computeAnalyzerVersion(harness.packs),
      round: 1,
    });
  const verification = () => stateOf(harness, 'verification');
  const lastEvent = (name: string) =>
    harness.logged.filter(({ event }) => event === name).pop()?.meta;
  const records = (name: 'msearch' | 'csearch') =>
    harness.database.connection.db!.collection(name).find().toArray();

  beforeAll(async () => {
    harness = await createSearchHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    await writerSaved(harness);
  });

  describe('backfill', () => {
    it('writes a record for each indexable source, and none for the rest', async () => {
      await storeSources(harness, 'messages', [
        sourceMessage({ text: 'first kerfi' }),
        sourceMessage({ text: 'second kerfi' }),
        sourceMessage({ text: 'third kerfi' }),
        sourceMessage({
          text: 'temporary',
          isTemporary: true,
          expiredAt: new Date(Date.now() + 1e6),
        }),
        sourceMessage({ text: 'streaming', unfinished: true }),
        sourceMessage({ text: 'subagent', subagentTask: { id: 'task' } }),
      ]);
      await storeSources(harness, 'conversations', [
        sourceConversation({ title: 'kerfi title' }),
        sourceConversation({ title: 'thread', subagentThread: { id: 'task' } }),
      ]);

      expect(await runBackfill(backfillDeps())).toBe('done');

      expect(await recordCount(harness, 'msearch')).toBe(3);
      expect(await recordCount(harness, 'csearch')).toBe(1);
      const finished = await stateOf(harness, BACKFILL_KEYS.messages);
      expect(finished).toMatchObject({ status: 'finished', processed: 6, total: 6 });
    });

    it('writes only to search collections, and leaves sources as they were', async () => {
      const row = sourceMessage({ text: 'kerfi' });
      await storeSources(harness, 'messages', [row]);
      const db = harness.database.connection.db!;
      const before = await db.collection('messages').find().toArray();

      await runBackfill(backfillDeps());

      expect(await db.collection('messages').find().toArray()).toEqual(before);
      const names = (await db.listCollections().toArray()).map(({ name }) => name);
      expect(names.filter((name) => /search|state|vocab/.test(name)).sort()).toEqual([
        'csearch',
        'msearch',
        'search_state',
        'search_vocab',
      ]);
    });

    it('resumes after a crash from its saved position, re-reading nothing behind it', async () => {
      await storeSources(
        harness,
        'messages',
        Array.from({ length: 6 }, (_, index) => sourceMessage({ text: `word${index}` })),
      );
      const insert = harness.methods.insertSearchRecords;
      let calls = 0;
      const crashing = withMethods(harness, {
        insertSearchRecords: async (...args) => {
          calls += 1;
          if (calls === 2) {
            throw new Error('connection lost');
          }
          return insert(...args);
        },
      });

      await expect(runBackfill(backfillDeps(freeControl(), crashing))).rejects.toThrow(
        'connection lost',
      );
      expect(await recordCount(harness, 'msearch')).toBe(2);
      expect(await stateOf(harness, BACKFILL_KEYS.messages)).toMatchObject({
        status: 'failed',
        processed: 2,
      });

      const read = jest.spyOn(harness.methods, 'readSearchSources');
      const resumed = withMethods(harness, { readSearchSources: read as never });
      expect(await runBackfill(backfillDeps(freeControl(), resumed))).toBe('done');

      expect(await recordCount(harness, 'msearch')).toBe(6);
      expect(read.mock.calls[0][0].afterId).toEqual(expect.any(String));
      expect(await stateOf(harness, BACKFILL_KEYS.messages)).toMatchObject({ processed: 6 });
      read.mockRestore();
    });

    it('never replaces a record already there: the one sync wrote wins', async () => {
      const row = sourceMessage({ text: 'kerfi' });
      await storeSources(harness, 'messages', [row]);
      await harness.methods.insertSearchRecords('messages', [
        {
          _id: String(row._id),
          user: 'user-a',
          conversationId: 'convo-a',
          messageId: String(row.messageId),
          createdAt: new Date(),
          n: 1,
          h: 'from-sync',
          v: 'sync',
          e: 7,
          tokens: ['fromsync'],
        },
      ]);

      await runBackfill(backfillDeps());

      const [record] = await records('msearch');
      expect(record).toMatchObject({ h: 'from-sync', e: 7 });
    });

    it.each([
      [
        'deleted',
        (db: mongoose.mongo.Db, _id: mongoose.Types.ObjectId) =>
          db.collection('messages').deleteOne({ _id }),
      ],
      [
        'turned temporary',
        (db: mongoose.mongo.Db, _id: mongoose.Types.ObjectId) =>
          db.collection('messages').updateOne({ _id }, { $set: { isTemporary: true } }),
      ],
    ])('leaves no record for a source %s after its batch was read', async (_name, change) => {
      const kept = sourceMessage({ text: 'stays' });
      const gone = sourceMessage({ text: 'goes' });
      await storeSources(harness, 'messages', [kept, gone]);
      const db = harness.database.connection.db!;
      const insert = harness.methods.insertSearchRecords;
      const changing = withMethods(harness, {
        insertSearchRecords: async (collection, batch) => {
          if (collection === 'messages') {
            await change(db, new mongoose.Types.ObjectId(String(gone._id)));
          }
          return insert(collection, batch);
        },
      });

      await runBackfill(backfillDeps(freeControl(), changing));

      expect((await records('msearch')).map(({ _id }) => String(_id))).toEqual([String(kept._id)]);
    });

    it('stops at a second tenant, before any of its rows is indexed', async () => {
      await storeSources(harness, 'messages', [
        sourceMessage({ text: 'kerfi', tenantId: 'tenant-one' }),
        sourceMessage({ text: 'kerfi' }),
        sourceMessage({ text: 'kerfi', tenantId: 'tenant-two' }),
        sourceMessage({ text: 'kerfi', tenantId: 'tenant-two' }),
      ]);

      await expect(runBackfill(backfillDeps())).rejects.toMatchObject({ name: 'TenantMismatch' });

      /* A batch is two rows: the first batch is written, the second holds the other tenant. */
      const written = await records('msearch');
      expect(written.map(({ tenantId }) => tenantId).filter(Boolean)).toEqual(['tenant-one']);
      expect(await stateOf(harness, 'analyzer')).toMatchObject({ tenantId: 'tenant-one' });
      expect(JSON.stringify(harness.logged)).not.toContain('tenant-two');
    });

    it('stops at a pause, saying so, and carries on from there', async () => {
      await storeSources(
        harness,
        'messages',
        Array.from({ length: 4 }, (_, index) => sourceMessage({ text: `word${index}` })),
      );

      const paused = await runBackfill(backfillDeps(freeControl({ stopAfter: 1, stop: 'paused' })));

      expect(paused).toBe('paused');
      expect(await recordCount(harness, 'msearch')).toBe(2);
      expect(await stateOf(harness, BACKFILL_KEYS.messages)).toMatchObject({
        status: 'paused',
        pausedReason: 'operator',
      });
      expect(lastEvent('search.backfill')).toMatchObject({
        status: 'paused',
        pausedReason: 'operator',
        processed: 2,
      });

      expect(await runBackfill(backfillDeps())).toBe('done');
      expect(await recordCount(harness, 'msearch')).toBe(4);
    });

    it('a stale holder does not mark failed a walk another holder owns', async () => {
      await storeSources(harness, 'messages', [sourceMessage({ text: 'kerfi' })]);
      let holds = true;
      const failing = withMethods(harness, {
        insertSearchRecords: async () => {
          holds = false;
          await harness.methods.writeSearchState(BACKFILL_KEYS.messages, { status: 'finished' });
          throw new Error('stalled write failed');
        },
      });
      const control = { ...freeControl(), holds: () => holds };

      await expect(runBackfill(backfillDeps(control, failing))).rejects.toThrow();

      expect(await stateOf(harness, BACKFILL_KEYS.messages)).toMatchObject({ status: 'finished' });
    });

    it('reports a rate that includes the throttle', async () => {
      await storeSources(
        harness,
        'messages',
        Array.from({ length: 4 }, (_, index) => sourceMessage({ text: `word${index}` })),
      );
      let clock = 1_000_000;
      const rates: number[] = [];
      const read = harness.methods.readSearchSources;
      const methods = withMethods(harness, {
        readSearchSources: async (params) => {
          clock += 100;
          return read(params);
        },
        writeSearchState: async (key, fields) => {
          if (typeof fields.rate === 'number' && fields.rate > 0) {
            rates.push(fields.rate);
          }
          return harness.methods.writeSearchState(key, fields);
        },
      });
      const control = {
        ...freeControl(),
        wait: async () => {
          clock += 900;
        },
      };

      await runBackfill({ ...backfillDeps(control, methods), now: () => clock });

      /* 2 rows in 0.1 s, then 2 rows in a whole second including its throttle: 20, then a blend. */
      expect(rates[0]).toBeCloseTo(20);
      expect(rates[1]).toBeCloseTo(20 * 0.7 + 2 * 0.3);
    });

    it('writes nothing once the lease is gone', async () => {
      await storeSources(harness, 'messages', [sourceMessage({ text: 'kerfi' })]);
      const control = { ...freeControl(), holds: () => false };

      expect(await runBackfill(backfillDeps(control))).toBe('lost');

      expect(await recordCount(harness, 'msearch')).toBe(0);
    });

    it('skips a row with no usable fields, logging no text, and still finishes', async () => {
      await storeSources(harness, 'messages', [
        {
          _id: objectId(),
          text: 'SENTINEL_BACKFILL_TEXT',
          messageId: 'no-user',
          createdAt: new Date(),
        },
        sourceMessage({ text: 'kerfi' }),
      ]);

      expect(await runBackfill(backfillDeps())).toBe('done');

      expect(await recordCount(harness, 'msearch')).toBe(1);
      expect(await stateOf(harness, BACKFILL_KEYS.messages)).toMatchObject({ skipped: 1 });
      expect(JSON.stringify(harness.logged)).not.toContain('SENTINEL_BACKFILL_TEXT');
    });

    it('stores tokens only: no text reaches a record or the state', async () => {
      await storeSources(harness, 'messages', [
        sourceMessage({
          text: 'visible',
          contextMeta: { note: 'SENTINEL_CONTEXT' },
          content: [
            { type: 'text', text: 'kerfi' },
            { type: 'tool_call', tool_call: { output: 'SENTINEL_TOOL' } },
          ],
        }),
      ]);

      await runBackfill(backfillDeps());

      const [record] = await records('msearch');
      expect(record.tokens).toContain('kerfi');
      expect(Object.keys(record)).not.toEqual(expect.arrayContaining(['text']));
      expect(JSON.stringify(record).toLowerCase()).not.toContain('sentinel');
      const state = await stateOf(harness, BACKFILL_KEYS.messages);
      expect(JSON.stringify(state).toLowerCase()).not.toContain('sentinel');
    });
  });

  describe('word list rebuild', () => {
    const vocab = async () => {
      const rows = await harness.database.connection
        .db!.collection('search_vocab')
        .find()
        .toArray();
      return Object.fromEntries(rows.map(({ _id, df }) => [String(_id), df]));
    };
    const loadRecords = async () => {
      await storeSources(harness, 'messages', [
        sourceMessage({ text: 'kerfi' }),
        sourceMessage({ text: 'kerfi' }),
        sourceMessage({ text: 'kerfi' }),
      ]);
      await storeSources(harness, 'conversations', [sourceConversation({ title: 'kerfi' })]);
      await runBackfill(backfillDeps());
    };
    const expected = async () => {
      const counts: Record<string, number> = {};
      for (const name of ['msearch', 'csearch'] as const) {
        for (const { tokens } of await records(name)) {
          for (const token of tokens as string[]) {
            counts[token] = (counts[token] ?? 0) + 1;
          }
        }
      }
      return counts;
    };

    it('counts every token across both collections and deletes rows no run stamped', async () => {
      await loadRecords();
      await harness.database.connection
        .db!.collection('search_vocab')
        .insertOne({ _id: 'staleword', df: 9 } as never);

      expect(await runVocabRebuild({ methods: harness.methods, control: freeControl() })).toBe(
        'done',
      );

      const list = await vocab();
      expect(list).toEqual(await expected());
      expect(list.kerfi).toBeGreaterThanOrEqual(4);
      expect(list.staleword).toBeUndefined();
      const rows = await harness.database.connection
        .db!.collection('search_vocab')
        .find()
        .toArray();
      expect(rows.every((row) => row.dfNext === undefined)).toBe(true);
    });

    it('a second run gives the same list, not a doubled one', async () => {
      await loadRecords();
      await runVocabRebuild({ methods: harness.methods, control: freeControl() });
      const first = await vocab();

      await runVocabRebuild({ methods: harness.methods, control: freeControl() });

      expect(await vocab()).toEqual(first);
      expect(await stateOf(harness, 'vocab')).toMatchObject({ run: 2, status: 'finished' });
    });

    it('keeps a word stamped mid-walk', async () => {
      await loadRecords();
      const read = harness.methods.readSearchVocabBatch;
      let stamped = false;
      const methods = withMethods(harness, {
        readSearchVocabBatch: async (params) => {
          if (!stamped) {
            stamped = true;
            const { run } = (await stateOf(harness, 'vocab')) as unknown as { run: number };
            await harness.methods.incrementSearchVocabNext({ counts: [['zzarrived', 1]], run });
          }
          return read(params);
        },
      });

      await runVocabRebuild({ methods, control: freeControl() });

      expect((await vocab()).zzarrived).toBe(1);
    });

    describe('copy pass cost', () => {
      const RUN = 4;
      const ROWS = 1000;
      const COPY_BATCH = 250;
      const token = (index: number) => `w${String(index).padStart(5, '0')}`;

      /** A rebuild stopped just as its copy pass began: every tenth row is one no run stamped. */
      const seedCopyPass = async () => {
        await harness.methods.writeSearchState('vocab', {
          run: RUN,
          phase: 'copy',
          lastId: null,
          walked: 0,
          status: 'running',
        });
        await harness.database.connection
          .db!.collection('search_vocab')
          .insertMany(
            Array.from({ length: ROWS }, (_, index) =>
              index % 10 === 0
                ? { _id: token(index), df: 9, r: RUN - 1 }
                : { _id: token(index), df: 1, dfNext: index, r: RUN },
            ) as never[],
          );
      };

      /** Counts every method call, check and wait: each is one round trip or one throttle wait. */
      const instrumented = (control: ReturnType<typeof freeControl>) => {
        const calls: Record<string, number> = {};
        const limits: number[] = [];
        const count = (name: string) => {
          calls[name] = (calls[name] ?? 0) + 1;
        };
        const methods = new Proxy(harness.methods, {
          get(target, name: string) {
            const real = target[name as keyof typeof target] as (...args: unknown[]) => unknown;
            return (...args: unknown[]) => {
              count(name);
              if (name === 'readSearchVocabBatch') {
                limits.push((args[0] as { limit: number }).limit);
              }
              return real(...args);
            };
          },
        });
        return {
          calls,
          limits,
          methods,
          control: {
            ...control,
            check: async () => {
              count('check');
              return control.check();
            },
            wait: async () => {
              count('wait');
            },
          },
        };
      };

      it('settles a page in one read, one write and one state write, at the copy batch size', async () => {
        await seedCopyPass();
        const counted = instrumented(freeControl({ batchSize: 2, copyBatchSize: COPY_BATCH }));

        expect(await runVocabRebuild({ methods: counted.methods, control: counted.control })).toBe(
          'done',
        );

        const pages = ROWS / COPY_BATCH;
        expect(counted.limits).toEqual(Array(pages + 1).fill(COPY_BATCH));
        expect(counted.calls).toEqual({
          /* The saved state once, then a state write per page and the one that finishes the run. */
          readSearchState: 1,
          writeSearchState: pages + 1,
          /* Every page, and the empty read that ends the pass. */
          readSearchVocabBatch: pages + 1,
          check: pages + 1,
          settleSearchVocab: pages,
          wait: pages,
        });

        const list = await vocab();
        expect(Object.keys(list)).toHaveLength(ROWS - ROWS / 10);
        expect(list[token(0)]).toBeUndefined();
        expect(list[token(999)]).toBe(999);
        expect(await stateOf(harness, 'vocab')).toMatchObject({
          status: 'finished',
          walked: ROWS,
        });
      });

      it('stays resumable page by page, and settling a page twice changes nothing', async () => {
        await seedCopyPass();
        const control = () => freeControl({ copyBatchSize: COPY_BATCH, stopAfter: 2 });

        expect(await runVocabRebuild({ methods: harness.methods, control: control() })).toBe(
          'lost',
        );
        expect(await stateOf(harness, 'vocab')).toMatchObject({
          status: 'running',
          lastId: token(2 * COPY_BATCH - 1),
          walked: 2 * COPY_BATCH,
        });
        /* As a crash after the write and before the state write would leave it. */
        await harness.methods.writeSearchState('vocab', { lastId: token(COPY_BATCH - 1) });

        expect(
          await runVocabRebuild({
            methods: harness.methods,
            control: freeControl({ copyBatchSize: COPY_BATCH }),
          }),
        ).toBe('done');

        const list = await vocab();
        expect(Object.keys(list)).toHaveLength(ROWS - ROWS / 10);
        expect(list[token(251)]).toBe(251);
        expect(list[token(999)]).toBe(999);
      });

      it('writes nothing once the lease is lost', async () => {
        await seedCopyPass();
        const settle = jest.fn(harness.methods.settleSearchVocab);

        expect(
          await runVocabRebuild({
            methods: withMethods(harness, { settleSearchVocab: settle }),
            control: { ...freeControl({ copyBatchSize: COPY_BATCH }), holds: () => false },
          }),
        ).toBe('lost');

        expect(settle).not.toHaveBeenCalled();
        expect(Object.keys(await vocab())).toHaveLength(ROWS);
      });

      it('keeps a row the writer stamped after its page was read', async () => {
        await seedCopyPass();
        const read = harness.methods.readSearchVocabBatch;
        const methods = withMethods(harness, {
          readSearchVocabBatch: async (params) => {
            const rows = await read(params);
            if (params.afterId === undefined) {
              /* An unstamped row in this page gets stamped, and a new word lands inside it. */
              await harness.methods.incrementSearchVocab({
                counts: [
                  [token(0), 1],
                  [`${token(5)}x`, 1],
                ],
                run: RUN,
              });
            }
            return rows;
          },
        });

        await runVocabRebuild({ methods, control: freeControl({ copyBatchSize: COPY_BATCH }) });

        const list = await vocab();
        expect(list[token(0)]).toBe(10);
        expect(list[`${token(5)}x`]).toBe(1);
        expect(list[token(10)]).toBeUndefined();
      });
    });

    it.each([1, 2, 3, 4, 5, 6, 7, 8])(
      'resumes after stopping at check %i, ending with the right list',
      async (stopAfter) => {
        await loadRecords();

        await runVocabRebuild({ methods: harness.methods, control: freeControl({ stopAfter }) });
        expect(await runVocabRebuild({ methods: harness.methods, control: freeControl() })).toBe(
          'done',
        );

        expect(await vocab()).toEqual(await expected());
      },
    );
  });

  describe('verify', () => {
    const load = async (
      messages: Array<Record<string, unknown>> = [sourceMessage({ text: 'kerfi' })],
    ) => {
      await storeSources(harness, 'messages', messages);
      await storeSources(harness, 'conversations', [sourceConversation({ title: 'kerfi' })]);
      await runBackfill(backfillDeps());
    };
    const dropRecord = (name: 'msearch' | 'csearch', _id: unknown) =>
      harness.database.connection
        .db!.collection(name)
        .deleteOne({ _id: new mongoose.Types.ObjectId(String(_id)) });

    it('passes when every source has a record', async () => {
      await load();

      expect(await verify()).toBe('done');

      expect(await verification()).toMatchObject({
        status: 'passed',
        checked: 2,
        missing: 0,
        mismatchedUsers: 0,
        rounds: 1,
      });
      expect((await verification())?.passedAt).toBeInstanceOf(Date);
      expect(harness.logged.find(({ event }) => event === 'search.verify')?.meta).toEqual({
        status: 'passed',
        mismatchedUsers: 0,
        round: 1,
      });
    });

    it('fails on a real gap, counting users rather than naming them', async () => {
      const a = sourceMessage({ text: 'kerfi', user: 'user-a' });
      const b = sourceMessage({ text: 'kerfi', user: 'user-b' });
      await load([a, b, sourceMessage({ text: 'kerfi', user: 'user-b' })]);
      await dropRecord('msearch', a._id);
      await dropRecord('msearch', b._id);

      await verify();

      const result = await verification();
      expect(result).toMatchObject({
        status: 'failed',
        reason: 'mismatch',
        missing: 2,
        mismatchedUsers: 2,
      });
      expect(result?.missingIds).toEqual([String(a._id), String(b._id)]);
      expect(JSON.stringify(result)).not.toContain('user-a');
      expect(lastEvent('search.verify')).toMatchObject({
        status: 'failed',
        mismatchedUsers: 2,
      });
    });

    it('fails on a gap in conversations too', async () => {
      const convo = sourceConversation({ title: 'kerfi' });
      await storeSources(harness, 'conversations', [convo]);
      await runBackfill(backfillDeps());
      await dropRecord('csearch', convo._id);

      await verify();

      expect(await verification()).toMatchObject({ status: 'failed', missing: 1 });
    });

    it('fails as sync_not_started when no sync writer has saved a position', async () => {
      await load();
      await harness.methods.writeSearchState('stream', { savedAt: null, syncedTo: null });
      let clock = Date.now();

      await runVerify({
        methods: harness.methods,
        control: freeControl(),
        metrics: harness.metrics,
        version: computeAnalyzerVersion(harness.packs),
        round: 1,
        now: () => (clock += 20_000),
      });

      /* Every record is right today, and none would follow: this must not read as a pass. */
      expect(await verification()).toMatchObject({
        status: 'failed',
        reason: 'sync_not_started',
        missing: 0,
      });
      expect((await verification())?.passedAt).toBeUndefined();
    });

    it('reports a record whose source has expired and awaits its delete, without failing', async () => {
      const expiring = sourceMessage({
        text: 'kerfi',
        isTemporary: false,
        expiredAt: new Date(Date.now() + 60_000),
      });
      await load([expiring, sourceMessage({ text: 'kerfi' })]);
      expect(await recordCount(harness, 'msearch')).toBe(2);
      /* The moment passes with no write, so no change event tells the writer. */
      await harness.database.connection
        .db!.collection('messages')
        .updateOne(
          { _id: new mongoose.Types.ObjectId(String(expiring._id)) },
          { $set: { expiredAt: new Date(Date.now() - 1000) } },
        );

      await verify();

      expect(await verification()).toMatchObject({
        status: 'passed',
        expired: 1,
        orphans: 0,
        missing: 0,
      });
    });

    it('does not count a stored subagent row that rightly has no record', async () => {
      await load([
        sourceMessage({ text: 'kerfi' }),
        sourceMessage({ text: 'x', subagentTask: { id: 't' } }),
      ]);

      await verify();

      expect(await recordCount(harness, 'msearch')).toBe(1);
      expect(await verification()).toMatchObject({ status: 'passed', missing: 0, orphans: 0 });
    });

    it('rechecks a suspect, so a record that landed during the walk is no gap', async () => {
      const row = sourceMessage({ text: 'kerfi' });
      await load([row]);
      const stored = await records('msearch');
      await dropRecord('msearch', row._id);
      const readIds = harness.methods.readSearchRecordIds;
      let restored = false;
      const methods = withMethods(harness, {
        readSearchRecordIds: async (params) => {
          const ids = await readIds(params);
          if (!restored && params.collection === 'messages') {
            restored = true;
            await harness.database.connection.db!.collection('msearch').insertOne(stored[0]);
          }
          return ids.filter((id) => id !== String(row._id));
        },
      });

      await verify(methods);

      expect(await verification()).toMatchObject({ status: 'passed', missing: 0 });
    });

    it('fails on a row a pack threw on, even if it changed later', async () => {
      const row = sourceMessage({ text: 'kerfi' });
      await storeSources(harness, 'messages', [row]);
      await storeSources(harness, 'conversations', [sourceConversation({ title: 'kerfi' })]);
      const throwing = {
        ...harness.analyzer,
        analyzeMessage: () => {
          throw new Error('pack threw');
        },
      };
      await runBackfill({ ...backfillDeps(), analyzer: throwing });
      await harness.database.connection
        .db!.collection('messages')
        .updateOne(
          { _id: new mongoose.Types.ObjectId(String(row._id)) },
          { $set: { updatedAt: new Date(Date.now() + 1000) } },
        );

      await verify();

      expect(await stateOf(harness, BACKFILL_KEYS.messages)).toMatchObject({
        analysisFailures: 1,
        skipped: 0,
      });
      expect(await verification()).toMatchObject({
        status: 'failed',
        /* Its own reason, so the mismatch loop does not reconcile in vain. */
        reason: 'analysis_failed',
        analysisFailures: 1,
      });
    });

    it('reports records another analyzer wrote, without failing on them', async () => {
      await load([sourceMessage({ text: 'kerfi' }), sourceMessage({ text: 'kerfi' })]);
      await harness.database.connection
        .db!.collection('msearch')
        .updateOne({}, { $set: { v: 'older' } });

      await verify();

      expect(await verification()).toMatchObject({ status: 'passed', otherVersion: 1 });
    });

    it('a re-check keeps a passing tenant shown until its result, and clears old figures', async () => {
      await load();
      await verify();
      const read = harness.methods.readSearchSources;
      const during: Array<unknown> = [];
      const methods = withMethods(harness, {
        readSearchSources: async (params) => {
          during.push(await verification());
          return read(params);
        },
      });

      await verify(methods);

      expect(during[0]).toMatchObject({ status: 'passed', running: true });
      expect(await verification()).toMatchObject({ status: 'passed', running: false });
    });

    it('a failed result is replaced by clean figures when the next walk starts', async () => {
      const row = sourceMessage({ text: 'kerfi' });
      await load([row]);
      await dropRecord('msearch', row._id);
      await verify();
      expect(await verification()).toMatchObject({ status: 'failed', missing: 1 });

      const read = harness.methods.readSearchSources;
      const during: Array<unknown> = [];
      await verify(
        withMethods(harness, {
          readSearchSources: async (params) => {
            during.push(await verification());
            return read(params);
          },
        }),
      );

      expect(during[0]).toMatchObject({ status: 'pending', missing: 0, reason: null });
    });

    it('a stale holder does not overwrite the result', async () => {
      await load();

      const outcome = await runVerify({
        methods: harness.methods,
        control: { ...freeControl(), holds: () => false },
        metrics: harness.metrics,
        version: 'v',
        round: 1,
      });

      expect(outcome).toBe('lost');
      expect(await verification()).toMatchObject({ status: 'pending' });
    });

    it('fails rather than passes when no backfill has finished', async () => {
      await storeSources(harness, 'messages', [sourceMessage({ text: 'kerfi' })]);

      await verify();

      expect(await verification()).toMatchObject({
        status: 'failed',
        reason: 'backfill_not_finished',
      });
    });
  });

  describe('reconcile', () => {
    const version = () => computeAnalyzerVersion(harness.packs);
    const msearch = () => harness.database.connection.db!.collection('msearch');
    const reconcile = (
      overrides: {
        control?: ReturnType<typeof freeControl>;
        methods?: typeof harness.methods;
      } = {},
      inChain = false,
    ) =>
      runReconcile({
        methods: overrides.methods ?? harness.methods,
        analyzer: harness.analyzer,
        version: version(),
        control: overrides.control ?? freeControl(),
        metrics: harness.metrics,
        inChain,
      });
    const reconcileState = () => stateOf(harness, 'reconcile');
    const oid = (id: unknown) => new mongoose.Types.ObjectId(String(id));

    /** A backfilled tenant, then drift: one missing, one stale, one orphan, one at an older analyzer. */
    const drift = async () => {
      const rows = [
        sourceMessage({ text: 'kerfi missing' }),
        sourceMessage({ text: 'kerfi stale' }),
        sourceMessage({ text: 'kerfi gone' }),
        sourceMessage({ text: 'kerfi older' }),
        sourceMessage({ text: 'kerfi fine' }),
      ];
      await storeSources(harness, 'messages', rows);
      await storeSources(harness, 'conversations', [sourceConversation({ title: 'kerfi' })]);
      await runBackfill(backfillDeps());
      await msearch().deleteOne({ _id: oid(rows[0]._id) });
      await harness.database.connection
        .db!.collection('messages')
        .updateOne({ _id: oid(rows[1]._id) }, { $set: { text: 'kerfi edited' } });
      await harness.database.connection
        .db!.collection('messages')
        .deleteOne({ _id: oid(rows[2]._id) });
      await msearch().updateOne({ _id: oid(rows[3]._id) }, { $set: { v: 'older' } });
      return rows;
    };

    it('stops at a second tenant, before it repairs a row for it', async () => {
      await storeSources(harness, 'messages', [
        sourceMessage({ text: 'kerfi', tenantId: 'tenant-one' }),
      ]);
      await storeSources(harness, 'conversations', [sourceConversation({ title: 'kerfi' })]);
      await runBackfill(backfillDeps());
      await storeSources(harness, 'messages', [
        sourceMessage({ text: 'kerfi', tenantId: 'tenant-two' }),
      ]);

      await expect(reconcile()).rejects.toMatchObject({ name: 'TenantMismatch' });

      const written = await records('msearch');
      expect(written.map(({ tenantId }) => tenantId)).toEqual(['tenant-one']);
      expect(JSON.stringify(harness.logged)).not.toContain('tenant-two');
    });

    it('counts a source a pack throws on, so verification names it and the loop has nothing to run on', async () => {
      await storeSources(harness, 'messages', [sourceMessage({ text: 'kerfi fine' })]);
      await storeSources(harness, 'conversations', [sourceConversation({ title: 'kerfi' })]);
      await runBackfill(backfillDeps());
      /* Written after backfill: the sync writer skipped it, so it has no record. */
      await storeSources(harness, 'messages', [sourceMessage({ text: 'kerfi poison' })]);
      const picky = {
        ...harness.analyzer,
        analyzeMessage: (text: string) => {
          if (text.includes('poison')) {
            throw new Error('pack threw');
          }
          return harness.analyzer.analyzeMessage(text);
        },
      };

      await verify();
      expect(await verification()).toMatchObject({ status: 'failed', reason: 'mismatch' });

      expect(
        await runReconcile({
          methods: harness.methods,
          analyzer: picky,
          version: version(),
          control: freeControl(),
          metrics: harness.metrics,
          inChain: false,
        }),
      ).toBe('done');
      expect(await reconcileState()).toMatchObject({
        status: 'finished',
        analysisFailures: 1,
        repaired: 0,
      });

      await verify();
      expect(await verification()).toMatchObject({
        status: 'failed',
        reason: 'analysis_failed',
        missing: 1,
        analysisFailures: 1,
      });
      expect(await recordCount(harness, 'msearch')).toBe(1);
    });

    it('builds the same record from its projected read as from the whole document the stream delivers', async () => {
      await storeSources(harness, 'messages', [
        sourceMessage({
          text: 'fieldword',
          content: [
            { type: ContentTypes.THINK, think: 'thinkword' },
            { type: ContentTypes.TEXT, text: 'stringword' },
            { type: ContentTypes.TEXT, text: { value: 'valueword' } },
            { type: ContentTypes.STEER, steer: 'steerword' },
            { type: ContentTypes.TOOL_CALL, tool_call: { name: 'x', output: 'toolword' } },
          ],
        }),
      ]);
      const [projected] = await harness.methods.readSearchSources({
        collection: 'messages',
        limit: 10,
        withText: true,
      });
      const whole = await harness.database.connection.db!.collection('messages').findOne({});
      const options = { analyzer: harness.analyzer, version: version() };

      const walked = buildMessageRecord(projected, options);
      const streamed = buildMessageRecord({ ...whole, _id: String(whole?._id) }, options);

      expect(walked?.tokens).toEqual(
        expect.arrayContaining(['thinkword', 'stringword', 'valueword', 'steerword']),
      );
      expect(walked?.tokens).not.toContain('toolword');
      expect(walked?.tokens).toEqual(streamed?.tokens);
      expect(walked?.h).toBe(streamed?.h);
    });

    it('counts and logs before it repairs, then repairs every kind of drift', async () => {
      const rows = await drift();
      const insert = harness.methods.insertSearchRecords;
      let loggedBeforeRepair = false;
      const methods = withMethods(harness, {
        insertSearchRecords: async (collection, records) => {
          if (records.length > 0) {
            loggedBeforeRepair = lastEvent('search.reconcile') !== undefined;
          }
          return insert(collection, records);
        },
      });

      expect(await reconcile({ methods })).toBe('done');

      expect(loggedBeforeRepair).toBe(true);
      /* Four messages and a conversation on the source side, four and one on the record side. */
      expect(lastEvent('search.reconcile')).toEqual({ missing: 1, orphans: 1, stale: 2, of: 10 });
      expect(await reconcileState()).toMatchObject({
        status: 'finished',
        missing: 1,
        orphans: 1,
        stale: 2,
        repaired: 4,
      });
      expect(await msearch().findOne({ _id: oid(rows[0]._id) })).not.toBeNull();
      expect((await msearch().findOne({ _id: oid(rows[1]._id) }))?.tokens).toContain('edited');
      expect(await msearch().findOne({ _id: oid(rows[2]._id) })).toBeNull();
      expect(await msearch().findOne({ _id: oid(rows[3]._id) })).toMatchObject({ v: version() });
      expect(await verify()).toBe('done');
      expect(await verification()).toMatchObject({ status: 'passed', otherVersion: 0 });
    });

    it('loses to a live edit between its read and its write', async () => {
      const rows = await drift();
      const rewrite = harness.methods.rewriteSearchRecords;
      const methods = withMethods(harness, {
        rewriteSearchRecords: async (collection, rewrites) => {
          /* The writer applies the newest edit first. */
          await msearch().updateOne(
            { _id: oid(rows[1]._id) },
            { $set: { h: 'written-by-sync', tokens: ['live'] } },
          );
          return rewrite(collection, rewrites);
        },
      });

      await reconcile({ methods });

      expect(await msearch().findOne({ _id: oid(rows[1]._id) })).toMatchObject({
        h: 'written-by-sync',
        tokens: ['live'],
      });
    });

    it('a source deleted or turned temporary between its read and its insert leaves no record', async () => {
      const rows = await drift();
      const insert = harness.methods.insertSearchRecords;
      const methods = withMethods(harness, {
        insertSearchRecords: async (collection, records) => {
          await harness.database.connection
            .db!.collection('messages')
            .updateOne(
              { _id: oid(rows[0]._id) },
              { $set: { isTemporary: true, expiredAt: new Date(Date.now() + 1e6) } },
            );
          return insert(collection, records);
        },
      });

      await reconcile({ methods });

      expect(await msearch().findOne({ _id: oid(rows[0]._id) })).toBeNull();
    });

    it('a stored subagent row gets no record from repair, and verification does not count it', async () => {
      await storeSources(harness, 'messages', [
        sourceMessage({ text: 'kerfi' }),
        sourceMessage({ text: 'subagent', subagentTask: { id: 'task' } }),
      ]);
      await storeSources(harness, 'conversations', [sourceConversation({ title: 'kerfi' })]);
      await runBackfill(backfillDeps());

      await reconcile();

      expect(await recordCount(harness, 'msearch')).toBe(1);
      expect(await reconcileState()).toMatchObject({ missing: 0, repaired: 0 });
      await verify();
      expect(await verification()).toMatchObject({ status: 'passed', missing: 0 });
    });

    it('resumes from any phase and pass, with the same result as an uninterrupted run', async () => {
      const stops = new Set<string>();
      for (let checks = 1; checks <= 26; checks += 1) {
        await harness.reset();
        await drift();
        expect(await reconcile({ control: freeControl({ stopAfter: checks }) })).not.toBe('done');
        const saved = await reconcileState();
        stops.add(`${saved?.pass}:${saved?.phase}`);

        expect(await reconcile()).toBe('done');
        expect(await reconcileState()).toMatchObject({
          status: 'finished',
          missing: 1,
          orphans: 1,
          stale: 2,
        });
        expect(await recordCount(harness, 'msearch')).toBe(4);
        expect(await msearch().countDocuments({ v: { $ne: version() } })).toBe(0);
      }
      expect(stops).toEqual(
        new Set([
          'count:messages→records',
          'count:records→messages',
          'count:conversations→records',
          'count:records→conversations',
          'repair:messages→records',
          'repair:records→messages',
          'repair:conversations→records',
          'repair:records→conversations',
          'repair:vocab',
        ]),
      );
    }, 120_000);

    it('a live edit between its source read and its stamp read still wins', async () => {
      const row = sourceMessage({ text: 'kerfi old' });
      await storeSources(harness, 'messages', [row]);
      await runBackfill(backfillDeps());
      const source = { _id: oid(row._id) };
      const messagesCollection = harness.database.connection.db!.collection('messages');
      await messagesCollection.updateOne(source, { $set: { text: 'kerfi middle' } });
      const stamps = harness.methods.readSearchRecordStamps;
      let edited = false;
      const methods = withMethods(harness, {
        readSearchRecordStamps: async (collection, ids) => {
          if (!edited && (await reconcileState())?.pass === 'repair') {
            /* The writer applies a newer edit after the walk's source read. */
            edited = true;
            await messagesCollection.updateOne(source, { $set: { text: 'kerfi newest' } });
            await msearch().updateOne(source, { $set: { h: 'by-writer', tokens: ['newest'] } });
          }
          return stamps(collection, ids);
        },
      });

      await reconcile({ methods });

      expect(edited).toBe(true);
      const tokens = (await msearch().findOne(source))?.tokens;
      expect(tokens).toContain('newest');
      expect(tokens).not.toContain('middle');
    });

    it('puts back a record whose source came back between its read and the orphan delete', async () => {
      const row = sourceMessage({ text: 'kerfi back' });
      await storeSources(harness, 'messages', [row]);
      await runBackfill(backfillDeps());
      const source = { _id: oid(row._id) };
      const messagesCollection = harness.database.connection.db!.collection('messages');
      await messagesCollection.updateOne(source, {
        $set: { isTemporary: true, expiredAt: new Date(Date.now() + 1e6) },
      });
      const remove = harness.methods.deleteSearchRecords;
      const methods = withMethods(harness, {
        deleteSearchRecords: async (collection, ids, options) => {
          /* Turned back before the delete lands; the writer rewrote its record meanwhile. */
          await messagesCollection.updateOne(source, {
            $set: { isTemporary: false },
            $unset: { expiredAt: '' },
          });
          return remove(collection, ids, options);
        },
      });

      await reconcile({ methods });

      expect(await msearch().findOne(source)).not.toBeNull();
    });

    it('a rolling analyzer change matches by exact form until reconcile rewrites it', async () => {
      await storeSources(harness, 'messages', [sourceMessage({ text: 'kerfi word' })]);
      await runBackfill({ ...backfillDeps(), version: 'older' });
      const window = () =>
        harness.methods.readRecordWindow(
          { user: 'user-a', tokens: ['kerfi'], limit: 10 },
          { maxTimeMS: 5000 },
        );
      expect(await window()).toHaveLength(1);

      await reconcile();

      expect(await reconcileState()).toMatchObject({ stale: 1 });
      expect(await msearch().findOne({})).toMatchObject({ v: version() });
      expect(await window()).toHaveLength(1);
    });

    it('clears attribution state once no record from the older analyzer remains', async () => {
      await storeSources(harness, 'messages', [sourceMessage({ text: 'kerfi' })]);
      await runBackfill({ ...backfillDeps(), version: 'older' });
      await harness.methods.writeSearchState('analyzer', {
        attributionUntilReanalyzed: [{ id: 'gone', attribution: { text: 't', url: 'u' } }],
      });
      const rewrite = harness.methods.rewriteSearchRecords;
      const failing = withMethods(harness, { rewriteSearchRecords: async () => 0 });

      await reconcile({ methods: failing });
      expect(await stateOf(harness, 'analyzer')).toMatchObject({
        attributionUntilReanalyzed: [expect.objectContaining({ id: 'gone' })],
      });

      await reconcile({ methods: withMethods(harness, { rewriteSearchRecords: rewrite }) });
      expect(await stateOf(harness, 'analyzer')).toMatchObject({
        attributionUntilReanalyzed: null,
      });
    });

    it('finishes when the older-version count fails, and leaves the attribution for the next run', async () => {
      await storeSources(harness, 'messages', [sourceMessage({ text: 'kerfi' })]);
      await runBackfill(backfillDeps());
      await harness.methods.writeSearchState('analyzer', {
        attributionUntilReanalyzed: [{ id: 'gone', attribution: { text: 't', url: 'u' } }],
      });
      const failing = withMethods(harness, {
        countSearchRecordsAtOtherVersion: async () => {
          throw new Error('operation exceeded time limit');
        },
      });

      await reconcile({ methods: failing });

      expect(await reconcileState()).toMatchObject({ status: 'finished' });
      expect(await stateOf(harness, 'analyzer')).toMatchObject({
        attributionUntilReanalyzed: [expect.objectContaining({ id: 'gone' })],
      });
    });

    it('in the chain, skips the word list only when it repaired nothing', async () => {
      await storeSources(harness, 'messages', [sourceMessage({ text: 'kerfi' })]);
      await runBackfill(backfillDeps());
      const run = async () => (await stateOf(harness, 'vocab'))?.run;

      await reconcile({}, true);
      expect(await run()).toBeUndefined();

      await reconcile({}, false);
      expect(await run()).toBe(1);

      await msearch().deleteMany({});
      await reconcile({}, true);
      expect(await run()).toBe(2);
    });
  });

  describe('verify with a writer running', () => {
    const syncedFar = () =>
      harness.methods.writeSearchState('stream', {
        savedAt: new Date(),
        syncedTo: new Date(Date.now() + 3_600_000),
      });
    const load = async (rows: Array<Record<string, unknown>>) => {
      await storeSources(harness, 'messages', rows);
      await runBackfill(backfillDeps());
    };
    const oid = (agoMs: number) => {
      const seconds = Math.floor((Date.now() - agoMs) / 1000);
      return (
        mongoose.Types.ObjectId.createFromTime(seconds).toHexString().slice(0, 8) +
        new mongoose.Types.ObjectId().toHexString().slice(8)
      );
    };

    it('checks sources written after backfill, and fails on one with no record', async () => {
      await load([sourceMessage({ text: 'kerfi' })]);
      await syncedFar();
      await storeSources(harness, 'messages', [
        { ...sourceMessage({ text: 'later' }), _id: oid(120_000) },
      ]);

      await verify();

      expect(await verification()).toMatchObject({ status: 'failed', missing: 1 });
    });

    it('ignores an import inside the lag window, by source ID age', async () => {
      await load([sourceMessage({ text: 'kerfi' })]);
      await syncedFar();
      await storeSources(harness, 'messages', [
        { ...sourceMessage({ text: 'fresh' }), _id: oid(0) },
      ]);

      await verify();

      expect(await verification()).toMatchObject({ status: 'passed', checked: 1 });
    });

    it('fails on an orphan, which no writer leaves behind', async () => {
      const row = sourceMessage({ text: 'kerfi' });
      await load([row]);
      await syncedFar();
      await harness.database.connection
        .db!.collection('messages')
        .deleteOne({ _id: new mongoose.Types.ObjectId(String(row._id)) });

      await verify();

      expect(await verification()).toMatchObject({ status: 'failed', orphans: 1 });
    });

    it('ignores a chat deleted between the walks', async () => {
      const rows = [sourceMessage({ text: 'kerfi' }), sourceMessage({ text: 'kerfi two' })];
      await load(rows);
      await syncedFar();
      const read = harness.methods.readSearchSources;
      const methods = withMethods(harness, {
        readSearchSources: async (params) => {
          const found = await read(params);
          /* Deleted after its source was read, with the writer removing its record. */
          for (const id of [rows[1]._id]) {
            const _id = new mongoose.Types.ObjectId(String(id));
            await harness.database.connection.db!.collection('messages').deleteOne({ _id });
            await harness.database.connection.db!.collection('msearch').deleteOne({ _id });
          }
          return found;
        },
      });

      await verify(methods);

      expect(await verification()).toMatchObject({ status: 'passed', missing: 0, orphans: 0 });
    });

    it('stops waiting for sync as soon as its turn ends', async () => {
      await load([sourceMessage({ text: 'kerfi' })]);
      await harness.methods.writeSearchState('stream', {
        savedAt: new Date(),
        syncedTo: new Date(Date.now() - 600_000),
      });
      await storeSources(harness, 'messages', [
        { ...sourceMessage({ text: 'later' }), _id: oid(120_000) },
      ]);
      let held = true;
      const control = { ...freeControl(), holds: () => held };
      setTimeout(() => (held = false), 200);
      const startedAt = Date.now();

      const outcome = await runVerify({
        methods: harness.methods,
        control,
        metrics: harness.metrics,
        version: computeAnalyzerVersion(harness.packs),
        round: 1,
      });

      expect(outcome).toBe('lost');
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    });

    it('fails as sync_behind when the writer never passes the recheck', async () => {
      await load([sourceMessage({ text: 'kerfi' })]);
      await harness.methods.writeSearchState('stream', {
        savedAt: new Date(),
        syncedTo: new Date(Date.now() - 600_000),
      });
      await storeSources(harness, 'messages', [
        { ...sourceMessage({ text: 'later' }), _id: oid(120_000) },
      ]);
      let clock = Date.now();

      await runVerify({
        methods: harness.methods,
        control: freeControl(),
        metrics: harness.metrics,
        version: computeAnalyzerVersion(harness.packs),
        round: 1,
        now: () => (clock += 20_000),
      });

      expect(await verification()).toMatchObject({ status: 'failed', reason: 'sync_behind' });
    });
  });
});
