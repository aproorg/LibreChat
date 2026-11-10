import type {
  SearchMethods,
  SearchSourceCollection,
  SearchSourceRow,
} from '@librechat/data-schemas';
import type { JobControl, JobOutcome } from './control';
import type { SearchMetrics } from '../metrics';
import {
  BACKFILL_KEYS,
  JOB_STATE_READ,
  objectIdFloor,
  SOURCE_COLLECTIONS,
  STREAM_KEY,
  VERIFICATION_KEY,
} from './control';
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

/** Only sources older than this at the snapshot count (R-11). */
const MIN_AGE_MS = 60_000;
/** A sample for the operator: IDs only, and a mass failure must not grow the state document. */
const MAX_REPORTED_IDS = 20;
/** How long a recheck waits for the writer to pass the moment it read a suspect. */
const SYNC_WAIT_MS = 60_000;
const SYNC_POLL_MS = 500;
/** A committed write can reach change streams a little after it returns. */
const SYNC_MARGIN_MS = 1000;

interface VerifyTally {
  checked: number;
  /**
   * Sources that should have a record and have none. With no writer yet, only those that have
   * not changed since backfill began.
   */
  missing: number;
  /** Records whose source is gone or no longer belongs. A failure only once a writer runs. */
  orphans: number;
  /** With no writer yet: sources with no record that changed after backfill began. */
  changedSinceBackfill: number;
  /** The writer did not pass a recheck's moment in time, so a suspect may be sync lag. */
  syncBehind: boolean;
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
const figures = ({ users, syncBehind: _syncBehind, ...tally }: VerifyTally) => ({
  ...tally,
  mismatchedUsers: users.size,
});

/**
 * Which limits apply (R-11). Until a sync writer has saved a stream position, nothing writes
 * a record for a message created after backfill, so verification checks sources only up to the
 * position backfill finished at, and neither orphans nor sources changed since backfill fail
 * it. Once the writer has saved a position, every source older than the age floor is checked,
 * and both count.
 */
export type VerifyMode = 'backfill' | 'writer';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/**
 * Compares sources and records by ID. Readiness rests on its result. A restart runs it again
 * from the start, because it holds its figures in memory and a pass needs a whole walk.
 * See `VerifyMode` for the limits that apply before a sync writer has run.
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
  const previous = await methods.readSearchState(VERIFICATION_KEY, JOB_STATE_READ);
  const stream = await methods.readSearchState(STREAM_KEY, JOB_STATE_READ);
  const mode: VerifyMode = stream?.savedAt instanceof Date ? 'writer' : 'backfill';
  /* A re-check of a passing tenant keeps search shown: only its result can take it away. */
  await methods.writeSearchState(VERIFICATION_KEY, {
    status: previous?.status === 'passed' ? 'passed' : 'pending',
    running: true,
    snapshotAt: new Date(snapshotAt),
    rounds: round,
    mode,
    gaveUp: false,
    reason: null,
    checked: 0,
    missing: 0,
    missingIds: [],
    orphans: 0,
    changedSinceBackfill: 0,
    analysisFailures: 0,
    otherVersion: 0,
    mismatchedUsers: 0,
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
    syncBehind: false,
  };
  const finish = async (status: 'passed' | 'failed', reason: string | null) => {
    if (!control.holds()) {
      return 'lost' as const;
    }
    await methods.writeSearchState(VERIFICATION_KEY, {
      ...figures(tally),
      running: false,
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
    const floor = objectIdFloor(snapshotAt - MIN_AGE_MS);
    const outcome = await walkCollection({
      methods,
      control,
      collection,
      upToId: mode === 'writer' ? floor : lowerOf(position, floor),
      backfillStartedAt: mode === 'writer' ? null : timeOf(backfill.startedAt),
      mode,
      version,
      tally,
      now,
    });
    if (outcome !== 'done') {
      return outcome;
    }
  }

  const failures = tally.missing + tally.analysisFailures + (mode === 'writer' ? tally.orphans : 0);
  if (failures === 0) {
    return finish('passed', null);
  }
  /*
   * Rows a pack threw on stay counted until a new backfill re-reads them, so reconcile cannot
   * clear them and the mismatch loop must not run on them alone.
   */
  if (failures === tally.analysisFailures) {
    return finish('failed', 'analysis_failed');
  }
  return finish('failed', tally.syncBehind ? 'sync_behind' : 'mismatch');
}

async function walkCollection({
  methods,
  control,
  collection,
  upToId,
  backfillStartedAt,
  mode,
  version,
  tally,
  now,
}: {
  methods: VerifyMethods;
  control: JobControl;
  collection: SearchSourceCollection;
  upToId: string;
  backfillStartedAt: number | null;
  mode: VerifyMode;
  version: string;
  tally: VerifyTally;
  now: () => number;
}): Promise<JobOutcome> {
  const settle: Settle = { methods, control, mode, tally, now };
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
      settle,
      collection,
      rows.filter(({ _id }) => belonging.has(_id) && !recordIds.has(_id)),
      backfillStartedAt,
    );
    await recheckRecords(
      settle,
      collection,
      [...recordIds].filter((id) => !belonging.has(id)),
    );

    await methods.writeSearchState(VERIFICATION_KEY, { checked: tally.checked });
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

interface Settle {
  methods: VerifyMethods;
  control: JobControl;
  mode: VerifyMode;
  tally: VerifyTally;
  now: () => number;
}

/**
 * Re-reads suspects against current state. With a writer running, a suspect still wrong is
 * read once more after the writer has passed the moment of the first read, so a change still
 * inside sync lag is not called a gap (R-11).
 */
async function settleSuspects<T>(
  { methods, control, mode, tally, now }: Settle,
  ids: readonly string[],
  read: (ids: readonly string[]) => Promise<T[]>,
  wrong: (found: T[]) => T[],
): Promise<T[]> {
  if (ids.length === 0) {
    return [];
  }
  const readAt = now();
  const suspects = wrong(await read(ids));
  /* Once sync is known to be behind, waiting again on each batch only holds the job slot. */
  if (mode !== 'writer' || suspects.length === 0 || tally.syncBehind) {
    return suspects;
  }
  if (!(await waitForSync(methods, control, readAt, now))) {
    tally.syncBehind = true;
  }
  return wrong(await read(ids));
}

/** Gives up when this turn ends, so a shutdown or takeover is not held for the whole wait. */
async function waitForSync(
  methods: VerifyMethods,
  control: JobControl,
  since: number,
  now: () => number,
): Promise<boolean> {
  const deadline = now() + SYNC_WAIT_MS;
  for (;;) {
    if (!control.holds()) {
      return false;
    }
    const stream = await methods.readSearchState(STREAM_KEY, JOB_STATE_READ);
    const syncedTo = timeOf(stream?.syncedTo);
    if (syncedTo !== null && syncedTo > since + SYNC_MARGIN_MS) {
      return true;
    }
    if (now() >= deadline) {
      return false;
    }
    await sleep(SYNC_POLL_MS);
  }
}

/** Each suspect is read again, so a row that settled during the walk is not called a gap. */
async function recheckSources(
  settle: Settle,
  collection: SearchSourceCollection,
  suspects: readonly SearchSourceRow[],
  backfillStartedAt: number | null,
): Promise<void> {
  const { methods, tally } = settle;
  const missing = await settleSuspects(
    settle,
    suspects.map(({ _id }) => _id),
    async (ids) => {
      const [current, records] = await Promise.all([
        methods.readSearchSourcesById(collection, ids),
        methods.readSearchRecordIdsIn(collection, ids),
      ]);
      const withRecord = new Set(records);
      return current.filter((row) => !withRecord.has(row._id) && belongsInSearch(collection, row));
    },
    (rows) => rows,
  );
  for (const row of missing) {
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
  settle: Settle,
  collection: SearchSourceCollection,
  suspects: readonly string[],
): Promise<void> {
  const { methods, tally } = settle;
  const orphans = await settleSuspects(
    settle,
    suspects,
    async (ids) => {
      const [current, records] = await Promise.all([
        methods.readSearchSourcesById(collection, ids),
        methods.readSearchRecordIdsIn(collection, ids),
      ]);
      const belonging = new Set(
        current.filter((row) => belongsInSearch(collection, row)).map(({ _id }) => _id),
      );
      return records.filter((id) => !belonging.has(id));
    },
    (ids) => ids,
  );
  tally.orphans += orphans.length;
}
