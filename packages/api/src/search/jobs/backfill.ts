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
  ANALYZER_KEY,
  BACKFILL_KEYS,
  giveWay,
  JOB_STATE_READ,
  SOURCE_COLLECTIONS,
} from './control';
import { belongsInSearch, buildConversationRecord, buildMessageRecord } from '../sync/record';
import { removeRecordsOfGoneSources } from './check';
import { holdTenantPin } from '../sync/tenant';

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
  let analysisFailures = typeof saved?.analysisFailures === 'number' ? saved.analysisFailures : 0;
  let rate = 0;
  let batchStart = now();
  let reportedAt = 0;
  const analyzerState = await methods.readSearchState(ANALYZER_KEY, JOB_STATE_READ);
  let pinned = typeof analyzerState?.tenantId === 'string' ? analyzerState.tenantId : null;

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
      /* Before any of these rows is indexed: backfill reads every row, as the writer does (R-04). */
      pinned = await holdTenantPin(
        methods,
        rows.map(({ tenantId }) => tenantId),
        pinned,
      );

      const records: Array<MessageSearchRecord | ConversationSearchRecord> = [];
      for (const row of rows) {
        try {
          const record = buildRecord(collection, row, { analyzer, version });
          if (record) {
            records.push(record);
          }
        } catch {
          /*
           * No text is logged. A row with no usable `user` or date can never have a record.
           * One that should have, where a pack threw on a word, is a gap verification must see.
           */
          if (belongsInSearch(collection, row)) {
            analysisFailures += 1;
          } else {
            skipped += 1;
          }
        }
        await giveWay();
      }

      if (!control.holds()) {
        return 'lost';
      }
      await methods.insertSearchRecords(collection, records);
      await removeRecordsOfGoneSources(
        methods,
        collection,
        records.map(({ _id }) => _id),
      );
      if (!control.holds()) {
        return 'lost';
      }

      lastId = rows[rows.length - 1]._id;
      processed += rows.length;
      const current = rows.length / (Math.max(now() - batchStart, 1) / 1000);
      rate = rate === 0 ? current : rate * (1 - RATE_WEIGHT) + current * RATE_WEIGHT;
      /* From here, so the next batch's rate includes the throttle, as the real pace does. */
      batchStart = now();
      await methods.writeSearchState(key, {
        lastId,
        processed,
        skipped,
        analysisFailures,
        rate,
        rateAt: new Date(now()),
      });
      if (now() - reportedAt >= REPORT_EVERY_MS) {
        report('running');
      }
      await control.wait();
    }

    if (!control.holds()) {
      return 'lost';
    }
    await methods.writeSearchState(key, {
      status: 'finished',
      finishedAt: new Date(now()),
      rate: 0,
    });
    report('finished');
    return 'done';
  } catch (error) {
    report('failed');
    /* A stale holder must not mark a walk failed that the new holder is running or finished. */
    if (control.holds()) {
      await methods.writeSearchState(key, { status: 'failed' }).catch(() => undefined);
    }
    throw error;
  }
}
