import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import type { SearchHarness } from '../../../__tests__/helpers/harness';
import type { SearchWriterDeps } from '../../writer';
import { createRunner, jobConfig } from '../../../jobs/__tests__/helpers/jobs';
import { computeAnalyzerVersion } from '../../../analyzer/version';
import { createSearchWriter } from '../../writer';
import { createSearchLease } from '../../lease';

export interface SyncProcess {
  lease: ReturnType<typeof createSearchLease>;
  runner: ReturnType<typeof createRunner>;
  writer: ReturnType<typeof createSearchWriter>;
  /** Takes the lease with one heartbeat, then starts the writer. */
  start(): Promise<void>;
  /** As a shutdown does: writer first, then the runner, which gives the lease up. */
  stop(): Promise<void>;
}

/** One app process's runner and writer, sharing one lease, tuned so tests run in seconds. */
export function createSyncProcess(
  harness: SearchHarness,
  overrides: {
    search?: Parameters<typeof jobConfig>[0];
    methods?: SearchHarness['methods'];
    service?: SearchWriterDeps['service'];
    writer?: Partial<SearchWriterDeps>;
    now?: () => number;
  } = {},
): SyncProcess {
  const config = jobConfig(overrides.search);
  const methods = overrides.methods ?? harness.methods;
  const service = overrides.service ?? {
    jobAnalyzer: () => ({
      analyzer: harness.analyzer,
      version: computeAnalyzerVersion(harness.packs),
      packs: harness.packs,
    }),
  };
  const lease = createSearchLease({
    methods,
    holder: randomUUID(),
    takeoverSeconds: config.syncTakeoverSeconds,
    packsLoaded: () => service.jobAnalyzer() !== null,
    metrics: harness.metrics,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  const runner = createRunner(harness, {
    search: overrides.search,
    methods,
    service,
    lease,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  const writer = createSearchWriter({
    config,
    methods,
    metrics: harness.metrics,
    logger: harness.logger,
    service,
    lease,
    pollMs: 20,
    retryDelayMs: 10,
    idleSaveMs: 40,
    maxAwaitTimeMS: 40,
    ...overrides.writer,
  });
  return {
    lease,
    runner,
    writer,
    async start() {
      await runner.tick();
      writer.start();
    },
    async stop() {
      await writer.stop();
      await runner.stop();
    },
  };
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  { timeoutMs = 20_000, label = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Resolves once the writer has read the stream past this moment, so every earlier write is
 * applied. The margin covers a write still becoming visible to change streams.
 */
export async function synced(harness: SearchHarness, timeoutMs?: number): Promise<void> {
  const since = Date.now() + 250;
  await waitFor(
    async () => {
      const stream = await harness.methods.readSearchState('stream', { maxTimeMS: 5000 });
      return stream?.syncedTo instanceof Date && stream.syncedTo.getTime() > since;
    },
    { timeoutMs, label: 'the writer to catch up' },
  );
}

export const sources = (harness: SearchHarness, name: 'messages' | 'conversations') =>
  harness.database.connection.db!.collection(name);

export const recordOf = (harness: SearchHarness, name: 'msearch' | 'csearch', id: string) =>
  harness.database.connection
    .db!.collection(name)
    .findOne({ _id: new mongoose.Types.ObjectId(id) });

export const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** An ID minted `agoMs` in the past, as an app process creates them. */
export const idFrom = (agoMs: number) =>
  mongoose.Types.ObjectId.createFromTime(Math.floor((Date.now() - agoMs) / 1000))
    .toHexString()
    .slice(0, 8) + new mongoose.Types.ObjectId().toHexString().slice(8);

export const eventsOf = (harness: SearchHarness, name: string) =>
  harness.logged.filter(({ event }) => event === name).map(({ meta }) => meta);
