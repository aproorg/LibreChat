import type { SearchMethods, SearchSourceCollection } from '@librechat/data-schemas';
import type { JobControl, JobOutcome } from './control';
import { JOB_STATE_READ, SOURCE_COLLECTIONS } from './control';

export type VocabRebuildMethods = Pick<
  SearchMethods,
  | 'readSearchState'
  | 'writeSearchState'
  | 'readSearchRecordTokenBatch'
  | 'incrementSearchVocabNext'
  | 'readSearchVocabBatch'
  | 'settleSearchVocab'
>;

const VOCAB_KEY = 'vocab';
/**
 * Distinct tokens held before a flush. It bounds memory per process rather than serving as a
 * tuning lever: `jobs.batchSize` and `batchDelayMs` already set the load.
 */
const MAX_COUNTS_IN_MEMORY = 50_000;
const COPY_PHASE = 'copy';

type Phase = SearchSourceCollection | typeof COPY_PHASE;

const PHASES: readonly Phase[] = [...SOURCE_COLLECTIONS, COPY_PHASE];

/**
 * Rebuilds the word list per R-10: count into `dfNext` under a run number, then copy to `df`
 * and delete rows this run never stamped. The old `df` keeps serving until the copy pass.
 * The position is saved only after a flush, so a crash loses unflushed counts and re-walks
 * them. A crash between the flush and the save can count one flush twice, which `df` allows,
 * as it only orders expansions and rarity.
 */
export async function runVocabRebuild({
  methods,
  control,
  now = Date.now,
}: {
  methods: VocabRebuildMethods;
  control: JobControl;
  now?: () => number;
}): Promise<JobOutcome> {
  const saved = await methods.readSearchState(VOCAB_KEY, JOB_STATE_READ);
  const resuming = saved?.status === 'running';
  const previousRun = typeof saved?.run === 'number' ? saved.run : 0;
  const run = resuming ? previousRun : previousRun + 1;
  let phase = (resuming ? saved?.phase : PHASES[0]) as Phase;
  let lastId = resuming && typeof saved?.lastId === 'string' ? saved.lastId : undefined;

  if (!resuming) {
    await methods.writeSearchState(VOCAB_KEY, {
      run,
      phase,
      lastId: null,
      status: 'running',
      startedAt: new Date(now()),
    });
  }

  const save = (fields: { phase?: Phase; lastId: string | null }) =>
    methods.writeSearchState(VOCAB_KEY, fields);

  for (const collection of SOURCE_COLLECTIONS) {
    if (PHASES.indexOf(phase) > PHASES.indexOf(collection)) {
      continue;
    }
    const counts = new Map<string, number>();
    const flush = async () => {
      await methods.incrementSearchVocabNext({ counts: [...counts], run });
      counts.clear();
    };

    for (;;) {
      const stop = await control.check();
      if (stop) {
        return stop;
      }
      const rows = await methods.readSearchRecordTokenBatch({
        collection,
        afterId: lastId,
        limit: control.batchSize,
      });
      if (rows.length === 0) {
        break;
      }
      for (const { tokens } of rows) {
        for (const token of tokens) {
          counts.set(token, (counts.get(token) ?? 0) + 1);
        }
      }
      lastId = rows[rows.length - 1]._id;
      if (counts.size >= MAX_COUNTS_IN_MEMORY) {
        await flush();
        await save({ lastId });
      }
      await control.wait();
    }
    if (!control.holds()) {
      return 'lost';
    }
    await flush();
    const nextPhase = PHASES[PHASES.indexOf(collection) + 1];
    await save({ phase: nextPhase, lastId: null });
    phase = nextPhase;
    lastId = undefined;
  }

  for (;;) {
    const stop = await control.check();
    if (stop) {
      return stop;
    }
    const rows = await methods.readSearchVocabBatch({ afterId: lastId, limit: control.batchSize });
    if (rows.length === 0) {
      break;
    }
    await methods.settleSearchVocab({
      copy: rows
        .filter(({ r, dfNext }) => r === run && dfNext != null)
        .map(({ token, dfNext }) => ({ token, df: dfNext as number })),
      remove: rows.filter(({ r }) => r !== run).map(({ token }) => token),
    });
    lastId = rows[rows.length - 1].token;
    await save({ lastId });
    await control.wait();
  }

  await methods.writeSearchState(VOCAB_KEY, {
    status: 'finished',
    lastId: null,
    finishedAt: new Date(now()),
  });
  return 'done';
}
