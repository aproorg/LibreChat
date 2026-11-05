import mongoose from 'mongoose';
import type { SearchHarness } from '../__tests__/helpers/harness';
import {
  freeControl,
  objectId,
  recordCount,
  stateOf,
  storeSources,
  withMethods,
} from './__tests__/helpers/jobs';
import {
  createSearchHarness,
  sourceConversation,
  sourceMessage,
} from '../__tests__/helpers/harness';
import { computeAnalyzerVersion } from '../analyzer/version';
import { BACKFILL_KEYS, objectIdFloor } from './control';
import { runVocabRebuild } from './vocabRebuild';
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
      expect(finished?.finishedAtId).toEqual(expect.any(String));
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

    it('keeps a finishing position behind rows that may still be landing', async () => {
      const at = Date.parse('2026-06-01T00:00:00Z');
      const recent = `${Math.floor(at / 1000).toString(16)}0000000000000001`;
      await storeSources(harness, 'messages', [{ ...sourceMessage({ text: 'new' }), _id: recent }]);

      await runBackfill({ ...backfillDeps(), now: () => at });

      expect((await stateOf(harness, BACKFILL_KEYS.messages))?.finishedAtId).toBe(
        objectIdFloor(at - 60_000),
      );
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

    it('passes when every source up to backfill has a record', async () => {
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

    it('ignores messages created after backfill, because no writer indexes them yet', async () => {
      await load();
      await storeSources(harness, 'messages', [sourceMessage({ text: 'kerfi', _id: objectId() })]);

      await verify();

      expect(await verification()).toMatchObject({ status: 'passed', missing: 0 });
    });

    it('does not fail on a record whose source was deleted after backfill', async () => {
      const gone = sourceMessage({ text: 'kerfi' });
      await load([gone, sourceMessage({ text: 'kerfi' })]);
      await harness.database.connection
        .db!.collection('messages')
        .deleteOne({ _id: new mongoose.Types.ObjectId(String(gone._id)) });

      await verify();

      expect(await verification()).toMatchObject({ status: 'passed', orphans: 1, missing: 0 });
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

    it('does not fail on a message that finished after backfill read it', async () => {
      const streaming = sourceMessage({ text: 'kerfi', unfinished: true });
      await load([streaming]);
      await harness.database.connection
        .db!.collection('messages')
        .updateOne(
          { _id: new mongoose.Types.ObjectId(String(streaming._id)) },
          { $set: { unfinished: false, updatedAt: new Date(Date.now() + 1000) } },
        );

      await verify();

      expect(await verification()).toMatchObject({
        status: 'passed',
        missing: 0,
        changedSinceBackfill: 1,
      });
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
        reason: 'mismatch',
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
});
