import mongoose from 'mongoose';
import type { DeepPartial, ConversationSearchConfig } from 'librechat-data-provider';
import type { SearchHarness } from '../../../__tests__/helpers/harness';
import type { SearchJobRunnerDeps } from '../../runner';
import type { JobControl } from '../../control';
import { computeAnalyzerVersion } from '../../../analyzer/version';
import { searchConfig } from '../../../__tests__/helpers/harness';
import { createSearchConfigSnapshot } from '../../../config';
import { createSearchJobRunner } from '../../runner';

export const jobConfig = (search: DeepPartial<ConversationSearchConfig> = {}) =>
  createSearchConfigSnapshot({
    search: searchConfig({
      languages: ['fake', 'en'],
      syncTakeoverSeconds: 30,
      ...search,
      jobs: { batchSize: 2, batchDelayMs: 1, ...search.jobs },
    }),
  });

export const objectId = () => new mongoose.Types.ObjectId().toHexString();

/** A source written straight to its collection, as an existing tenant holds it. */
export async function storeSources(
  harness: SearchHarness,
  collection: 'messages' | 'conversations',
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await harness.database.connection
    .db!.collection(collection)
    .insertMany(
      rows.map((row) => ({ ...row, _id: new mongoose.Types.ObjectId(String(row._id)) })) as never[],
    );
}

export const recordCount = (harness: SearchHarness, name: 'msearch' | 'csearch') =>
  harness.database.connection.db!.collection(name).countDocuments();

export const stateOf = (harness: SearchHarness, key: string) =>
  harness.methods.readSearchState(key, { maxTimeMS: 5000 });

/**
 * The stream state a healthy sync writer keeps. Verification fails without a saved position,
 * and these tests run the job runner with no writer beside it, so they state it: saved now,
 * and caught up far enough ahead that no recheck waits.
 */
export const writerSaved = (harness: SearchHarness) =>
  harness.methods.writeSearchState('stream', {
    savedAt: new Date(),
    syncedTo: new Date(Date.now() + 3_600_000),
  });

/** Lets another holder take over at once, as the lease running out would. */
export const expireLease = (harness: SearchHarness) =>
  harness.methods.writeSearchState('lease', { leaseUntil: new Date(0) });

export function createRunner(
  harness: SearchHarness,
  overrides: Partial<SearchJobRunnerDeps> & { search?: Parameters<typeof jobConfig>[0] } = {},
) {
  const { search, ...rest } = overrides;
  return createSearchJobRunner({
    config: jobConfig(search),
    methods: harness.methods,
    metrics: harness.metrics,
    logger: harness.logger,
    service: {
      jobAnalyzer: () => ({
        analyzer: harness.analyzer,
        version: computeAnalyzerVersion(harness.packs),
      }),
    },
    ...rest,
  });
}

/** Heartbeats until the runner has nothing running, as its timer would. */
export async function settle(runner: { tick(): Promise<void>; idle(): Promise<void> }, rounds = 3) {
  for (let round = 0; round < rounds; round += 1) {
    await runner.tick();
    await runner.idle();
  }
}

/** A control with no lease or pause behind it, stopping when `stopAfter` checks have passed. */
export function freeControl(
  options: {
    batchSize?: number;
    copyBatchSize?: number;
    stopAfter?: number;
    stop?: 'paused' | 'lost';
  } = {},
): JobControl {
  let checks = 0;
  return {
    batchSize: options.batchSize ?? 2,
    copyBatchSize: options.copyBatchSize ?? 2,
    holds: () => true,
    check: async () => {
      checks += 1;
      return options.stopAfter !== undefined && checks > options.stopAfter
        ? (options.stop ?? 'lost')
        : null;
    },
    wait: async () => undefined,
  };
}

/** Methods with one replaced, leaving the rest real. */
export const withMethods = (
  harness: SearchHarness,
  overrides: Partial<SearchHarness['methods']>,
): SearchHarness['methods'] => ({ ...harness.methods, ...overrides });
