import { randomUUID } from 'node:crypto';
import { runAsSystem } from '@librechat/data-schemas';
import type { SearchMethods, SearchStateEntry } from '@librechat/data-schemas';
import type { SearchLease, SearchLeaseMethods } from '../sync/lease';
import type { VocabRebuildMethods } from './vocabRebuild';
import type { JobControl, JobOutcome } from './control';
import type { SearchConfigSnapshot } from '../config';
import type { BackfillMethods } from './backfill';
import type { SearchService } from '../service';
import type { SearchMetrics } from '../metrics';
import type { VerifyMethods } from './verify';
import { BACKFILL_KEYS, JOB_STATE_READ, SOURCE_COLLECTIONS } from './control';
import { getSafeErrorMetadata } from '~/utils/errors';
import { createSearchLease } from '../sync/lease';
import { runVocabRebuild } from './vocabRebuild';
import { runBackfill } from './backfill';
import { runVerify } from './verify';

export type SearchJobMethods = BackfillMethods &
  VocabRebuildMethods &
  VerifyMethods &
  SearchLeaseMethods &
  Pick<SearchMethods, 'ensureSearchIndexes' | 'listSearchJobRequests' | 'deleteSearchState'>;

const CHAIN_KEY = 'chain';
const VERIFICATION_KEY = 'verification';
/** Fixed, so every restart of every process asks for the same one backfill. */
const ON_START_REQUEST = 'jobRequest:backfill-on-start';

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
}

export interface SearchJobRunnerDeps {
  config: SearchConfigSnapshot;
  methods: SearchJobMethods;
  metrics: Pick<SearchMetrics, 'backfill' | 'verify' | 'lease'>;
  logger: { warn(message: string, meta: object): unknown };
  service: Pick<SearchService, 'jobAnalyzer'>;
  holder?: string;
  now?: () => number;
}

/** One step of the chain. A step is safe to run again, so a new holder restarts the one it finds. */
interface ChainStep {
  name: string;
  run(): Promise<JobOutcome>;
}

export function createSearchJobRunner(deps: SearchJobRunnerDeps): SearchJobRunner {
  const { config, methods, metrics, logger, service, now = Date.now } = deps;
  const { batchSize, batchDelayMs, backfillOnStart } = config.jobs;
  const lease: SearchLease = createSearchLease({
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
  let ticking: Promise<void> | null = null;
  let active: Promise<void> | null = null;

  const readState = (key: string) => methods.readSearchState(key, JOB_STATE_READ);
  const isPaused = async () => (await readState(BACKFILL_KEYS.messages))?.pause === true;

  const control: JobControl = {
    batchSize,
    holds: () => !stopped && lease.isHeld(),
    async check() {
      if (!control.holds()) {
        return 'lost';
      }
      return (await isPaused()) ? 'paused' : null;
    },
    wait: () =>
      new Promise((resolve) => {
        setTimeout(resolve, batchDelayMs).unref();
      }),
  };

  /** The chain's order. Reconcile joins between `vocab` and `verify` when it lands. */
  const chainSteps = (): ChainStep[] => {
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
      { name: 'verify', run: () => runVerify({ methods, control, metrics, round: 1, now }) },
    ];
  };

  async function runChain(chain: SearchStateEntry): Promise<void> {
    const steps = chainSteps();
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
        next ? { step: next.name } : { finishedAt: new Date(now()) },
      );
    }
  }

  /** Only one job runs at a time. A failure is logged and the next heartbeat tries again. */
  function startJob(run: () => Promise<void>): void {
    active = run()
      .catch((error: unknown) => {
        logger.warn('[search] Job failed', getSafeErrorMetadata(error));
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
      for (const collection of SOURCE_COLLECTIONS) {
        await methods.deleteSearchState(BACKFILL_KEYS[collection]);
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
      case 'backfill':
        await startBackfillChain(key);
        return;
      case 'pause':
      case 'resume':
        await setPause(request.job === 'pause');
        await methods.deleteSearchState(key);
        return;
      case 'verify': {
        /* Waits its turn: a verify mid-chain would judge a half-built index. */
        const chain = await readState(CHAIN_KEY);
        if (active || (chain && chain.finishedAt == null) || (await isPaused())) {
          return;
        }
        const previous = await readState(VERIFICATION_KEY);
        const round = (typeof previous?.rounds === 'number' ? previous.rounds : 0) + 1;
        startJob(async () => {
          const outcome = await runVerify({ methods, control, metrics, round, now });
          if (outcome === 'done') {
            await methods.deleteSearchState(key);
          }
        });
        return;
      }
      default:
        logger.warn('[search] Unknown job request removed', {});
        await methods.deleteSearchState(key);
    }
  }

  /**
   * The owner's lever on top of T120's "only by request": a deploy can start the backfill.
   * Any chain at all means no request: an unfinished one resumes, a finished one stays finished.
   */
  async function requestBackfillOnStart(): Promise<void> {
    if (backfillOnStart && !(await readState(CHAIN_KEY))) {
      await methods.writeSearchState(ON_START_REQUEST, {
        job: 'backfill',
        requestedAt: new Date(now()),
      });
    }
  }

  async function heartbeat(): Promise<void> {
    if (!(await lease.tick())) {
      held = false;
      return;
    }
    if (!held) {
      held = true;
      await requestBackfillOnStart();
    }
    for (const request of await methods.listSearchJobRequests()) {
      await handleRequest(request);
    }
    if (active) {
      return;
    }
    const chain = await readState(CHAIN_KEY);
    if (chain && chain.finishedAt == null && !(await isPaused())) {
      startJob(() => runChain(chain));
    }
  }

  function tick(): Promise<void> {
    if (stopped) {
      return Promise.resolve();
    }
    if (!ticking) {
      ticking = runAsSystem(heartbeat)
        .catch((error: unknown) => {
          logger.warn('[search] Job heartbeat failed', getSafeErrorMetadata(error));
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
        logger.warn('[search] Lease release failed', getSafeErrorMetadata(error));
      });
    },
    isHolder: () => lease.isHeld(),
  };
}
