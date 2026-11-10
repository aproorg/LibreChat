import type { SearchHarness } from '../__tests__/helpers/harness';
import {
  createSearchHarness,
  sourceMessage,
  sourceConversation,
} from '../__tests__/helpers/harness';
import { formatSearchJobStatus, readSearchJobStatus, runSearchJobCommand } from './script';
import { storeSources } from './__tests__/helpers/jobs';
import { BACKFILL_KEYS } from './control';

describe('search-job script', () => {
  let harness: SearchHarness;
  const NOW = Date.parse('2026-06-01T12:00:00Z');

  const run = async (...argv: string[]) => {
    const lines: string[] = [];
    const code = await runSearchJobCommand({
      argv,
      methods: harness.methods,
      print: (line) => lines.push(line),
      now: () => NOW,
    });
    return { code, lines };
  };

  beforeAll(async () => {
    harness = await createSearchHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  it.each(['backfill', 'pause', 'resume', 'reconcile', 'verify'])(
    '%s writes one request and runs nothing',
    async (job) => {
      const { code } = await run(job);

      expect(code).toBe(0);
      const requests = await harness.methods.listSearchJobRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ job, requestedAt: new Date(NOW) });
      expect(requests[0]._id).toMatch(/^jobRequest:/);
      expect(await harness.methods.readSearchState('chain', { maxTimeMS: 5000 })).toBeNull();
    },
  );

  it.each(['drop', 'nonsense', undefined])('rejects %s with usage', async (job) => {
    const { code, lines } = await run(...(job ? [job] : []));

    expect(code).toBe(2);
    expect(lines.join()).toContain('Usage');
    expect(await harness.methods.listSearchJobRequests()).toHaveLength(0);
  });

  it('writes no backfill request while a chain runs, and says why', async () => {
    await harness.methods.writeSearchState('chain', { step: 'vocab' });

    const { code, lines } = await run('backfill');

    expect(code).toBe(0);
    expect(lines.join()).toContain('already at step vocab');
    expect(await harness.methods.listSearchJobRequests()).toHaveLength(0);
  });

  it('warns when a request waits with no holder, and not when one holds', async () => {
    expect((await run('verify')).lines.join()).toContain('No process holds the lease');

    await harness.methods.writeSearchState('lease', { leaseUntil: new Date(NOW + 1000) });

    expect((await run('verify')).lines.join()).not.toContain('No process holds the lease');
  });

  it('refuses a request where search data was never on, and creates no collection', async () => {
    const db = harness.database.connection.db!;
    await db.dropDatabase();

    const { code } = await run('backfill');

    expect(code).toBe(1);
    const names = (await db.listCollections().toArray()).map(({ name }) => name);
    expect(names).not.toContain('search_state');
  });

  describe('status', () => {
    it('only reads', async () => {
      const db = harness.database.connection.db!;
      await db.dropDatabase();

      const { code } = await run('status');

      expect(code).toBe(0);
      expect((await db.listCollections().toArray()).map(({ name }) => name)).not.toContain(
        'search_state',
      );
    });

    it('shows step, processed, total, rate, estimated finish and the verify result', async () => {
      await harness.methods.writeSearchState('chain', {
        step: 'backfill',
        startedAt: new Date(NOW - 1000),
      });
      await harness.methods.writeSearchState(BACKFILL_KEYS.messages, {
        status: 'running',
        processed: 1000,
        total: 3000,
        skipped: 2,
        rate: 100,
        rateAt: new Date(NOW - 1000),
      });
      await harness.methods.writeSearchState(BACKFILL_KEYS.conversations, {
        status: 'finished',
        processed: 7,
        total: 7,
      });
      await harness.methods.writeSearchState('verification', {
        status: 'failed',
        reason: 'mismatch',
        mismatchedUsers: 2,
        missing: 3,
      });

      const status = await readSearchJobStatus(harness.methods, NOW);

      expect(status.chain.step).toBe('backfill');
      expect(status.collections.messages).toEqual({
        status: 'running',
        processed: 1000,
        total: 3000,
        skipped: 2,
        analysisFailures: 0,
        rate: 100,
        estimatedFinish: new Date(NOW + 20_000),
      });
      expect(status.collections.conversations).toMatchObject({
        processed: 7,
        rate: null,
        estimatedFinish: null,
      });
      const text = formatSearchJobStatus(status).join('\n');
      expect(text).toContain('chain step: backfill');
      expect(text).toContain('messages: running  processed 1000 of about 3000');
      expect(text).toContain('rate 100/s');
      expect(text).toContain(new Date(NOW + 20_000).toISOString());
      expect(text).toContain(
        'verify: failed  checked -  reason mismatch  mismatched users 2  missing 3',
      );
    });

    it('still reports progress when the tenant read fails', async () => {
      await harness.methods.writeSearchState('chain', {
        step: 'verify',
        failures: 3,
        finishedAt: new Date(NOW),
      });
      const methods = {
        ...harness.methods,
        readSearchSourceTenants: () => Promise.reject(new Error('timed out')),
      };

      const status = await readSearchJobStatus(methods, NOW);

      expect(status.tenants).toBeNull();
      expect(status.chain).toMatchObject({ step: 'verify', failures: 3 });
      const text = formatSearchJobStatus(status).join('\n');
      expect(text).toContain('distinct tenantId values: not read');
      expect(text).toContain('failed attempts: 3');
    });

    it.each([
      ['no chain', {}, 'next: run backfill'],
      [
        'a request and no holder',
        { 'jobRequest:a': { job: 'backfill' } },
        'no process holds the lease',
      ],
      [
        'a request and a holder',
        { 'jobRequest:a': { job: 'backfill' }, lease: { leaseUntil: new Date(NOW + 1000) } },
        'picks up the request',
      ],
      [
        'paused',
        { chain: { step: 'backfill' }, 'backfill:messages': { pause: true } },
        'next: run resume',
      ],
      ['no holder', { chain: { step: 'vocab' } }, 'no process holds the lease'],
      [
        'retrying',
        {
          chain: { step: 'vocab', failures: 2 },
          lease: { leaseUntil: new Date(NOW + 1000) },
        },
        '[search] Job failed',
      ],
      [
        'failed verify',
        {
          chain: { step: 'verify', finishedAt: new Date(NOW) },
          verification: {
            status: 'failed',
            reason: 'mismatch',
            missing: 1,
            missingIds: ['abc123'],
          },
        },
        'run backfill to fill the gaps',
      ],
    ])('names the next action: %s', async (_name, state, expected) => {
      for (const [key, fields] of Object.entries(state)) {
        await harness.methods.writeSearchState(key, fields as Record<string, unknown>);
      }

      const { lines } = await run('status');

      expect(lines[lines.length - 1]).toContain(expected);
    });

    it('prints the failure code and the sample of missing IDs', async () => {
      await harness.methods.writeSearchState('chain', {
        step: 'verify',
        failures: 1,
        lastFailureCode: 'MongoServerError:13',
      });
      await harness.methods.writeSearchState('verification', {
        status: 'failed',
        missingIds: ['abc123'],
      });

      const text = (await run('status')).lines.join('\n');

      expect(text).toContain('MongoServerError:13');
      expect(text).toContain('abc123');
    });

    it('does not walk the sources for tenants while a chain is running', async () => {
      await harness.methods.writeSearchState('chain', { step: 'backfill' });
      const readTenants = jest.fn(harness.methods.readSearchSourceTenants);

      const status = await readSearchJobStatus(
        { ...harness.methods, readSearchSourceTenants: readTenants },
        NOW,
      );

      expect(readTenants).not.toHaveBeenCalled();
      expect(status.tenants).toBeNull();
    });

    it('gives no rate from a process that stopped reporting', async () => {
      await harness.methods.writeSearchState(BACKFILL_KEYS.messages, {
        status: 'running',
        processed: 1,
        total: 2,
        rate: 100,
        rateAt: new Date(NOW - 10 * 60_000),
      });

      const { collections } = await readSearchJobStatus(harness.methods, NOW);

      expect(collections.messages).toMatchObject({ rate: null, estimatedFinish: null });
    });

    it('reports distinct tenant values, and whether a request waits', async () => {
      await storeSources(harness, 'messages', [
        sourceMessage({ text: 'a', tenantId: 'tenant-one' }),
        sourceMessage({ text: 'b', tenantId: 'tenant-two' }),
        sourceMessage({ text: 'c' }),
      ]);
      await storeSources(harness, 'conversations', [
        sourceConversation({ tenantId: 'tenant-one' }),
      ]);
      await run('pause');

      const status = await readSearchJobStatus(harness.methods, NOW);

      expect(status.tenants?.sort()).toEqual(['tenant-one', 'tenant-two']);
      expect(status.pendingRequests).toEqual(['pause']);
    });
  });
});
