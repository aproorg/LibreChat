import type {
  SearchMethods,
  SearchSourceCollection,
  SearchSourceRow,
} from '@librechat/data-schemas';
import type { JobControl, JobOutcome } from './control';
import type { SearchMetrics } from '../metrics';
import { BACKFILL_KEYS, JOB_STATE_READ, objectIdFloor, SOURCE_COLLECTIONS } from './control';
import { belongsInSearch } from '../sync/record';

export type VerifyMethods = Pick<
  SearchMethods,
  | 'readSearchState'
  | 'writeSearchState'
  | 'readSearchSources'
  | 'readSearchSourcesById'
  | 'readSearchRecordIds'
  | 'countSearchRecordsAtOtherVersion'
  | 'readSearchRecordIdsIn'
>;

const VERIFICATION_KEY = 'verification';
/** Only sources older than this at the snapshot count (R-11). */
const MIN_AGE_MS = 60_000;
/** A sample for the operator: IDs only, and a mass failure must not grow the state document. */
const MAX_REPORTED_IDS = 20;

interface VerifyTally {
  checked: number;
  /** Sources that should have a record, have none, and have not changed since backfill began. */
  missing: number;
  /** Records whose source is gone or no longer belongs. Reported, not a failure, with no writer. */
  orphans: number;
  /** Sources with no record that changed after backfill began, which only a writer picks up. */
  changedSinceBackfill: number;
  /** Rows backfill could not analyze, whatever has happened to them since. */
  analysisFailures: number;
  /**
   * Records another analyzer wrote. Insert-only backfill keeps them, and only reconcile
   * rewrites them, so they are reported rather than failed: they still match by exact form.
   */
  otherVersion: number;
  users: Set<string>;
  missingIds: string[];
}

export interface VerifyDeps {
  methods: VerifyMethods;
  control: JobControl;
  metrics: Pick<SearchMetrics, 'verify'>;
  /** The analyzer version in use now. */
  version: string;
  /** Which verification round this is, for `search.verify`. */
  round: number;
  now?: () => number;
}

const timeOf = (value: unknown): number | null => (value instanceof Date ? value.getTime() : null);
const lowerOf = (a: string, b: string): string => (a < b ? a : b);
const figures = ({ users, ...tally }: VerifyTally) => ({ ...tally, mismatchedUsers: users.size });

/**
 * Compares sources and records by ID. Readiness rests on its result. A restart runs it again
 * from the start, because it holds its figures in memory and a pass needs a whole walk.
 *
 * While no sync writer runs, nothing writes a record for a message created after backfill,
 * so an unbounded walk would fail on any live tenant. So this checks sources only up to the
 * position backfill finished at, and treats a source changed after backfill began as out of
 * its reach rather than as a gap. The writer's arrival removes both limits.
 */
export async function runVerify({
  methods,
  control,
  metrics,
  version,
  round,
  now = Date.now,
}: VerifyDeps): Promise<JobOutcome> {
  const snapshotAt = now();
  await methods.writeSearchState(VERIFICATION_KEY, {
    status: 'pending',
    snapshotAt: new Date(snapshotAt),
    rounds: round,
  });

  const tally: VerifyTally = {
    checked: 0,
    missing: 0,
    orphans: 0,
    changedSinceBackfill: 0,
    analysisFailures: 0,
    otherVersion: 0,
    users: new Set(),
    missingIds: [],
  };
  const finish = async (status: 'passed' | 'failed', reason: string | null) => {
    if (!control.holds()) {
      return 'lost' as const;
    }
    await methods.writeSearchState(VERIFICATION_KEY, {
      ...figures(tally),
      status,
      reason,
      finishedAt: new Date(now()),
      ...(status === 'passed' ? { passedAt: new Date(now()) } : {}),
    });
    metrics.verify({ status, mismatchedUsers: tally.users.size, round });
    return 'done' as const;
  };

  for (const collection of SOURCE_COLLECTIONS) {
    const backfill = await methods.readSearchState(BACKFILL_KEYS[collection], JOB_STATE_READ);
    const position = backfill?.finishedAtId;
    if (backfill?.status !== 'finished' || typeof position !== 'string') {
      return finish('failed', 'backfill_not_finished');
    }
    if (typeof backfill.analysisFailures === 'number') {
      tally.analysisFailures += backfill.analysisFailures;
    }
    const outcome = await walkCollection({
      methods,
      control,
      collection,
      upToId: lowerOf(position, objectIdFloor(snapshotAt - MIN_AGE_MS)),
      backfillStartedAt: timeOf(backfill.startedAt),
      version,
      tally,
    });
    if (outcome !== 'done') {
      return outcome;
    }
  }

  return tally.missing + tally.analysisFailures > 0
    ? finish('failed', 'mismatch')
    : finish('passed', null);
}

async function walkCollection({
  methods,
  control,
  collection,
  upToId,
  backfillStartedAt,
  version,
  tally,
}: {
  methods: VerifyMethods;
  control: JobControl;
  collection: SearchSourceCollection;
  upToId: string;
  backfillStartedAt: number | null;
  version: string;
  tally: VerifyTally;
}): Promise<JobOutcome> {
  let afterId: string | undefined;
  for (;;) {
    const stop = await control.check();
    if (stop) {
      return stop;
    }
    const rows = await methods.readSearchSources({
      collection,
      afterId,
      upToId,
      limit: control.batchSize,
    });
    const upper = rows.length > 0 ? rows[rows.length - 1]._id : upToId;
    const recordIds = await readRecordRange(methods, collection, afterId, upper, control.batchSize);

    const belonging = new Set(
      rows.filter((row) => belongsInSearch(collection, row)).map(({ _id }) => _id),
    );
    tally.checked += rows.length;
    tally.otherVersion += await methods.countSearchRecordsAtOtherVersion({
      collection,
      afterId,
      upToId: upper,
      version,
    });
    await recheckSources(
      methods,
      collection,
      rows.filter(({ _id }) => belonging.has(_id) && !recordIds.has(_id)),
      backfillStartedAt,
      tally,
    );
    await recheckRecords(
      methods,
      collection,
      [...recordIds].filter((id) => !belonging.has(id)),
      tally,
    );

    if (rows.length === 0) {
      return 'done';
    }
    afterId = upper;
    await control.wait();
  }
}

async function readRecordRange(
  methods: VerifyMethods,
  collection: SearchSourceCollection,
  afterId: string | undefined,
  upToId: string,
  limit: number,
): Promise<Set<string>> {
  const found = new Set<string>();
  let from = afterId;
  for (;;) {
    const ids = await methods.readSearchRecordIds({ collection, afterId: from, upToId, limit });
    if (ids.length === 0) {
      return found;
    }
    ids.forEach((id) => found.add(id));
    from = ids[ids.length - 1];
  }
}

/** Each suspect is read again, so a row that settled during the walk is not called a gap. */
async function recheckSources(
  methods: VerifyMethods,
  collection: SearchSourceCollection,
  suspects: readonly SearchSourceRow[],
  backfillStartedAt: number | null,
  tally: VerifyTally,
): Promise<void> {
  if (suspects.length === 0) {
    return;
  }
  const ids = suspects.map(({ _id }) => _id);
  const [current, records] = await Promise.all([
    methods.readSearchSourcesById(collection, ids),
    methods.readSearchRecordIdsIn(collection, ids),
  ]);
  const withRecord = new Set(records);
  for (const row of current) {
    if (withRecord.has(row._id) || !belongsInSearch(collection, row)) {
      continue;
    }
    const updatedAt = timeOf(row.updatedAt);
    if (updatedAt !== null && backfillStartedAt !== null && updatedAt > backfillStartedAt) {
      tally.changedSinceBackfill += 1;
      continue;
    }
    tally.missing += 1;
    tally.users.add(String(row.user));
    if (tally.missingIds.length < MAX_REPORTED_IDS) {
      tally.missingIds.push(row._id);
    }
  }
}

async function recheckRecords(
  methods: VerifyMethods,
  collection: SearchSourceCollection,
  suspects: readonly string[],
  tally: VerifyTally,
): Promise<void> {
  if (suspects.length === 0) {
    return;
  }
  const [current, records] = await Promise.all([
    methods.readSearchSourcesById(collection, suspects),
    methods.readSearchRecordIdsIn(collection, suspects),
  ]);
  const belonging = new Set(
    current.filter((row) => belongsInSearch(collection, row)).map(({ _id }) => _id),
  );
  tally.orphans += records.filter((id) => !belonging.has(id)).length;
}
