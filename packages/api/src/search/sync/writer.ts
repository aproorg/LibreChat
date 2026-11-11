import { runAsSystem } from '@librechat/data-schemas';
import type { SearchMethods, SearchStateEntry } from '@librechat/data-schemas';
import type { SearchStreamBatch } from '@librechat/data-schemas';
import type { ApplyMethods, ApplyTurn } from './apply';
import type { SearchConfigSnapshot } from '../config';
import type { VocabCounterMethods } from './vocab';
import type { SyncStreamMethods } from './stream';
import type { SearchService } from '../service';
import type { SearchMetrics } from '../metrics';
import type { SearchLease } from './lease';
import {
  ANALYZER_KEY,
  CHAIN_KEY,
  JOB_STATE_READ,
  LEASE_KEY,
  requestJob,
  STREAM_KEY,
  VERIFICATION_KEY,
} from '../jobs/control';
import { applyChanges, lastChanges, SyncApplyError } from './apply';
import { safeFailure, safeFailureCode } from '../failure';
import { holdTenantPin, TenantMismatch } from './tenant';
import { isGapUncovered, runSyncStream } from './stream';
import { createVocabCounter } from './vocab';

export type SearchWriterMethods = ApplyMethods &
  SyncStreamMethods &
  VocabCounterMethods &
  Pick<SearchMethods, 'readSearchRecordIds'>;

/** Attempts at one batch, and then at each of its events, before an event is skipped. */
const MAX_ATTEMPTS = 3;
/** The longest wait before the writer opens its stream again after a failure. */
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const STATUS_EVERY_MS = 60_000;

export interface SearchWriter {
  /** Starts the loop. It writes only while this process holds the lease. */
  start(): void;
  /** Stops writing, flushes the word list while the lease is still held, and resolves. */
  stop(): Promise<void>;
  /** Resolves when the current turn has ended. For tests. */
  idle(): Promise<void>;
  /** Whether the writer stopped for good, as on a second tenant. */
  halted(): boolean;
}

export interface SearchWriterDeps {
  config: SearchConfigSnapshot;
  methods: SearchWriterMethods;
  metrics: Pick<SearchMetrics, 'syncGap' | 'syncLag' | 'syncSkip' | 'syncStop'>;
  logger: { warn(message: string, meta: object): unknown };
  service: Pick<SearchService, 'jobAnalyzer'>;
  /** Shared with the job runner, whose heartbeat keeps it. */
  lease: Pick<SearchLease, 'isHeld' | 'epoch' | 'acquiredAt'>;
  now?: () => number;
  /** How often a process without the lease checks for it. */
  pollMs?: number;
  /** The first wait after a failure. It doubles with each failure in a row. */
  retryDelayMs?: number;
  idleSaveMs?: number;
  maxAwaitTimeMS?: number;
}

/** The one request ID for skipped events. */
const SKIP_REQUEST = 'skip';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/** A batch's own stable code, or the error's class and numeric code. */
const failureCode = (error: unknown): string =>
  error instanceof SyncApplyError ? error.code : safeFailureCode(error);

/**
 * The sync writer (R-09, T113). Every process with search data on runs one; only the lease
 * holder's writes. Each turn checks the analyzer, then reads the change stream and applies
 * it in batches, under `runAsSystem` because no request context exists.
 */
export function createSearchWriter(deps: SearchWriterDeps): SearchWriter {
  const { config, methods, metrics, logger, service, lease, now = Date.now } = deps;
  const pollMs = deps.pollMs ?? 1000;
  const retryDelayMs = deps.retryDelayMs ?? 1000;

  let stopped = false;
  let halted = false;
  let loop: Promise<void> | null = null;
  let turn: Promise<void> | null = null;
  let controller = new AbortController();
  let failures = 0;
  let countingEpoch: number | null = null;

  const vocab = createVocabCounter({
    methods,
    flushSeconds: config.vocabFlushSeconds,
    holds: () => countingEpoch !== null && lease.isHeld() && lease.epoch() === countingEpoch,
    logger,
  });

  async function readTenant(): Promise<string | null> {
    const state = await methods.readSearchState(ANALYZER_KEY, JOB_STATE_READ);
    return typeof state?.tenantId === 'string' ? state.tenantId : null;
  }

  async function runTurn(epoch: number, replayBefore: number, signal: AbortSignal): Promise<void> {
    const ready = service.jobAnalyzer();
    if (!ready) {
      return;
    }
    const holds = () => !stopped && lease.isHeld() && lease.epoch() === epoch;
    await checkAnalyzer(ready);
    let pinned = await readTenant();
    const applyTurn: ApplyTurn = { epoch, replayBefore, holds };
    const applyDeps = { methods, analyzer: ready.analyzer, version: ready.version, vocab };

    const applyBatch = async (batch: SearchStreamBatch): Promise<'ok' | 'stop'> => {
      const changes = lastChanges(batch.events);
      if (changes.length === 0) {
        /* Not a reason to forget failures: an empty batch proves nothing about record writes. */
        return 'ok';
      }
      pinned = await holdTenantPin(
        methods,
        changes.map((change) => (change.type === 'upsert' ? change.source.tenantId : undefined)),
        pinned,
      );
      const result = await applyWithRetry(changes, signal, (subset) =>
        applyChanges(subset, { ...applyDeps, turn: applyTurn }),
      );
      /*
       * Reset here and not when the turn ends: a healthy turn lasts as long as the lease, so
       * the count would only grow over the process's life and a later blip would wait minutes.
       * Only after changes were applied, so writes that keep failing still back off.
       */
      failures = 0;
      return result === 'lost' ? 'stop' : 'ok';
    };

    await runSyncStream({
      methods,
      config,
      metrics,
      epoch,
      signal,
      holds,
      apply: applyBatch,
      idleSaveMs: deps.idleSaveMs,
      maxAwaitTimeMS: deps.maxAwaitTimeMS,
      now,
    });
  }

  /**
   * Bounded retry with backoff, then the batch's events one at a time, so one poison event
   * is skipped with an IDs-only alarm and the rest still apply. Reconcile retries the skipped.
   */
  async function applyWithRetry<T extends { id: string }>(
    changes: readonly T[],
    signal: AbortSignal,
    apply: (subset: readonly T[]) => Promise<{ lost: boolean }>,
  ): Promise<'ok' | 'lost'> {
    const attempt = async (subset: readonly T[]) => {
      let last: unknown;
      for (let tries = 1; tries <= MAX_ATTEMPTS; tries += 1) {
        try {
          return { ok: true as const, lost: (await apply(subset)).lost };
        } catch (error) {
          last = error;
          if (signal.aborted) {
            throw error;
          }
          if (tries < MAX_ATTEMPTS) {
            await sleep(retryDelayMs * 2 ** (tries - 1), signal);
          }
        }
      }
      return { ok: false as const, error: last };
    };

    const whole = await attempt(changes);
    if (whole.ok) {
      return whole.lost ? 'lost' : 'ok';
    }
    let skipped = false;
    for (const change of changes) {
      const single = changes.length === 1 ? whole : await attempt([change]);
      if (single.ok) {
        if (single.lost) {
          return 'lost';
        }
        continue;
      }
      const failure = single.error;
      if (!(failure instanceof SyncApplyError) || !failure.poison) {
        /*
         * The database is failing, not the event: end the turn, so the batch is read again
         * from the saved position after a backoff, and nothing is lost.
         */
        throw failure;
      }
      const { code } = failure;
      metrics.syncSkip({ id: change.id, attempts: MAX_ATTEMPTS, code });
      /* A row a pack throws on gets no record from reconcile either, so it asks for none. */
      skipped ||= code !== 'analyze_failed';
    }
    if (skipped && isGapUncovered(await methods.readSearchState(CHAIN_KEY, JOB_STATE_READ))) {
      /*
       * Reconcile retries what was skipped, rather than leaving it to the monthly timer. One
       * request under one ID however many events are skipped: each reconcile is two full
       * walks and a word list rebuild, and a request per batch would run them back to back.
       */
      await requestJob(methods, SKIP_REQUEST, 'reconcile', now());
    }
    return 'ok';
  }

  /**
   * FR-026 at writer start. The first start, or one before any record exists or while the
   * chain's own walks still cover every row, writes the baseline and queues nothing, since
   * reconcile then would be an unrequested full backfill. Otherwise a version change queues
   * reconcile: once a chain has finished, or while it is at its reconcile or verify step,
   * whose walks have already passed rows that still hold the older version.
   */
  async function checkAnalyzer(ready: NonNullable<ReturnType<SearchService['jobAnalyzer']>>) {
    const previous = await methods.readSearchState(ANALYZER_KEY, JOB_STATE_READ);
    const packs = (ready.packs ?? []).map(({ id, attribution }) => ({
      id,
      ...(attribution ? { attribution: { text: attribution.text, url: attribution.url } } : {}),
    }));
    const fields: Record<string, unknown> = { version: ready.version, packs };

    const left = attributedPacks(previous).filter(
      (pack) => !packs.some(({ id }) => id === pack.id),
    );
    if (left.length > 0) {
      const still = attributedPacks({
        _id: ANALYZER_KEY,
        packs: previous?.attributionUntilReanalyzed,
      });
      fields.attributionUntilReanalyzed = [
        ...still.filter((pack) => !left.some(({ id }) => id === pack.id)),
        ...left,
      ];
    }

    const changed = typeof previous?.version === 'string' && previous.version !== ready.version;
    if (
      changed &&
      isGapUncovered(await methods.readSearchState(CHAIN_KEY, JOB_STATE_READ)) &&
      (await anyRecord())
    ) {
      await requestJob(methods, `analyzer-${ready.version}`, 'reconcile', now());
    }
    await methods.writeSearchState(ANALYZER_KEY, fields);
  }

  const anyRecord = async () => {
    for (const collection of ['messages', 'conversations'] as const) {
      if ((await methods.readSearchRecordIds({ collection, limit: 1 })).length > 0) {
        return true;
      }
    }
    return false;
  };

  async function run(): Promise<void> {
    while (!stopped) {
      const epoch = lease.epoch();
      const acquiredAt = lease.acquiredAt();
      if (!lease.isHeld() || epoch === null || acquiredAt === null || !service.jobAnalyzer()) {
        await sleep(pollMs, controller.signal);
        continue;
      }
      countingEpoch = epoch;
      vocab.start();
      turn = runAsSystem(() => runTurn(epoch, acquiredAt, controller.signal));
      try {
        await turn;
        failures = 0;
        if (lease.isHeld() && lease.epoch() === epoch) {
          /* The turn ended while still held, as when a newer writer's save refused this one's. */
          await sleep(pollMs, controller.signal);
        }
      } catch (error) {
        if (error instanceof TenantMismatch) {
          halted = true;
          stopped = true;
          metrics.syncStop({ code: 'tenant_mismatch' });
          logger.warn('[search] Sync stopped: a second tenant appeared in this database', {});
          /*
           * One writer and one word list serve one tenant (R-04). Search must not go on
           * serving a database that holds two, so the pass is withdrawn for every process.
           */
          await methods
            .writeSearchState(VERIFICATION_KEY, {
              invalidatedAt: new Date(now()),
              invalidatedBy: 'tenant_mismatch',
            })
            .catch(() => undefined);
          break;
        }
        if (stopped) {
          break;
        }
        failures += 1;
        logger.warn('[search] Sync failed', {
          ...safeFailure(error),
          code: failureCode(error),
        });
        await sleep(
          Math.min(retryDelayMs * 2 ** (failures - 1), MAX_RETRY_DELAY_MS),
          controller.signal,
        );
      } finally {
        turn = null;
        await vocab.flush();
      }
    }
  }

  return {
    start() {
      if (loop || stopped) {
        return;
      }
      loop = run().catch((error: unknown) => {
        logger.warn('[search] Sync writer stopped', safeFailure(error));
      });
    },
    async stop() {
      stopped = true;
      controller.abort();
      await loop;
      await vocab.stop();
      countingEpoch = null;
      controller = new AbortController();
    },
    async idle() {
      await turn?.catch(() => undefined);
    },
    halted: () => halted,
  };
}

function attributedPacks(
  state: SearchStateEntry | null,
): Array<{ id: string; attribution: { text: string; url: string } }> {
  const packs = Array.isArray(state?.packs) ? (state.packs as unknown[]) : [];
  return packs.filter(
    (pack): pack is { id: string; attribution: { text: string; url: string } } =>
      pack != null &&
      typeof (pack as { id?: unknown }).id === 'string' &&
      typeof (pack as { attribution?: { text?: unknown } }).attribution?.text === 'string',
  );
}

/**
 * Liveness (R-09): every process with search data on reports, each minute, how old the saved
 * position is and whether anyone holds the lease, so a stalled writer still raises an alarm.
 * Returns the function that stops it. Never rejects.
 */
export function startSyncStatus({
  methods,
  metrics,
  logger,
  isHolder,
  now = Date.now,
  everyMs = STATUS_EVERY_MS,
}: {
  methods: Pick<SearchMethods, 'readSearchState'>;
  metrics: Pick<SearchMetrics, 'syncStatus'>;
  logger: { warn(message: string, meta: object): unknown };
  isHolder(): boolean;
  now?: () => number;
  everyMs?: number;
}): { stop(): void; emit(): Promise<void> } {
  const timeOf = (value: unknown) => (value instanceof Date ? value.getTime() : null);
  async function emit(): Promise<void> {
    try {
      const [stream, leaseState] = await runAsSystem(() =>
        Promise.all([
          methods.readSearchState(STREAM_KEY, JOB_STATE_READ),
          methods.readSearchState(LEASE_KEY, JOB_STATE_READ),
        ]),
      );
      const savedAt = timeOf(stream?.savedAt);
      const leaseUntil = timeOf(leaseState?.leaseUntil);
      metrics.syncStatus({
        ...(savedAt !== null ? { savedAgeMs: Math.max(now() - savedAt, 0) } : {}),
        hasHolder: leaseUntil !== null && leaseUntil > now(),
        isHolder: isHolder(),
      } as Parameters<SearchMetrics['syncStatus']>[0]);
    } catch (error) {
      logger.warn('[search] Sync status read failed', safeFailure(error));
    }
  }
  const timer = setInterval(() => void emit(), everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer), emit };
}
