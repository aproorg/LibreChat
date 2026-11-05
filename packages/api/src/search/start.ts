import type { SearchMethods, SearchPort } from '@librechat/data-schemas';
import type { SearchContextRequest, SearchContextResponse } from './http/context';
import type { SearchJobMethods, SearchJobRunner } from './jobs/runner';
import type { SearchService, SearchServiceDeps } from './service';
import type { ConversationSearch } from './http/conversations';
import type { SearchMessagesRoute } from './http/messages';
import type { SearchHttpResponse } from './http/errors';
import type { SearchConfigSnapshot } from './config';
import type { SearchMetricsLogger } from './metrics';
import type { SearchStatus } from './http/status';
import { createSearchConfigSnapshot, isSearchDataOn } from './config';
import { createConversationSearch } from './http/conversations';
import { createSearchMessagesRoute } from './http/messages';
import { getSafeErrorMetadata } from '~/utils/errors';
import { createSearchJobRunner } from './jobs/runner';
import { createSearchContext } from './http/context';
import { createSearchStatus } from './http/status';
import { createSearchService } from './service';
import { createSearchMetrics } from './metrics';

export interface BindSearchDeps {
  app: { locals: Record<string, unknown> };
  /** From `getAppConfig({ baseOnly: true })`, so no config document can change search. */
  appConfig: { search?: Parameters<typeof createSearchConfigSnapshot>[0]['search'] };
  methods: SearchServiceDeps['methods'] &
    SearchJobMethods &
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

  const binding: SearchBinding = {
    service,
    config,
    async startBackground() {
      if (!isSearchDataOn(config)) {
        return;
      }
      try {
        metrics.startRealtextFlush();
        await service.loadPacks();
        /* A failed pack takes no lease, so one bad task cannot stall the tenant (R-09). */
        if (service.packState() !== 'loaded') {
          return;
        }
        /* First, or the lease write would create `search_state` implicitly. */
        await methods.ensureSearchCollections();
        jobs = createSearchJobRunner({ config, methods, metrics, logger, service });
        jobs.start();
      } catch (error) {
        logger.warn('[search] Background start failed', getSafeErrorMetadata(error));
      }
    },
    messages: (req, res, query, cursor) =>
      service.isServing()
        ? route(createSearchContext(req, res), query, cursor)
        : Promise.resolve(null),
    conversations: createConversationSearch({ service, metrics, logger }),
    enabled: status.enabled,
    jobs: () => jobs,
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
