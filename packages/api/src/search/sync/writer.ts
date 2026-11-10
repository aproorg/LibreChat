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
} from '../jobs/control';
import { applyChanges, checkTenant, lastChanges, SyncApplyError } from './apply';
import { getSafeErrorMetadata } from '~/utils/errors';
import { createVocabCounter } from './vocab';
import { runSyncStream } from './stream';

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

class TenantMismatch extends Error {}

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

/** Safe metadata only: an error class and a numeric code or stable string code. */
function failureCode(error: unknown): string {
  if (error instanceof SyncApplyError) {
    return error.code;
  }
  const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
  const label = typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? name : 'Error';
  return typeof code === 'number' ? `${label}:${code}` : label;
}

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
        return 'ok';
      }
      const tenant = checkTenant(changes, pinned);
      if (!tenant.ok) {
        throw new TenantMismatch();
      }
      if (tenant.pin !== pinned) {
        await methods.writeSearchState(ANALYZER_KEY, { tenantId: tenant.pin });
        pinned = tenant.pin;
      }
      const result = await applyWithRetry(changes, signal, (subset) =>
        applyChanges(subset, { ...applyDeps, turn: applyTurn }),
      );
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
    for (const change of changes) {
      const single = changes.length === 1 ? whole : await attempt([change]);
      if (single.ok) {
        if (single.lost) {
          return 'lost';
        }
        continue;
      }
      const code = single.error instanceof SyncApplyError ? single.error.code : 'unknown';
      metrics.syncSkip({ id: change.id, attempts: MAX_ATTEMPTS, code });
    }
    return 'ok';
  }

  /**
   * FR-026 at writer start. The first start, or one before any chain finished or any record
   * exists, writes the baseline and queues nothing, since reconcile then would be an
   * unrequested full backfill. Otherwise a version change queues reconcile.
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
    if (changed && (await chainFinished()) && (await anyRecord())) {
      await requestJob(methods, `analyzer-${ready.version}`, 'reconcile', now());
    }
    await methods.writeSearchState(ANALYZER_KEY, fields);
  }

  const chainFinished = async () =>
    (await methods.readSearchState(CHAIN_KEY, JOB_STATE_READ))?.finishedAt != null;

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
          break;
        }
        if (stopped) {
          break;
        }
        failures += 1;
        logger.warn('[search] Sync failed', {
          ...getSafeErrorMetadata(error),
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
        logger.warn('[search] Sync writer stopped', getSafeErrorMetadata(error));
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
      logger.warn('[search] Sync status read failed', getSafeErrorMetadata(error));
    }
  }
  const timer = setInterval(() => void emit(), everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer), emit };
}
