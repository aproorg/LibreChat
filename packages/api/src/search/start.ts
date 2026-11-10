import { randomUUID } from 'node:crypto';
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
import { createSearchConfigSnapshot, isSearchDataOn } from './config';
import { createSearchWriter, startSyncStatus } from './sync/writer';
import { checkObserved, recordObserved } from './sync/observed';
import { createConversationSearch } from './http/conversations';
import { createSearchMessagesRoute } from './http/messages';
import { getSafeErrorMetadata } from '~/utils/errors';
import { createSearchJobRunner } from './jobs/runner';
import { createSearchContext } from './http/context';
import { createSearchStatus } from './http/status';
import { createSearchLease } from './sync/lease';
import { createSearchService } from './service';
import { createSearchMetrics } from './metrics';

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
  enabled: SearchStatus['enabled'];
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
  const route: SearchMessagesRoute = createSearchMessagesRoute({ service, methods, metrics });
  const status = createSearchStatus({ service, methods, logger });
  let jobs: SearchJobRunner | null = null;
  let writer: SearchWriter | null = null;
  let stopStatus: (() => void) | null = null;
  /* A stop can arrive while packs load; nothing may start after it. */
  let stopping = false;
  /* With no `search` block nothing is read at all, so a tenant without search stays as today. */
  const hasBlock = appConfig.search !== undefined;

  /* Readiness must notice an abort or stopped sync, so a failed check is only logged (R-11). */
  const observe = async (step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      logger.warn('[search] Observed config check failed', getSafeErrorMetadata(error));
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
      await observe(() => checkObserved({ methods, config }));
      if (!isSearchDataOn(config)) {
        return;
      }
      try {
        metrics.startRealtextFlush();
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
        /* First, or the lease write would create `search_state` implicitly. */
        await methods.ensureSearchCollections();
        await observe(() => recordObserved({ methods, config }));
        if (stopping) {
          return;
        }
        jobs = createSearchJobRunner({ config, methods, metrics, logger, service, lease });
        jobs.start();
        writer = createSearchWriter({ config, methods, metrics, logger, service, lease });
        writer.start();
      } catch (error) {
        logger.warn('[search] Background start failed', getSafeErrorMetadata(error));
      }
    },
    async stopBackground() {
      stopping = true;
      stopStatus?.();
      try {
        await writer?.stop();
        await jobs?.stop();
      } catch (error) {
        logger.warn('[search] Background stop failed', getSafeErrorMetadata(error));
      }
    },
    messages: (req, res, query, cursor) =>
      service.isServing()
        ? route(createSearchContext(req, res), query, cursor)
        : Promise.resolve(null),
    conversations: createConversationSearch({ service, metrics, logger }),
    enabled: status.enabled,
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
