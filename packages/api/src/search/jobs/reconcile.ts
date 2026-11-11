import type {
  ConversationSearchRecord,
  MessageSearchRecord,
  SearchMethods,
  SearchSourceCollection,
  SearchSourceRow,
  SearchStateEntry,
} from '@librechat/data-schemas';
import type { VocabRebuildMethods } from './vocabRebuild';
import type { JobControl, JobOutcome } from './control';
import type { Analyzer } from '../analyzer/analyze';
import type { SearchMetrics } from '../metrics';
import { belongsInSearch, buildConversationRecord, buildMessageRecord } from '../sync/record';
import { ANALYZER_KEY, giveWay, JOB_STATE_READ, RECONCILE_KEY } from './control';
import { extractConversation, extractMessage } from '../sync/extract';
import { removeRecordsOfGoneSources } from './check';
import { runVocabRebuild } from './vocabRebuild';
import { holdTenantPin } from '../sync/tenant';

export type ReconcileMethods = VocabRebuildMethods &
  Pick<
    SearchMethods,
    | 'readSearchSources'
    | 'readSearchSourcesById'
    | 'readSearchRecordStamps'
    | 'readSearchRecordIds'
    | 'insertSearchRecords'
    | 'rewriteSearchRecords'
    | 'deleteSearchRecords'
    | 'countSearchRecordsAtOtherVersion'
  >;

type Pass = 'count' | 'repair';
type Phase =
  | 'messages→records'
  | 'records→messages'
  | 'conversations→records'
  | 'records→conversations'
  | 'vocab';

const PASSES: readonly Pass[] = ['count', 'repair'];
const PHASES: readonly Phase[] = [
  'messages→records',
  'records→messages',
  'conversations→records',
  'records→conversations',
  'vocab',
];

interface ReconcileState {
  pass: Pass;
  phase: Phase;
  lastIds: Partial<Record<Phase, string>>;
  /** Sources that belong in search with no record. */
  missing: number;
  /** Records whose source is gone or no longer belongs. */
  orphans: number;
  /** Records whose `h` or `v` differs from what the source gives now. */
  stale: number;
  /** Rows the counting pass walked, on both sides. */
  of: number;
  /** Records the repair pass inserted, rewrote or deleted. */
  repaired: number;
  /** Sources with no record that a pack threw on in the repair pass, so they stay without one. */
  analysisFailures: number;
  /** Run inside the chain, where the word list step just ran. */
  inChain: boolean;
}

export interface ReconcileDeps {
  methods: ReconcileMethods;
  analyzer: Analyzer;
  /** The analyzer version in use now. */
  version: string;
  control: JobControl;
  metrics: Pick<SearchMetrics, 'reconcile'>;
  /** In the chain, the word list phase runs only when this run repaired something. */
  inChain: boolean;
  now?: () => number;
}

const numberOf = (value: unknown): number => (typeof value === 'number' ? value : 0);

function readState(saved: SearchStateEntry | null, inChain: boolean): ReconcileState | null {
  if (saved?.status !== 'running') {
    return null;
  }
  return {
    pass: PASSES.includes(saved.pass as Pass) ? (saved.pass as Pass) : 'count',
    phase: PHASES.includes(saved.phase as Phase) ? (saved.phase as Phase) : PHASES[0],
    lastIds: (saved.lastIds ?? {}) as ReconcileState['lastIds'],
    missing: numberOf(saved.missing),
    orphans: numberOf(saved.orphans),
    stale: numberOf(saved.stale),
    of: numberOf(saved.of),
    repaired: numberOf(saved.repaired),
    analysisFailures: numberOf(saved.analysisFailures),
    inChain: typeof saved.inChain === 'boolean' ? saved.inChain : inChain,
  };
}

/**
 * Compares sources and records in both directions per R-11: a counting pass first, logged as
 * `search.reconcile` so drift is known before anything changes (FR-027, SC-010), then a repair
 * pass. Repair is insert-only for a missing record and compare-and-set on the `h` and `v` it
 * read for a stale one, so a live edit between the read and the write wins. Every write is
 * followed by the source check. Resumes from the saved pass, phase and position.
 */
export async function runReconcile(deps: ReconcileDeps): Promise<JobOutcome> {
  const { methods, control, metrics, now = Date.now } = deps;
  const saved = await methods.readSearchState(RECONCILE_KEY, JOB_STATE_READ);
  const state = readState(saved, deps.inChain) ?? {
    pass: 'count',
    phase: PHASES[0],
    lastIds: {},
    missing: 0,
    orphans: 0,
    stale: 0,
    of: 0,
    repaired: 0,
    analysisFailures: 0,
    inChain: deps.inChain,
  };
  if (saved?.status !== 'running') {
    await methods.writeSearchState(RECONCILE_KEY, {
      ...state,
      status: 'running',
      startedAt: new Date(now()),
      finishedAt: null,
    });
  }
  const save = (fields: Partial<ReconcileState>) =>
    methods.writeSearchState(RECONCILE_KEY, { ...fields });

  for (const pass of PASSES.slice(PASSES.indexOf(state.pass))) {
    for (const phase of PHASES.slice(PHASES.indexOf(state.phase))) {
      const outcome = await runPhase(deps, state, pass, phase, save);
      if (outcome !== 'done') {
        return outcome;
      }
      const next = PHASES[PHASES.indexOf(phase) + 1];
      if (next) {
        state.phase = next;
        await save({ phase: next });
      }
    }
    if (pass === 'count') {
      metrics.reconcile({
        missing: state.missing,
        orphans: state.orphans,
        stale: state.stale,
        of: state.of,
      });
      state.pass = 'repair';
      state.phase = PHASES[0];
      state.lastIds = {};
      await save({ pass: 'repair', phase: PHASES[0], lastIds: {} });
    }
  }

  if (!control.holds()) {
    return 'lost';
  }
  await clearAttributionIfReanalyzed(deps);
  await methods.writeSearchState(RECONCILE_KEY, {
    status: 'finished',
    finishedAt: new Date(now()),
  });
  return 'done';
}

function runPhase(
  deps: ReconcileDeps,
  state: ReconcileState,
  pass: Pass,
  phase: Phase,
  save: (fields: Partial<ReconcileState>) => Promise<void>,
): Promise<JobOutcome> {
  switch (phase) {
    case 'messages→records':
      return walkSources(deps, state, pass, phase, 'messages', save);
    case 'conversations→records':
      return walkSources(deps, state, pass, phase, 'conversations', save);
    case 'records→messages':
      return walkRecords(deps, state, pass, phase, 'messages', save);
    case 'records→conversations':
      return walkRecords(deps, state, pass, phase, 'conversations', save);
    case 'vocab':
      /* The chain's own word list step just ran, so with nothing repaired it has nothing to add. */
      if (pass === 'count' || (state.inChain && state.repaired === 0)) {
        return Promise.resolve('done');
      }
      return runVocabRebuild({ methods: deps.methods, control: deps.control, now: deps.now });
  }
}

function sourceHash(collection: SearchSourceCollection, row: SearchSourceRow): string {
  return collection === 'messages' ? extractMessage(row).h : extractConversation(row).h;
}

function buildRecord(
  collection: SearchSourceCollection,
  row: SearchSourceRow,
  options: { analyzer: Analyzer; version: string; epoch: number },
  failed?: () => void,
): MessageSearchRecord | ConversationSearchRecord | null {
  try {
    return collection === 'messages'
      ? buildMessageRecord(row, options)
      : buildConversationRecord(row, options);
  } catch {
    /* A pack that throws on a word leaves a gap no repair can fill; no text is logged here. */
    failed?.();
    return null;
  }
}

async function walkSources(
  { methods, analyzer, version, control }: ReconcileDeps,
  state: ReconcileState,
  pass: Pass,
  phase: Phase,
  collection: SearchSourceCollection,
  save: (fields: Partial<ReconcileState>) => Promise<void>,
): Promise<JobOutcome> {
  let lastId = state.lastIds[phase];
  const analyzerState = await methods.readSearchState(ANALYZER_KEY, JOB_STATE_READ);
  let pinned = typeof analyzerState?.tenantId === 'string' ? analyzerState.tenantId : null;
  for (;;) {
    const stop = await control.check();
    if (stop) {
      return stop;
    }
    const rows = await methods.readSearchSources({
      collection,
      afterId: lastId,
      limit: control.batchSize,
      withText: true,
    });
    if (rows.length === 0) {
      return 'done';
    }
    /* Reconcile inserts missing records, so it holds the one-tenant pin as backfill does (R-04). */
    pinned = await holdTenantPin(
      methods,
      rows.map(({ tenantId }) => tenantId),
      pinned,
    );
    const stamps = new Map(
      (
        await methods.readSearchRecordStamps(
          collection,
          rows.map(({ _id }) => _id),
        )
      ).map((stamp) => [stamp._id, stamp]),
    );

    const inserts: Array<MessageSearchRecord | ConversationSearchRecord> = [];
    const rewrites: Array<{
      record: MessageSearchRecord | ConversationSearchRecord;
      expect: { h: string; v: string };
    }> = [];
    let missing = 0;
    let stale = 0;
    const candidates: string[] = [];
    for (const row of rows) {
      if (!belongsInSearch(collection, row)) {
        continue;
      }
      const stamp = stamps.get(row._id);
      if (stamp && stamp.v === version && stamp.h === sourceHash(collection, row)) {
        continue;
      }
      if (stamp) {
        stale += 1;
      } else {
        missing += 1;
      }
      candidates.push(row._id);
    }

    if (pass === 'repair' && candidates.length > 0) {
      /*
       * Built from a read taken after the stamps, so the compare-and-set on the stamp covers
       * every edit the writer applied since: a newer record is never rewritten with older text.
       */
      for (const row of await methods.readSearchSourcesById(collection, candidates, {
        withText: true,
      })) {
        if (!belongsInSearch(collection, row)) {
          continue;
        }
        const stamp = stamps.get(row._id);
        const record = buildRecord(
          collection,
          row,
          { analyzer, version, epoch: stamp?.e ?? 0 },
          /* Counted where no record exists, which is what verification finds missing. */
          () => {
            state.analysisFailures += stamp ? 0 : 1;
          },
        );
        if (record && stamp) {
          rewrites.push({ record, expect: { h: stamp.h, v: stamp.v } });
        } else if (record) {
          inserts.push(record);
        }
        await giveWay();
      }
    }

    if (pass === 'count') {
      state.missing += missing;
      state.stale += stale;
      state.of += rows.length;
    } else {
      if (!control.holds()) {
        return 'lost';
      }
      const inserted = await methods.insertSearchRecords(collection, inserts);
      const rewritten = await methods.rewriteSearchRecords(collection, rewrites);
      await removeRecordsOfGoneSources(methods, collection, [
        ...inserts.map(({ _id }) => _id),
        ...rewrites.map(({ record }) => record._id),
      ]);
      state.repaired += inserted.written + rewritten;
    }
    lastId = rows[rows.length - 1]._id;
    state.lastIds = { ...state.lastIds, [phase]: lastId };
    await save({
      lastIds: state.lastIds,
      missing: state.missing,
      stale: state.stale,
      of: state.of,
      repaired: state.repaired,
      analysisFailures: state.analysisFailures,
    });
    await control.wait();
  }
}

async function walkRecords(
  { methods, analyzer, version, control }: ReconcileDeps,
  state: ReconcileState,
  pass: Pass,
  phase: Phase,
  collection: SearchSourceCollection,
  save: (fields: Partial<ReconcileState>) => Promise<void>,
): Promise<JobOutcome> {
  let lastId = state.lastIds[phase];
  for (;;) {
    const stop = await control.check();
    if (stop) {
      return stop;
    }
    const ids = await methods.readSearchRecordIds({
      collection,
      afterId: lastId,
      limit: control.batchSize,
    });
    if (ids.length === 0) {
      return 'done';
    }
    const sources = await methods.readSearchSourcesById(collection, ids);
    const belonging = new Set(
      sources.filter((row) => belongsInSearch(collection, row)).map(({ _id }) => _id),
    );
    const orphans = ids.filter((id) => !belonging.has(id));

    if (pass === 'count') {
      state.orphans += orphans.length;
      state.of += ids.length;
    } else if (orphans.length > 0) {
      if (!control.holds()) {
        return 'lost';
      }
      state.repaired += await methods.deleteSearchRecords(collection, orphans);
      await restoreReturnedSources(methods, collection, orphans, { analyzer, version });
    }
    lastId = ids[ids.length - 1];
    state.lastIds = { ...state.lastIds, [phase]: lastId };
    await save({
      lastIds: state.lastIds,
      orphans: state.orphans,
      of: state.of,
      repaired: state.repaired,
    });
    await control.wait();
  }
}

/**
 * The other half of the source check: a source can come back between this walk's read and its
 * delete, as a chat turned temporary and back does, and the writer's record for it would be
 * gone. One read after the delete puts those back, insert-only, so a newer record still wins.
 */
async function restoreReturnedSources(
  methods: ReconcileMethods,
  collection: SearchSourceCollection,
  ids: readonly string[],
  options: { analyzer: Analyzer; version: string },
): Promise<void> {
  const current = await methods.readSearchSourcesById(collection, ids, { withText: true });
  const records = current
    .filter((row) => belongsInSearch(collection, row))
    .map((row) => buildRecord(collection, row, { ...options, epoch: 0 }))
    .filter((record): record is MessageSearchRecord | ConversationSearchRecord => record !== null);
  if (records.length > 0) {
    await methods.insertSearchRecords(collection, records);
  }
}

/** FR-043: a removed pack's attribution shows until no record from the older analyzer remains. */
async function clearAttributionIfReanalyzed({ methods, version }: ReconcileDeps): Promise<void> {
  const analyzerState = await methods.readSearchState(ANALYZER_KEY, JOB_STATE_READ);
  if (analyzerState?.attributionUntilReanalyzed == null) {
    return;
  }
  try {
    for (const collection of ['messages', 'conversations'] as const) {
      if ((await methods.countSearchRecordsAtOtherVersion({ collection, version })) > 0) {
        return;
      }
    }
  } catch {
    /*
     * The count scans a whole record collection and can time out on a large one. Failing
     * reconcile for it would run the word list rebuild again and again, so the credit stays
     * for the next run to clear.
     */
    return;
  }
  await methods.writeSearchState(ANALYZER_KEY, { attributionUntilReanalyzed: null });
}
