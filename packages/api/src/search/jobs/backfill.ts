import { isIndexableSource } from '@librechat/data-schemas';
import type {
  ConversationSearchRecord,
  MessageSearchRecord,
  SearchMethods,
  SearchSourceCollection,
  SearchSourceRow,
} from '@librechat/data-schemas';
import type { JobControl, JobOutcome } from './control';
import type { Analyzer } from '../analyzer/analyze';
import type { SearchMetrics } from '../metrics';
import {
  BACKFILL_KEYS,
  giveWay,
  JOB_STATE_READ,
  objectIdFloor,
  SOURCE_COLLECTIONS,
} from './control';
import { buildConversationRecord, buildMessageRecord } from '../sync/record';

export type BackfillMethods = Pick<
  SearchMethods,
  | 'readSearchState'
  | 'writeSearchState'
  | 'readSearchSources'
  | 'readSearchSourcesById'
  | 'countSearchSources'
  | 'insertSearchRecords'
  | 'deleteSearchRecords'
>;

const REPORT_EVERY_MS = 60_000;
/** Weight of the latest batch in the reported rate, so it follows the current pace. */
const RATE_WEIGHT = 0.3;
/**
 * How far behind the walk's end its finishing position sits. IDs are made by app processes,
 * so a row saved just after the last read can sort below it. Older rows have all landed.
 */
const SETTLE_MS = 60_000;

const EXCLUDE_PATH = { messages: 'subagentTask', conversations: 'subagentThread' } as const;

export interface BackfillDeps {
  methods: BackfillMethods;
  analyzer: Analyzer;
  version: string;
  control: JobControl;
  metrics: Pick<SearchMetrics, 'backfill'>;
  now?: () => number;
}

/** Fills the record collections from existing sources. Reads sources; writes only records and state. */
export async function runBackfill(deps: BackfillDeps): Promise<JobOutcome> {
  for (const collection of SOURCE_COLLECTIONS) {
    const outcome = await walkCollection(deps, collection);
    if (outcome !== 'done') {
      return outcome;
    }
  }
  return 'done';
}

function buildRecord(
  collection: SearchSourceCollection,
  source: SearchSourceRow,
  options: { analyzer: Analyzer; version: string },
): MessageSearchRecord | ConversationSearchRecord | null {
  return collection === 'messages'
    ? buildMessageRecord(source, options)
    : buildConversationRecord(source, options);
}

async function walkCollection(
  { methods, analyzer, version, control, metrics, now = Date.now }: BackfillDeps,
  collection: SearchSourceCollection,
): Promise<JobOutcome> {
  const key = BACKFILL_KEYS[collection];
  const saved = await methods.readSearchState(key, JOB_STATE_READ);
  if (saved?.status === 'finished') {
    return 'done';
  }

  let lastId = typeof saved?.lastId === 'string' ? saved.lastId : undefined;
  let processed = typeof saved?.processed === 'number' ? saved.processed : 0;
  let skipped = typeof saved?.skipped === 'number' ? saved.skipped : 0;
  let rate = 0;
  let batchStart = now();
  let reportedAt = 0;

  const report = (status: 'running' | 'paused' | 'finished' | 'failed') => {
    metrics.backfill({
      collection,
      rate: Math.round(rate),
      processed,
      status,
      ...(status === 'paused' ? { pausedReason: 'operator' as const } : {}),
    });
    reportedAt = now();
  };

  try {
    await methods.writeSearchState(key, {
      status: 'running',
      startedAt: saved?.startedAt ?? new Date(now()),
      total: await methods.countSearchSources(collection),
    });

    for (;;) {
      const stop = await control.check();
      if (stop === 'paused') {
        await methods.writeSearchState(key, { status: 'paused', pausedReason: 'operator' });
        report('paused');
      }
      if (stop) {
        return stop;
      }

      const rows = await methods.readSearchSources({
        collection,
        afterId: lastId,
        limit: control.batchSize,
        withText: true,
      });
      /* Only an empty page ends the walk: a single-batch read can stop short at 16 MB. */
      if (rows.length === 0) {
        break;
      }

      const records: Array<MessageSearchRecord | ConversationSearchRecord> = [];
      for (const row of rows) {
        try {
          const record = buildRecord(collection, row, { analyzer, version });
          if (record) {
            records.push(record);
          }
        } catch {
          /* A row with no usable `user` or date, or a pack throwing on a word. No text is logged. */
          skipped += 1;
        }
        await giveWay();
      }

      if (!control.holds()) {
        return 'lost';
      }
      await methods.insertSearchRecords(collection, records);
      await removeRecordsOfGoneSources(methods, collection, records);

      lastId = rows[rows.length - 1]._id;
      processed += rows.length;
      const current = rows.length / (Math.max(now() - batchStart, 1) / 1000);
      rate = rate === 0 ? current : rate * (1 - RATE_WEIGHT) + current * RATE_WEIGHT;
      await methods.writeSearchState(key, {
        lastId,
        processed,
        skipped,
        rate,
        rateAt: new Date(now()),
      });
      if (now() - reportedAt >= REPORT_EVERY_MS) {
        report('running');
      }
      await control.wait();
      batchStart = now();
    }

    await methods.writeSearchState(key, {
      status: 'finished',
      finishedAt: new Date(now()),
      finishedAtId: finishingPosition(lastId, now()),
      rate: 0,
    });
    report('finished');
    return 'done';
  } catch (error) {
    report('failed');
    await methods.writeSearchState(key, { status: 'failed' }).catch(() => undefined);
    throw error;
  }
}

/** Where verification stops while no writer runs: nothing past here was promised a record. */
function finishingPosition(lastId: string | undefined, at: number): string {
  const settled = objectIdFloor(at - SETTLE_MS);
  return lastId != null && lastId < settled ? lastId : settled;
}

/**
 * A source can be deleted or turn temporary between this batch's read and its write, and
 * the insert would bring its record back (FR-022, R-09). One read after the write settles it.
 */
async function removeRecordsOfGoneSources(
  methods: BackfillMethods,
  collection: SearchSourceCollection,
  records: ReadonlyArray<{ _id: string }>,
): Promise<void> {
  const ids = records.map(({ _id }) => _id);
  const current = await methods.readSearchSourcesById(collection, ids);
  const kept = new Set(
    current.filter((row) => isIndexableSource(row, EXCLUDE_PATH[collection])).map(({ _id }) => _id),
  );
  await methods.deleteSearchRecords(
    collection,
    ids.filter((id) => !kept.has(id)),
  );
}
