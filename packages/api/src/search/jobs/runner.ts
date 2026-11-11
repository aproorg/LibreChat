import { randomUUID } from 'node:crypto';
import { runAsSystem } from '@librechat/data-schemas';
import type { SearchMethods, SearchStateEntry } from '@librechat/data-schemas';
import type { SearchLease, SearchLeaseMethods } from '../sync/lease';
import type { VocabRebuildMethods } from './vocabRebuild';
import type { JobControl, JobOutcome } from './control';
import type { SearchConfigSnapshot } from '../config';
import type { ReconcileMethods } from './reconcile';
import type { BackfillMethods } from './backfill';
import type { SearchService } from '../service';
import type { SearchMetrics } from '../metrics';
import type { VerifyMethods } from './verify';
import {
  BACKFILL_KEYS,
  CHAIN_KEY,
  JOB_REQUEST_PREFIX,
  JOB_STATE_READ,
  RECONCILE_KEY,
  requestJob,
  SOURCE_COLLECTIONS,
  VERIFICATION_KEY,
} from './control';
import { safeFailure, safeFailureCode } from '../failure';
import { createSearchLease } from '../sync/lease';
import { runVocabRebuild } from './vocabRebuild';
import { runReconcile } from './reconcile';
import { runBackfill } from './backfill';
import { runVerify } from './verify';

export type SearchJobMethods = BackfillMethods &
  VocabRebuildMethods &
  ReconcileMethods &
  VerifyMethods &
  SearchLeaseMethods &
  Pick<SearchMethods, 'ensureSearchIndexes' | 'listSearchJobRequests' | 'deleteSearchState'>;

/** The longest wait between attempts at a job that keeps failing. */
const MAX_RETRY_DELAY_MS = 10 * 60_000;
/** Fixed, so every restart of every process asks for the same one backfill. */
const ON_START_REQUEST = 'backfill-on-start';
/** Verification rounds before the mismatch loop stops and the owner is called (R-11). */
export const MAX_VERIFY_ROUNDS = 3;
/** Failures a reconcile can repair, so the mismatch loop runs on them. */
const LOOP_REASONS = new Set(['mismatch', 'sync_behind']);
const DAY_MS = 86_400_000;

export interface SearchJobRunner {
  /** Starts the heartbeat. Its timer never keeps the process alive. */
  start(): void;
  /** One heartbeat: lease, requests, then whichever job is due. Never rejects. */
  tick(): Promise<void>;
  /** Resolves once no job is running. */
  idle(): Promise<void>;
  /** Stops the heartbeat, waits for the job to stop and gives up the lease. */
  stop(): Promise<void>;
  isHolder(): boolean;
  /** The lease this runner keeps, which the sync writer shares. */
  readonly lease: SearchLease;
}

export interface SearchJobRunnerDeps {
  config: SearchConfigSnapshot;
  methods: SearchJobMethods;
  metrics: Pick<SearchMetrics, 'backfill' | 'verify' | 'lease' | 'reconcile'>;
  logger: { warn(message: string, meta: object): unknown };
  service: Pick<SearchService, 'jobAnalyzer'>;
  holder?: string;
  /** Created here when absent. The startup path passes one, so the writer can share it. */
  lease?: SearchLease;
  now?: () => number;
}

/** One step of the chain. A step is safe to run again, so a new holder restarts the one it finds. */
interface ChainStep {
  name: string;
  run(): Promise<JobOutcome>;
}

export function createSearchJobRunner(deps: SearchJobRunnerDeps): SearchJobRunner {
  const { config, methods, metrics, logger, service, now = Date.now } = deps;
  const { batchSize, batchDelayMs, vocabCopyBatchSize, backfillOnStart } = config.jobs;
  const lease: SearchLease =
    deps.lease ??
    createSearchLease({
      methods,
      holder: deps.holder ?? randomUUID(),
      takeoverSeconds: config.syncTakeoverSeconds,
      packsLoaded: () => service.jobAnalyzer() !== null,
      metrics,
      now,
    });

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let held = false;
  let failures = 0;
  let retryAt = 0;
  let ticking: Promise<void> | null = null;
  let active: Promise<void> | null = null;

  const readState = (key: string) => methods.readSearchState(key, JOB_STATE_READ);
  const isPaused = async () => (await readState(BACKFILL_KEYS.messages))?.pause === true;

  /**
   * Tied to the turn it starts under. A job that stalled past its lease must not carry on
   * from memory if this process later wins the lease back. State writes are fenced by this
   * local check rather than per write, because a stale job's records are insert-only.
   */
  const jobControl = (): JobControl => {
    const epoch = lease.epoch();
    const holds = () => !stopped && lease.isHeld() && lease.epoch() === epoch;
    return {
      batchSize,
      copyBatchSize: vocabCopyBatchSize,
      holds,
      async check() {
        if (!holds()) {
          return 'lost';
        }
        return (await isPaused()) ? 'paused' : null;
      },
      wait: () =>
        new Promise((resolve) => {
          setTimeout(resolve, batchDelayMs).unref();
        }),
    };
  };

  /** The chain's order (T121). */
  const chainSteps = (control: JobControl): ChainStep[] => {
    const ready = service.jobAnalyzer();
    if (!ready) {
      return [];
    }
    return [
      { name: 'backfill', run: () => runBackfill({ methods, control, metrics, now, ...ready }) },
      {
        name: 'indexes',
        async run() {
          await methods.ensureSearchIndexes();
          return 'done';
        },
      },
      { name: 'vocab', run: () => runVocabRebuild({ methods, control, now }) },
      {
        name: 'reconcile',
        run: () => runReconcile({ methods, control, metrics, now, inChain: true, ...ready }),
      },
      {
        name: 'verify',
        run: () => runVerify({ methods, control, metrics, version: ready.version, round: 1, now }),
      },
    ];
  };

  async function runChain(chain: SearchStateEntry): Promise<void> {
    const control = jobControl();
    const steps = chainSteps(control);
    const start = Math.max(
      steps.findIndex(({ name }) => name === chain.step),
      0,
    );
    for (let index = start; index < steps.length; index += 1) {
      const outcome = await steps[index].run();
      if (outcome !== 'done' || !control.holds()) {
        return;
      }
      const next = steps[index + 1];
      await methods.writeSearchState(
        CHAIN_KEY,
        /* Moving on clears the count, whichever process's attempts it was. */
        next ? { step: next.name, failures: 0 } : { finishedAt: new Date(now()), failures: 0 },
      );
    }
  }

  /**
   * Only one job runs at a time. A failure is logged and tried again, soon at first and then
   * backing off, because a failure that repeats must neither hammer the tenant nor stay
   * invisible: the count on `stateKey` reaches `search-job.js status`.
   */
  function startJob(run: () => Promise<void>, stateKey: string): void {
    const record = (fields: Record<string, unknown>) =>
      methods.writeSearchState(stateKey, fields).catch((error: unknown) => {
        logger.warn('[search] Job state write failed', safeFailure(error));
      });
    active = run()
      .then(async () => {
        if (failures > 0) {
          failures = 0;
          retryAt = 0;
          await record({ failures: 0 });
        }
      })
      .catch(async (error: unknown) => {
        const lastFailureCode = safeFailureCode(error);
        logger.warn('[search] Job failed', { ...safeFailure(error), lastFailureCode });
        failures += 1;
        retryAt =
          failures > 1
            ? now() + Math.min(lease.heartbeatMs * 2 ** (failures - 1), MAX_RETRY_DELAY_MS)
            : 0;
        await record({ failures, lastFailureAt: new Date(now()), lastFailureCode });
      })
      .finally(() => {
        active = null;
      });
  }

  async function startBackfillChain(key: string): Promise<void> {
    const chain = await readState(CHAIN_KEY);
    const finishedOther = chain?.finishedAt != null && chain.requestId !== key;
    if (finishedOther) {
      /* A deliberate new run. It re-reads every source, and an existing record stays. */
      const paused = await isPaused();
      for (const collection of SOURCE_COLLECTIONS) {
        await methods.deleteSearchState(BACKFILL_KEYS[collection]);
      }
      if (paused) {
        await setPause(true);
      }
      await methods.deleteSearchState(CHAIN_KEY);
    }
    if (!chain || finishedOther) {
      await methods.writeSearchState(CHAIN_KEY, {
        requestId: key,
        step: 'backfill',
        startedAt: new Date(now()),
      });
    }
    await methods.deleteSearchState(key);
  }

  async function setPause(pause: boolean): Promise<void> {
    for (const collection of SOURCE_COLLECTIONS) {
      await methods.writeSearchState(BACKFILL_KEYS[collection], {
        pause,
        pausedReason: pause ? 'operator' : null,
      });
    }
  }

  /** A request is deleted only after its job's state is written, so a crash cannot lose it. */
  async function handleRequest(request: SearchStateEntry): Promise<void> {
    const key = request._id;
    switch (request.job) {
      case 'backfill': {
        /*
         * A new run after a finished chain deletes the backfill state, which a verify or
         * reconcile still running reads. That job would then fail and hide search until the
         * whole new chain ends, so the request waits for it.
         */
        if (active && (await readState(CHAIN_KEY))?.finishedAt != null) {
          return;
        }
        await startBackfillChain(key);
        return;
      }
      case 'pause':
      case 'resume':
        await setPause(request.job === 'pause');
        await methods.deleteSearchState(key);
        return;
      case 'verify': {
        /* Waits its turn: a verify mid-chain would judge a half-built index. */
        const chain = await readState(CHAIN_KEY);
        if (
          active ||
          now() < retryAt ||
          (chain && chain.finishedAt == null) ||
          (await isPaused())
        ) {
          return;
        }
        const ready = service.jobAnalyzer();
        if (!ready) {
          return;
        }
        const control = jobControl();
        const { version } = ready;
        /* An operator's request starts the mismatch loop afresh, with all its rounds. */
        startJob(async () => {
          const outcome = await runVerify({ methods, control, metrics, version, round: 1, now });
          if (outcome === 'done') {
            await methods.deleteSearchState(key);
          }
        }, VERIFICATION_KEY);
        return;
      }
      case 'reconcile':
        await handleReconcileRequest(request);
        return;
      default:
        logger.warn('[search] Unknown job request removed', {});
        await methods.deleteSearchState(key);
    }
  }

  /**
   * Reconcile runs only once a chain has finished: with no chain it would be an unrequested full
   * backfill, so the request is removed, and a request made while a chain runs waits for it.
   * With `verifyRound`, from the mismatch loop, verification follows in the same job, and the
   * request stays until both are done, noting when reconcile finished, so a new holder carries
   * the loop on without walking everything again.
   */
  async function handleReconcileRequest(request: SearchStateEntry): Promise<void> {
    const key = request._id;
    const chain = await readState(CHAIN_KEY);
    if (!chain) {
      logger.warn('[search] Reconcile needs a finished backfill; request removed', {});
      await methods.deleteSearchState(key);
      return;
    }
    if (chain.finishedAt == null) {
      return;
    }
    if (active || now() < retryAt || (await isPaused())) {
      return;
    }
    const ready = service.jobAnalyzer();
    if (!ready) {
      return;
    }
    const control = jobControl();
    const verifyRound = typeof request.verifyRound === 'number' ? request.verifyRound : null;
    const reconciledBefore = request.reconciledAt instanceof Date;
    startJob(async () => {
      if (!reconciledBefore) {
        const reconciled = await runReconcile({
          methods,
          control,
          metrics,
          now,
          inChain: false,
          ...ready,
        });
        if (reconciled !== 'done') {
          return;
        }
        /*
         * It may have resumed a run that began before this request, which cannot answer it:
         * the request stays, and the next heartbeat starts a fresh run.
         */
        const startedAt = (await readState(RECONCILE_KEY))?.startedAt;
        if (
          request.requestedAt instanceof Date &&
          (!(startedAt instanceof Date) || startedAt < request.requestedAt)
        ) {
          return;
        }
      }
      if (verifyRound !== null) {
        if (!reconciledBefore) {
          await methods.writeSearchState(key, { reconciledAt: new Date(now()) });
        }
        const verified = await runVerify({
          methods,
          control,
          metrics,
          version: ready.version,
          round: verifyRound,
          now,
        });
        if (verified !== 'done') {
          return;
        }
      }
      if (verifyRound === null) {
        await removeAnsweredRequest(key);
      } else {
        /* A round's request has an ID of its own, so nothing writes it again. */
        await methods.deleteSearchState(key);
      }
      await dropSatisfiedReconcileRequests();
    }, RECONCILE_KEY);
  }

  /**
   * The writer's request for skipped events has one ID, so it can be written again while its
   * reconcile runs, for a row that walk had already passed. That newer request stays.
   */
  async function removeAnsweredRequest(key: string): Promise<void> {
    const requestedAt = (await readState(key))?.requestedAt;
    const startedAt = (await readState(RECONCILE_KEY))?.startedAt;
    if (requestedAt instanceof Date && startedAt instanceof Date && requestedAt > startedAt) {
      return;
    }
    await methods.deleteSearchState(key);
  }

  /** Requests made before the reconcile that just finished began are answered by it. */
  async function dropSatisfiedReconcileRequests(): Promise<void> {
    const startedAt = (await readState(RECONCILE_KEY))?.startedAt;
    if (!(startedAt instanceof Date)) {
      return;
    }
    for (const request of await methods.listSearchJobRequests()) {
      const requestedAt = request.requestedAt;
      if (
        request.job === 'reconcile' &&
        request.verifyRound == null &&
        requestedAt instanceof Date &&
        requestedAt <= startedAt
      ) {
        await methods.deleteSearchState(request._id);
      }
    }
  }

  /**
   * R-11's mismatch loop: a failed verification queues reconcile and another round, up to
   * three, after which `verification` keeps `failed` and `gaveUp`, and the owner is called.
   * Driven by state, so a new holder carries it on, and by request, so a crash cannot drop it.
   */
  async function continueMismatchLoop(pending: readonly SearchStateEntry[]): Promise<boolean> {
    const verification = await readState(VERIFICATION_KEY);
    if (
      verification?.status !== 'failed' ||
      verification.running === true ||
      !LOOP_REASONS.has(String(verification.reason))
    ) {
      return false;
    }
    const rounds = typeof verification.rounds === 'number' ? verification.rounds : 1;
    if (rounds >= MAX_VERIFY_ROUNDS) {
      if (verification.gaveUp !== true) {
        await methods.writeSearchState(VERIFICATION_KEY, { gaveUp: true });
        logger.warn('[search] Verification failed after every round; the owner is called', {
          rounds,
        });
      }
      return false;
    }
    const key = `${JOB_REQUEST_PREFIX}mismatch-${rounds + 1}`;
    if (pending.some(({ _id }) => _id === key)) {
      return false;
    }
    await methods.writeSearchState(key, {
      job: 'reconcile',
      verifyRound: rounds + 1,
      requestedAt: new Date(now()),
    });
    return true;
  }

  /**
   * Resumes a reconcile a previous holder left running, or starts the `reconcileDays` one.
   * Both only after a chain has finished, so neither can act as an unrequested backfill.
   */
  async function startDueReconcile(): Promise<void> {
    const ready = service.jobAnalyzer();
    if (!ready) {
      return;
    }
    const reconcile = await readState(RECONCILE_KEY);
    const chain = await readState(CHAIN_KEY);
    const last = reconcile?.finishedAt ?? chain?.finishedAt;
    const due =
      reconcile?.status === 'running' ||
      (last instanceof Date && now() - last.getTime() >= config.reconcileDays * DAY_MS);
    if (!due) {
      return;
    }
    const control = jobControl();
    startJob(async () => {
      await runReconcile({ methods, control, metrics, now, inChain: false, ...ready });
    }, RECONCILE_KEY);
  }

  /**
   * The owner's lever on top of T120's "only by request": a deploy can start the backfill.
   * Any chain at all means no request: an unfinished one resumes, a finished one stays finished.
   */
  async function requestBackfillOnStart(): Promise<void> {
    if (backfillOnStart && !(await readState(CHAIN_KEY))) {
      await requestJob(methods, ON_START_REQUEST, 'backfill', now());
    }
  }

  async function heartbeat(): Promise<void> {
    if (!(await lease.tick())) {
      held = false;
      return;
    }
    if (!held) {
      /* Only after it worked, so a failed read or write is tried again next heartbeat. */
      await requestBackfillOnStart();
      held = true;
    }
    for (const request of await methods.listSearchJobRequests()) {
      await handleRequest(request);
    }
    if (active || now() < retryAt) {
      return;
    }
    const chain = await readState(CHAIN_KEY);
    if (!chain || (await isPaused())) {
      return;
    }
    if (chain.finishedAt == null) {
      startJob(() => runChain(chain), CHAIN_KEY);
      return;
    }
    /* One list read serves both: the loop says whether it queued a request of its own. */
    const pending = await methods.listSearchJobRequests();
    const queued = await continueMismatchLoop(pending);
    if (pending.length === 0 && !queued) {
      await startDueReconcile();
    }
  }

  function tick(): Promise<void> {
    if (stopped) {
      return Promise.resolve();
    }
    if (!ticking) {
      ticking = runAsSystem(heartbeat)
        .catch((error: unknown) => {
          logger.warn('[search] Job heartbeat failed', safeFailure(error));
        })
        .finally(() => {
          ticking = null;
        });
    }
    return ticking;
  }

  async function idle(): Promise<void> {
    while (ticking || active) {
      await (ticking ?? active);
    }
  }

  return {
    start() {
      void tick();
      timer = setInterval(() => void tick(), lease.heartbeatMs);
      timer.unref();
    },
    tick,
    idle,
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await idle();
      await lease.release().catch((error: unknown) => {
        logger.warn('[search] Lease release failed', safeFailure(error));
      });
    },
    isHolder: () => lease.isHeld(),
    lease,
  };
}
