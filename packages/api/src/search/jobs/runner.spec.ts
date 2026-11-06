import type { SearchHarness } from '../__tests__/helpers/harness';
import {
  createRunner,
  expireLease,
  recordCount,
  settle,
  stateOf,
  storeSources,
  withMethods,
} from './__tests__/helpers/jobs';
import {
  createSearchHarness,
  sourceConversation,
  sourceMessage,
} from '../__tests__/helpers/harness';
import { runSearchJobCommand } from './script';
import { BACKFILL_KEYS } from './control';

describe('search job runner', () => {
  let harness: SearchHarness;

  const request = (command: string) =>
    runSearchJobCommand({ argv: [command], methods: harness.methods, print: () => undefined });
  const seed = async (count = 3) => {
    await storeSources(
      harness,
      'messages',
      Array.from({ length: count }, (_, index) => sourceMessage({ text: `kerfi word${index}` })),
    );
    await storeSources(harness, 'conversations', [sourceConversation({ title: 'kerfi' })]);
  };
  const chain = () => stateOf(harness, 'chain');

  beforeAll(async () => {
    harness = await createSearchHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  describe('the lease', () => {
    it('only the lease holder runs jobs, and a request waits for one', async () => {
      await seed();
      const holder = createRunner(harness);
      const other = createRunner(harness);
      await holder.tick();
      const read = jest.fn(harness.methods.readSearchSources);
      const follower = createRunner(harness, {
        methods: withMethods(harness, { readSearchSources: read }),
      });
      await request('backfill');

      await follower.tick();
      await follower.idle();
      await other.tick();
      await other.idle();

      expect(holder.isHolder()).toBe(true);
      expect(follower.isHolder()).toBe(false);
      expect(other.isHolder()).toBe(false);
      expect(read).not.toHaveBeenCalled();
      expect(await chain()).toBeNull();

      await settle(holder);
      expect((await chain())?.finishedAt).toBeInstanceOf(Date);
    });

    it('takes over from a silent holder, with a higher epoch, and emits the lease event', async () => {
      const first = createRunner(harness);
      await first.tick();
      const { epoch } = (await stateOf(harness, 'lease')) as unknown as { epoch: number };

      const second = createRunner(harness);
      await second.tick();
      expect(second.isHolder()).toBe(false);

      await expireLease(harness);
      await second.tick();

      expect(second.isHolder()).toBe(true);
      expect(await stateOf(harness, 'lease')).toMatchObject({ epoch: epoch + 1 });
      const events = harness.logged.filter(({ event }) => event === 'search.lease');
      expect(events[events.length - 1].meta).toMatchObject({ event: 'acquired', epoch: epoch + 1 });

      /* The old holder learns it lost at its next heartbeat. */
      await first.tick();
      expect(first.isHolder()).toBe(false);
      expect(harness.logged.some(({ meta }) => (meta as { event?: string }).event === 'lost')).toBe(
        true,
      );
    });

    it('stops a holder past its deadline before it writes', async () => {
      let clock = Date.now();
      const runner = createRunner(harness, { now: () => clock });
      await runner.tick();
      expect(runner.isHolder()).toBe(true);

      clock += 31_000;

      expect(runner.isHolder()).toBe(false);
    });

    it('a process whose pack failed takes no lease, and a holder whose pack failed gives it up', async () => {
      let ready: ReturnType<SearchHarness['analyzer']['docTokens']> | null = [];
      const service = {
        jobAnalyzer: () => (ready ? { analyzer: harness.analyzer, version: 'v' } : null),
      };
      const runner = createRunner(harness, { service });
      await runner.tick();
      expect(runner.isHolder()).toBe(true);

      ready = null;
      await runner.tick();

      expect(runner.isHolder()).toBe(false);
      expect(
        harness.logged.some(({ meta }) => (meta as { event?: string }).event === 'released'),
      ).toBe(true);

      const failed = createRunner(harness, { service });
      await failed.tick();
      expect(failed.isHolder()).toBe(false);
    });

    it('stop gives the lease up, so the next process needs no takeover wait', async () => {
      const first = createRunner(harness);
      await first.tick();
      await first.stop();

      const next = createRunner(harness);
      await next.tick();

      expect(next.isHolder()).toBe(true);
    });
  });

  describe('the chain', () => {
    it('runs backfill, indexes, word list, then verify, in that order', async () => {
      await seed();
      await harness.database.connection.db!.collection('msearch').dropIndexes();
      const order: string[] = [];
      const note = <K extends keyof SearchHarness['methods']>(name: K, step: string) => {
        const real = harness.methods[name] as (...args: unknown[]) => Promise<unknown>;
        return (async (...args: unknown[]) => {
          order.push(step);
          return real(...args);
        }) as SearchHarness['methods'][K];
      };
      const runner = createRunner(harness, {
        methods: withMethods(harness, {
          insertSearchRecords: note('insertSearchRecords', 'backfill'),
          ensureSearchIndexes: note('ensureSearchIndexes', 'indexes'),
          incrementSearchVocabNext: note('incrementSearchVocabNext', 'vocab'),
          readSearchRecordIds: note('readSearchRecordIds', 'verify'),
        }),
      });
      await request('backfill');

      await settle(runner);

      expect([...new Set(order)]).toEqual(['backfill', 'indexes', 'vocab', 'verify']);
      expect(await chain()).toMatchObject({ step: 'verify', requestId: expect.any(String) });
      expect((await chain())?.finishedAt).toBeInstanceOf(Date);
    });

    it.each(['backfill', 'indexes', 'vocab', 'verify'])(
      'a holder killed in step %s has the next holder resume there',
      async (step) => {
        await seed();
        const failing: Record<string, Partial<SearchHarness['methods']>> = {
          backfill: { insertSearchRecords: () => Promise.reject(new Error('killed')) },
          indexes: { ensureSearchIndexes: () => Promise.reject(new Error('killed')) },
          vocab: { incrementSearchVocabNext: () => Promise.reject(new Error('killed')) },
          verify: { readSearchRecordIds: () => Promise.reject(new Error('killed')) },
        };
        const killed = createRunner(harness, {
          methods: withMethods(harness, failing[step]),
        });
        await request('backfill');
        await settle(killed, 1);
        await killed.tick();
        await killed.idle();

        expect(await chain()).toMatchObject({ step });
        expect((await chain())?.finishedAt).toBeUndefined();
        await expireLease(harness);
        await killed.stop();

        const next = createRunner(harness);
        await settle(next);

        expect((await chain())?.finishedAt).toBeInstanceOf(Date);
        expect(await stateOf(harness, 'verification')).toMatchObject({ status: 'passed' });
        expect(await recordCount(harness, 'msearch')).toBe(3);
      },
    );

    it('a job failure is logged safely and retried at the next heartbeat', async () => {
      await seed();
      let failures = 1;
      const insert = harness.methods.insertSearchRecords;
      const runner = createRunner(harness, {
        methods: withMethods(harness, {
          insertSearchRecords: async (...args) => {
            if (failures > 0) {
              failures -= 1;
              throw new Error('SENTINEL_JOB_ERROR');
            }
            return insert(...args);
          },
        }),
      });
      await request('backfill');

      await settle(runner);

      expect(JSON.stringify(harness.logged)).not.toContain('SENTINEL_JOB_ERROR');
      expect(harness.logged.some(({ event }) => event === '[search] Job failed')).toBe(true);
      expect((await chain())?.finishedAt).toBeInstanceOf(Date);
    });

    it('a failure that repeats backs off and shows on the chain, and clears when it moves on', async () => {
      await seed();
      let clock = Date.now();
      let attempts = 0;
      let broken = true;
      const runner = createRunner(harness, {
        now: () => clock,
        methods: withMethods(harness, {
          ensureSearchIndexes: async () => {
            attempts += 1;
            if (broken) {
              throw new Error('index build refused');
            }
            return harness.methods.ensureSearchIndexes();
          },
        }),
      });
      await request('backfill');

      await settle(runner, 6);

      expect(attempts).toBe(2);
      expect(await chain()).toMatchObject({ step: 'indexes', failures: 2 });
      expect((await chain())?.lastFailureAt).toBeInstanceOf(Date);

      broken = false;
      clock += 11 * 60_000;
      await settle(runner, 5);

      expect((await chain())?.finishedAt).toBeInstanceOf(Date);
      expect(await chain()).toMatchObject({ failures: 0 });
    });

    it('saves a safe failure code, and no error text', async () => {
      await seed();
      const runner = createRunner(harness, {
        methods: withMethods(harness, {
          ensureSearchIndexes: () =>
            Promise.reject(Object.assign(new TypeError('SENTINEL_FAILURE_TEXT'), { code: 13 })),
        }),
      });
      await request('backfill');

      await settle(runner, 3);

      expect(await chain()).toMatchObject({ lastFailureCode: 'TypeError:13' });
      expect(JSON.stringify(await chain())).not.toContain('SENTINEL_FAILURE_TEXT');
      expect(JSON.stringify(harness.logged)).not.toContain('SENTINEL_FAILURE_TEXT');
      expect(
        harness.logged.find(({ event }) => event === '[search] Job failed')?.meta,
      ).toMatchObject({
        lastFailureCode: 'TypeError:13',
      });
    });

    it('a backfill after a failed verify fills the gap, and verify then passes', async () => {
      await seed();
      const runner = createRunner(harness);
      await request('backfill');
      await settle(runner);
      await harness.database.connection.db!.collection('msearch').deleteOne({});
      await request('verify');
      await settle(runner);
      expect(await stateOf(harness, 'verification')).toMatchObject({
        status: 'failed',
        missing: 1,
      });

      await request('backfill');
      await settle(runner, 5);

      expect(await recordCount(harness, 'msearch')).toBe(3);
      expect(await stateOf(harness, 'verification')).toMatchObject({
        status: 'passed',
        missing: 0,
      });
    });

    it('a new holder moving a step on clears a count it did not make', async () => {
      await seed();
      await request('backfill');
      await harness.methods.writeSearchState('chain', { failures: 5 });
      const runner = createRunner(harness);

      await settle(runner);

      expect(await chain()).toMatchObject({ failures: 0 });
    });

    it('a standalone verify that fails writes no chain, so none starts', async () => {
      await request('verify');
      const runner = createRunner(harness, {
        methods: withMethods(harness, {
          writeSearchState: async (key, fields) => {
            if (key === 'verification') {
              throw new Error('killed');
            }
            return harness.methods.writeSearchState(key, fields);
          },
        }),
      });

      await settle(runner);

      expect(await chain()).toBeNull();
      expect(await harness.methods.listSearchJobRequests()).toHaveLength(1);
      expect(harness.logged.some(({ event }) => event === '[search] Job failed')).toBe(true);
    });

    it('a job stalled past its turn does not carry on after this process wins the lease back', async () => {
      await seed(4);
      let clock = Date.now();
      const read = harness.methods.readSearchSources;
      let stalled = false;
      let reads = 0;
      const runner = createRunner(harness, {
        now: () => clock,
        methods: withMethods(harness, {
          readSearchSources: async (params) => {
            reads += 1;
            if (!stalled) {
              stalled = true;
              /* Past the lease, another holder takes a turn and leaves, then this one returns. */
              clock += 31_000;
              await createRunner(harness, { now: () => clock }).tick();
              clock += 31_000;
              await runner.tick();
            }
            return read(params);
          },
        }),
      });
      await request('backfill');

      await runner.tick();
      while (!stalled) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await runner.idle();

      expect(reads).toBe(1);
      expect(await recordCount(harness, 'msearch')).toBe(0);
    });

    it('verify reports a mismatch and fails, and the chain still ends', async () => {
      await seed();
      const insert = harness.methods.insertSearchRecords;
      let dropped = false;
      const runner = createRunner(harness, {
        methods: withMethods(harness, {
          insertSearchRecords: async (collection, batch) => {
            if (!dropped && collection === 'messages') {
              dropped = true;
              return insert(collection, batch.slice(1));
            }
            return insert(collection, batch);
          },
        }),
      });
      await request('backfill');

      await settle(runner);

      expect(await stateOf(harness, 'verification')).toMatchObject({
        status: 'failed',
        missing: 1,
        mismatchedUsers: 1,
      });
      expect((await chain())?.finishedAt).toBeInstanceOf(Date);
    });

    it('a request is kept until its job state is written, so a crash cannot lose it', async () => {
      const runner = createRunner(harness, {
        methods: withMethods(harness, {
          writeSearchState: async (key, fields) => {
            if (key === 'chain') {
              throw new Error('killed');
            }
            return harness.methods.writeSearchState(key, fields);
          },
        }),
      });
      await request('backfill');

      await runner.tick();

      expect(await harness.methods.listSearchJobRequests()).toHaveLength(1);
      await runner.stop();
      await expireLease(harness);

      const next = createRunner(harness);
      await settle(next);
      expect(await harness.methods.listSearchJobRequests()).toHaveLength(0);
      expect((await chain())?.finishedAt).toBeInstanceOf(Date);
    });

    it('a second backfill request during a chain starts nothing new', async () => {
      await seed();
      const runner = createRunner(harness);
      await request('backfill');
      await runner.tick();
      const { requestId } = (await chain()) as unknown as { requestId: string };
      /* Past the script, which refuses this while it can see the chain. */
      await harness.methods.writeSearchState('jobRequest:late', {
        job: 'backfill',
        requestedAt: new Date(),
      });

      await settle(runner);

      expect(await chain()).toMatchObject({ requestId });
    });

    it('an explicit backfill after a finished chain picks up new messages', async () => {
      await seed();
      const runner = createRunner(harness);
      await request('backfill');
      await settle(runner);
      await storeSources(harness, 'messages', [sourceMessage({ text: 'kerfi' })]);

      await request('backfill');
      await settle(runner);

      expect(await recordCount(harness, 'msearch')).toBe(4);
      expect((await chain())?.finishedAt).toBeInstanceOf(Date);
    });
  });

  describe('pause and resume', () => {
    it('a pause before a new backfill of a finished chain holds it', async () => {
      await seed();
      const runner = createRunner(harness);
      await request('backfill');
      await settle(runner);
      await storeSources(harness, 'messages', [sourceMessage({ text: 'kerfi' })]);

      await request('pause');
      await settle(runner, 1);
      await request('backfill');
      await settle(runner);

      expect(await recordCount(harness, 'msearch')).toBe(3);
      expect((await chain())?.finishedAt).toBeUndefined();

      await request('resume');
      await settle(runner, 4);
      expect(await recordCount(harness, 'msearch')).toBe(4);
    });

    it('stops between batches, keeps its position, and resumes on request', async () => {
      await seed(6);
      const runner = createRunner(harness, { search: { jobs: { batchDelayMs: 20 } } });
      await request('backfill');
      await runner.tick();
      await request('pause');
      await settle(runner);

      const paused = await stateOf(harness, BACKFILL_KEYS.messages);
      expect(paused).toMatchObject({ pause: true, status: 'paused', pausedReason: 'operator' });
      const held = await recordCount(harness, 'msearch');
      expect(held).toBeLessThan(6);
      expect((await chain())?.finishedAt).toBeUndefined();

      await settle(runner);
      expect(await recordCount(harness, 'msearch')).toBe(held);

      await request('resume');
      await settle(runner);

      expect(await recordCount(harness, 'msearch')).toBe(6);
      expect(await stateOf(harness, BACKFILL_KEYS.messages)).toMatchObject({
        pause: false,
        status: 'finished',
      });
      expect((await chain())?.finishedAt).toBeInstanceOf(Date);
    });

    it('a pause also holds the later steps, whose walks load the database too', async () => {
      await seed();
      const pauseOnVocab = harness.methods.readSearchRecordTokenBatch;
      const runner = createRunner(harness, {
        methods: withMethods(harness, {
          readSearchRecordTokenBatch: async (params) => {
            await harness.methods.writeSearchState(BACKFILL_KEYS.messages, { pause: true });
            return pauseOnVocab(params);
          },
        }),
      });
      await request('backfill');

      await settle(runner);

      expect(await chain()).toMatchObject({ step: 'vocab' });
      expect((await chain())?.finishedAt).toBeUndefined();
    });
  });

  describe('the verify request', () => {
    it('runs on its own after the chain, and counts as a later round', async () => {
      await seed();
      const runner = createRunner(harness);
      await request('backfill');
      await settle(runner);

      await request('verify');
      await settle(runner);

      expect(await harness.methods.listSearchJobRequests()).toHaveLength(0);
      expect(await stateOf(harness, 'verification')).toMatchObject({ status: 'passed', rounds: 2 });
    });

    it('waits while a chain is unfinished', async () => {
      await seed();
      const runner = createRunner(harness);
      await request('backfill');
      await request('pause');
      await request('verify');

      await settle(runner);

      expect((await harness.methods.listSearchJobRequests()).map(({ job }) => job)).toEqual([
        'verify',
      ]);
      expect(await stateOf(harness, 'verification')).toBeNull();

      await request('resume');
      await settle(runner, 4);

      expect(await harness.methods.listSearchJobRequests()).toHaveLength(0);
      expect(await stateOf(harness, 'verification')).toMatchObject({ status: 'passed', rounds: 2 });
    });
  });

  describe('backfillOnStart', () => {
    const on = { search: { jobs: { backfillOnStart: true } } };

    it('off starts nothing', async () => {
      await seed();
      const runner = createRunner(harness);

      await settle(runner);

      expect(await chain()).toBeNull();
      expect(await recordCount(harness, 'msearch')).toBe(0);
    });

    it('on starts the chain once, from the lease holder only', async () => {
      await seed();
      const holder = createRunner(harness, on);
      const other = createRunner(harness, on);
      const write = jest.spyOn(harness.methods, 'writeSearchState');
      await holder.tick();
      await other.tick();
      await settle(holder);
      await settle(other);

      expect(await recordCount(harness, 'msearch')).toBe(3);
      expect((await chain())?.finishedAt).toBeInstanceOf(Date);
      expect(await stateOf(harness, 'vocab')).toMatchObject({ run: 1 });
      write.mockRestore();
    });

    it('a failed first request is tried again at the next heartbeat', async () => {
      await seed();
      let broken = true;
      const runner = createRunner(harness, {
        ...on,
        methods: withMethods(harness, {
          writeSearchState: async (key, fields) => {
            if (broken && key.startsWith('jobRequest:')) {
              broken = false;
              throw new Error('transient');
            }
            return harness.methods.writeSearchState(key, fields);
          },
        }),
      });

      await settle(runner);

      expect((await chain())?.finishedAt).toBeInstanceOf(Date);
    });

    it('a restart mid-chain resumes it rather than starting another', async () => {
      await seed(6);
      const insert = harness.methods.insertSearchRecords;
      let inserts = 0;
      const first = createRunner(harness, {
        ...on,
        methods: withMethods(harness, {
          insertSearchRecords: async (...args) => {
            inserts += 1;
            if (inserts === 2) {
              throw new Error('killed');
            }
            return insert(...args);
          },
        }),
      });
      await settle(first, 1);
      const { requestId } = (await chain()) as unknown as { requestId: string };
      const { processed } = (await stateOf(harness, BACKFILL_KEYS.messages)) as unknown as {
        processed: number;
      };
      await first.stop();

      const read = jest.fn(harness.methods.readSearchSources);
      const restarted = createRunner(harness, {
        ...on,
        methods: withMethods(harness, { readSearchSources: read }),
      });
      await settle(restarted);

      expect(await chain()).toMatchObject({ requestId });
      expect((await chain())?.finishedAt).toBeInstanceOf(Date);
      expect(await stateOf(harness, BACKFILL_KEYS.messages)).toMatchObject({ processed: 6 });
      expect(processed).toBeGreaterThan(0);
      expect(read.mock.calls[0][0].afterId).toEqual(expect.any(String));
    });

    it('a finished chain does not start again, on any later restart', async () => {
      await seed();
      const first = createRunner(harness, on);
      await settle(first);
      const finished = await chain();
      await first.stop();
      await storeSources(harness, 'messages', [sourceMessage({ text: 'kerfi' })]);

      const restarted = createRunner(harness, on);
      await settle(restarted);

      expect(await chain()).toEqual(finished);
      expect(await recordCount(harness, 'msearch')).toBe(3);
      expect(await harness.methods.listSearchJobRequests()).toHaveLength(0);
    });
  });
});
