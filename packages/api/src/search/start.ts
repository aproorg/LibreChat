import { randomUUID } from 'node:crypto';
import { SearchError } from '@librechat/data-schemas';
import type { SearchMethods, SearchPort } from '@librechat/data-schemas';
import type { SearchContextRequest, SearchContextResponse } from './http/context';
import type { SearchJobMethods, SearchJobRunner } from './jobs/runner';
import type { SearchWriter, SearchWriterMethods } from './sync/writer';
import type { SearchService, SearchServiceDeps } from './service';
import type { ConversationSearch } from './http/conversations';
import type { SearchMessagesRoute } from './http/messages';
import type { SearchHttpResponse } from './http/errors';
import type { SearchConfigSnapshot } from './config';
import type { SearchMetricsLogger } from './metrics';
import type { SearchStatus } from './http/status';
import type { ShareSearch } from './http/shares';
import type { SearchLease } from './sync/lease';
import type { MeiliStatusDeps } from './meili';
import { createSearchConfigSnapshot, isSearchDataOn } from './config';
import { createSearchWriter, startSyncStatus } from './sync/writer';
import { checkObserved, recordObserved } from './sync/observed';
import { createConversationSearch } from './http/conversations';
import { createSearchMessagesRoute } from './http/messages';
import { createSearchJobRunner } from './jobs/runner';
import { createSearchContext } from './http/context';
import { searchErrorResponse } from './http/errors';
import { createSearchStatus } from './http/status';
import { createShareSearch } from './http/shares';
import { createSearchLease } from './sync/lease';
import { createSearchService } from './service';
import { createSearchMetrics } from './metrics';
import { isSearchCursor } from './read/cursor';
import { safeFailure } from './failure';

/** The longest a shutdown waits for the writer and runner before leaving the lease to expire. */
const STOP_BOUND_MS = 5_000;
/** A failed start of sync is tried again after this long, doubling up to the cap. */
const START_RETRY_MS = 5_000;
const START_RETRY_MAX_MS = 5 * 60_000;

export interface BindSearchDeps {
  app: { locals: Record<string, unknown> };
  /** From `getAppConfig({ baseOnly: true })`, so no config document can change search. */
  appConfig: { search?: Parameters<typeof createSearchConfigSnapshot>[0]['search'] };
  methods: SearchServiceDeps['methods'] &
    SearchJobMethods &
    SearchWriterMethods &
    Pick<SearchMethods, 'ensureSearchCollections'>;
  setSearchPort(port: SearchPort): void;
  jwtSecret?: string;
  logger: SearchMetricsLogger;
  resolvePacks?: SearchServiceDeps['resolvePacks'];
  /** Meilisearch as `/api/search/enable` sees it. Left out, `SEARCH` counts as off. */
  meili?: MeiliStatusDeps;
  /** The first wait before a failed start of sync is tried again. */
  startRetryMs?: number;
}

/** What routes reach through `app.locals.search`: each only adds its call to one of these. */
export interface SearchBinding {
  service: SearchService;
  config: SearchConfigSnapshot;
  /** Never rejects. */
  startBackground(): Promise<void>;
  /**
   * Stops the writer, then the runner, which gives the lease up, so the next process takes
   * over at once rather than after `syncTakeoverSeconds`. Never rejects.
   */
  stopBackground(): Promise<void>;
  messages(
    req: SearchContextRequest,
    res: SearchContextResponse,
    query: unknown,
    cursor: unknown,
  ): Promise<SearchHttpResponse | null>;
  conversations: ConversationSearch;
  shares: ShareSearch;
  enabled: SearchStatus['enabled'];
  meta: SearchStatus['meta'];
  /** The running job runner, or `null` before packs load, or with search data off. */
  jobs(): SearchJobRunner | null;
  /** The running sync writer, or `null` before packs load, or with search data off. */
  writer(): SearchWriter | null;
}

/**
 * Runs before listen, so no request meets an unbound port. It reads nothing and loads
 * nothing: with the default configuration the service it binds answers `null` everywhere.
 */
export function bindSearch(deps: BindSearchDeps): SearchBinding {
  const { app, appConfig, methods, setSearchPort, jwtSecret = '', logger, resolvePacks } = deps;
  const { meili = { env: {} } } = deps;
  const config = createSearchConfigSnapshot(appConfig);
  const metrics = createSearchMetrics(logger);
  const service = createSearchService({
    config,
    methods,
    metrics,
    logger,
    cursorSecret: jwtSecret,
    ...(resolvePacks ? { resolvePacks } : {}),
  });
  const route: SearchMessagesRoute = createSearchMessagesRoute({
    service,
    methods,
    metrics,
    logger,
  });
  const status = createSearchStatus({ service, methods, logger, meili });
  let jobs: SearchJobRunner | null = null;
  let writer: SearchWriter | null = null;
  let stopStatus: (() => void) | null = null;
  let stopRealtext: (() => void) | null = null;
  let startRetry: NodeJS.Timeout | null = null;
  let observeRetry: NodeJS.Timeout | null = null;
  const startRetryMs = deps.startRetryMs ?? START_RETRY_MS;
  /* A stop can arrive while packs load; nothing may start after it. */
  let stopping = false;
  /* With no `search` block nothing is read at all, so a tenant without search stays as today. */
  const hasBlock = appConfig.search !== undefined;

  /* Readiness must notice an abort or stopped sync, so a failed check is only logged (R-11). */
  const observe = async (step: () => Promise<void>): Promise<boolean> => {
    try {
      await step();
      return true;
    } catch (error) {
      logger.warn('[search] Observed config check failed', safeFailure(error));
      return false;
    }
  };
  /*
   * Whether this process has compared its settings with the stored ones. Until it has, it
   * must not store its own: that would erase the evidence that the tenant had been serving
   * from the new search, and an old verification could then serve again (FR-037).
   */
  let observedChecked = false;
  /* Storing this process's settings creates `search_state`, so only once it is known to exist. */
  let collectionsReady = false;

  /** Compares with the stored settings, then stores this process's own. Never rejects. */
  const settleObserved = async (): Promise<void> => {
    observedChecked ||= await observe(() => checkObserved({ methods, config }));
    if (observedChecked && collectionsReady) {
      await observe(() => recordObserved({ methods, config }));
    }
  };

  /**
   * Until the comparison has run once. A process with search data off has no other path that
   * would make it, and a missed one lets an old verification serve again later (FR-037).
   */
  const retryObserved = (attempt = 0): void => {
    if (observedChecked || stopping) {
      return;
    }
    observeRetry = setTimeout(
      () => {
        observeRetry = null;
        if (stopping) {
          return;
        }
        void settleObserved().then(() => retryObserved(attempt + 1));
      },
      Math.min(startRetryMs * 2 ** attempt, START_RETRY_MAX_MS),
    );
    observeRetry.unref();
  };

  /**
   * The runner and the writer, once the collections exist. The database can be away for a
   * moment at start, as in a failover during a deploy, and a process left there would run
   * without sync for its whole life, so a failure is tried again. Never rejects.
   */
  const startSync = async (lease: SearchLease, attempt = 0): Promise<void> => {
    try {
      /* First, or the lease write would create `search_state` implicitly. */
      await methods.ensureSearchCollections();
      collectionsReady = true;
      await settleObserved();
      if (stopping) {
        return;
      }
      jobs = createSearchJobRunner({ config, methods, metrics, logger, service, lease });
      jobs.start();
      writer = createSearchWriter({ config, methods, metrics, logger, service, lease });
      writer.start();
    } catch (error) {
      logger.warn('[search] Background start failed', safeFailure(error));
      if (stopping) {
        return;
      }
      startRetry = setTimeout(
        () => {
          startRetry = null;
          void startSync(lease, attempt + 1);
        },
        Math.min(startRetryMs * 2 ** attempt, START_RETRY_MAX_MS),
      );
      startRetry.unref();
    }
  };

  const binding: SearchBinding = {
    service,
    config,
    async startBackground() {
      if (!hasBlock) {
        return;
      }
      /* In every process, before anything else, so a restart's change is seen first (T124). */
      await settleObserved();
      retryObserved();
      if (!isSearchDataOn(config)) {
        return;
      }
      try {
        stopRealtext = metrics.startRealtextFlush();
        await service.loadPacks();
        if (stopping) {
          return;
        }
        const lease = createSearchLease({
          methods,
          holder: randomUUID(),
          takeoverSeconds: config.syncTakeoverSeconds,
          packsLoaded: () => service.jobAnalyzer() !== null,
          metrics,
        });
        /* From every process with data on, pack or not, so a stalled writer still alarms. */
        stopStatus = startSyncStatus({
          methods,
          metrics,
          logger,
          isHolder: () => lease.isHeld(),
        }).stop;
        /* A failed pack takes no lease, so one bad task cannot stall the tenant (R-09). */
        if (service.packState() !== 'loaded') {
          return;
        }
        await startSync(lease);
      } catch (error) {
        logger.warn('[search] Background start failed', safeFailure(error));
      }
    },
    async stopBackground() {
      stopping = true;
      stopStatus?.();
      if (stopRealtext) {
        stopRealtext();
        stopRealtext = null;
        /* The counts since the last minute's flush would otherwise be lost. */
        metrics.flushRealtext();
      }
      for (const timer of [startRetry, observeRetry]) {
        if (timer) {
          clearTimeout(timer);
        }
      }
      startRetry = null;
      observeRetry = null;
      const stop = async () => {
        try {
          await writer?.stop();
          await jobs?.stop();
        } catch (error) {
          logger.warn('[search] Background stop failed', safeFailure(error));
        }
      };
      /*
       * Bounded, so a slow database cannot eat the budget of the shutdown tasks after this one.
       * Handing the lease over is only a speed-up: it expires on its own if this runs out.
       */
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        stop(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STOP_BOUND_MS);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    },
    messages: (req, res, query, cursor) => {
      if (service.isServing()) {
        return route(createSearchContext(req, res), query, cursor);
      }
      /* A new-search cursor here came from before a rollback: Meilisearch would read it as a date. */
      return Promise.resolve(
        isSearchCursor(cursor)
          ? searchErrorResponse(new SearchError('search_cursor_invalid'))
          : null,
      );
    },
    conversations: createConversationSearch({ service, metrics, logger }),
    shares: createShareSearch({ service, metrics, logger }),
    enabled: status.enabled,
    meta: status.meta,
    jobs: () => jobs,
    writer: () => writer,
  };

  setSearchPort(service);
  app.locals.search = binding;
  return binding;
}

/**
 * Called un-awaited after the server listens, outside the post-listen `try` that exits
 * the process: a search failure must neither crash it nor delay readiness. Never rejects.
 */
export function startSearchBackground(binding: SearchBinding): Promise<void> {
  return binding.startBackground();
}
