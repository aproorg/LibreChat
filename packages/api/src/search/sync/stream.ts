import { isSearchStreamError } from '@librechat/data-schemas';
import type {
  SearchStateEntry,
  SearchMethods,
  SearchStreamBatch,
  SearchStreamPosition,
} from '@librechat/data-schemas';
import type { SearchConfigSnapshot } from '../config';
import type { SearchMetrics } from '../metrics';
import { CHAIN_KEY, JOB_STATE_READ, requestJob, STREAM_KEY } from '../jobs/control';

export type SyncStreamMethods = Pick<
  SearchMethods,
  'watchSearchSources' | 'saveSearchStreamState' | 'readSearchState' | 'writeSearchState'
>;

/** How often an idle stream saves its position, which also shows the writer is alive. */
export const IDLE_SAVE_MS = 5_000;

export interface SyncStreamDeps {
  methods: SyncStreamMethods;
  config: Pick<SearchConfigSnapshot, 'sync'>;
  metrics: Pick<SearchMetrics, 'syncGap' | 'syncLag'>;
  /** The turn's epoch: every save is conditional on it. */
  epoch: number;
  /** Aborted when the turn ends, which closes the stream. */
  signal: AbortSignal;
  holds(): boolean;
  /** Applies one batch's events. `stop` ends the turn. */
  apply(batch: SearchStreamBatch): Promise<'ok' | 'stop'>;
  idleSaveMs?: number;
  /** How long the server waits for a change before an empty batch. */
  maxAwaitTimeMS?: number;
  now?: () => number;
}

const isPosition = (value: unknown): value is SearchStreamPosition =>
  value != null && typeof value === 'object' && !Array.isArray(value);

/**
 * Reads the source change stream for one writer turn, from the saved position (R-09, T111).
 *
 * A gap is anything that leaves events unaccounted for: a position that can no longer be
 * resumed, an event too large to read, an invalidate, or no saved position at all once a
 * backfill chain has finished, as on a tenant whose first backfill ran with no writer. A gap
 * alarms, restarts at the current position, and queues reconcile only after a chain has
 * finished, because the chain's own backfill and reconcile cover anything before that.
 */
export async function runSyncStream(deps: SyncStreamDeps): Promise<void> {
  const { methods, config, epoch, signal, holds, now = Date.now } = deps;
  const idleSaveMs = deps.idleSaveMs ?? IDLE_SAVE_MS;
  let savedAt = 0;

  const saved = await methods.readSearchState(STREAM_KEY, JOB_STATE_READ);
  let position = isPosition(saved?.resumeToken) ? saved.resumeToken : null;
  if (position === null && !(await gap(deps, false, now))) {
    return;
  }

  while (!signal.aborted && holds()) {
    let reopen = false;
    try {
      for await (const batch of methods.watchSearchSources({
        resumeToken: position,
        signal,
        scope: config.sync.watch,
        dropUpdatedText: config.sync.dropUpdatedText,
        ...(deps.maxAwaitTimeMS != null ? { maxAwaitTimeMS: deps.maxAwaitTimeMS } : {}),
      })) {
        if (!holds()) {
          return;
        }
        const cut = batch.events.findIndex(({ type }) => type === 'gap');
        const events = cut === -1 ? batch.events : batch.events.slice(0, cut);
        if ((await deps.apply({ ...batch, events })) === 'stop') {
          return;
        }
        if (cut !== -1) {
          /* An invalidate closes the stream, and a dropped collection leaves records behind. */
          if (!(await gap(deps, false, now))) {
            return;
          }
          position = null;
          reopen = true;
          break;
        }
        if (batch.events.length === 0 && now() - savedAt < idleSaveMs) {
          continue;
        }
        const fields: Record<string, unknown> = { savedAt: new Date(now()) };
        if (batch.caughtUpTo !== null) {
          fields.syncedTo = new Date(batch.caughtUpTo);
        }
        if (batch.position) {
          fields.resumeToken = batch.position;
          position = batch.position;
        }
        if (!(await methods.saveSearchStreamState({ epoch, fields }))) {
          /* A newer writer saved after this one: its turn has begun. */
          return;
        }
        savedAt = now();
        if (events.length > 0) {
          deps.metrics.syncLag({
            lagMs: Math.max(now() - events[0].at, 0),
            batch: events.length,
          });
        }
      }
      if (!reopen) {
        /* The stream ended without a gap: the writer's loop decides when to open it again. */
        return;
      }
    } catch (error) {
      if (!isSearchStreamError(error) || signal.aborted) {
        throw error;
      }
      if (!(await gap(deps, error.code === 'resume_failed', now))) {
        return;
      }
      position = null;
    }
  }
}

/** Chain steps after which the chain's own walks may already have passed rows a gap lost. */
const LATE_CHAIN_STEPS = new Set(['reconcile', 'verify']);

/**
 * Whether lost or skipped events need a reconcile of their own: once a chain has finished, or
 * while it is at its reconcile or verify step, whose walks may already have passed them.
 */
export const isGapUncovered = (chain: SearchStateEntry | null): boolean =>
  chain?.finishedAt != null || LATE_CHAIN_STEPS.has(String(chain?.step));

/**
 * Alarms, clears the saved position so the stream restarts where it is now, and queues
 * reconcile when the chain's own reconcile cannot cover the gap: once a chain has finished,
 * or while it is at its reconcile or verify step. The runner holds a request made mid-chain
 * until the chain finishes. A request ID per gap, so a reconcile already running for an
 * earlier gap cannot take this one's request with it. Answers whether to carry on.
 */
async function gap(deps: SyncStreamDeps, resumeFailed: boolean, now: () => number) {
  const { methods, metrics, epoch, holds } = deps;
  const chain = await methods.readSearchState(CHAIN_KEY, JOB_STATE_READ);
  const uncovered = isGapUncovered(chain);
  if (!holds()) {
    return false;
  }
  const restartedAt = now();
  if (uncovered || resumeFailed) {
    metrics.syncGap({ resumeFailed, restartedAt });
  }
  const cleared = await methods.saveSearchStreamState({
    epoch,
    fields: { resumeToken: null, ...(uncovered ? { gapAt: new Date(restartedAt) } : {}) },
  });
  if (!cleared) {
    return false;
  }
  if (uncovered) {
    await requestJob(methods, `gap-${restartedAt}`, 'reconcile', restartedAt);
  }
  return true;
}
