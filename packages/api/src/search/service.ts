import { getTenantId, SearchError, isSearchError } from '@librechat/data-schemas';
import type {
  SearchContext,
  SearchMethods,
  SearchPort,
  SearchPortMatches,
  SearchWindowRow,
} from '@librechat/data-schemas';
import type { SearchReason } from 'librechat-data-provider';
import type { SearchMetrics, SearchRequestEvent, SearchSurface, SearchTier } from './metrics';
import type { SearchPackResolution } from './languages/registry';
import type { ReadGate, SearchReadRunner } from './read/retry';
import type { PlanExpansions, PlanRead } from './read/plan';
import type { AnalyzedQuery } from './analyzer/query';
import type { SearchConfigSnapshot } from './config';
import type { LanguagePack } from './languages/pack';
import type { Analyzer } from './analyzer/analyze';
import type { DerivedHits } from './read/window';
import type { Expansion } from './read/tiers';
import {
  createSharedRead,
  derivePage,
  deriveRanked,
  estimatePlanReadBytes,
  SEARCH_PAGE_SIZE,
  SHARED_READ_TTL_MS,
  sharedReadSize,
} from './read/window';
import { createReadGate, createReadRunner } from './read/retry';
import { createSearchLimiter, userShare } from './read/limiter';
import { computeAnalyzerVersion } from './analyzer/version';
import { isSearchDataOn, isSearchServing } from './config';
import { resolveSearchPacks } from './languages/registry';
import { createSearchCursorCodec } from './read/cursor';
import { createAnalyzer } from './analyzer/analyze';
import { firstCursor, walkPage } from './read/page';
import { SearchPackError } from './languages/pack';
import { readTitleMatches } from './read/titles';
import { analyzeQuery } from './analyzer/query';
import { readSearchPlan } from './read/plan';
import { expandPrefix } from './read/tiers';
import { expandTypos } from './read/typo';
import { safeFailure } from './failure';

/** Expansions are a few hundred short tokens; this bounds how many queries' worth are kept. */
const SHARED_EXPANSION_BYTES = 4 * 1024 * 1024;
const ESTIMATED_TOKEN_BYTES = 64;
/** Title reads a process runs at once, as a multiple of `maxConcurrentSearches`. */
const TITLE_GATE_FACTOR = 4;
/** A word with no expansion still holds a key and an entry, so it counts against the budget. */
const ESTIMATED_ENTRY_BYTES = 256;

/** `coldAfterIdle` means the first search after this long with none (`contracts/telemetry.md`). */
const COLD_AFTER_IDLE_MS = 30 * 60 * 1000;
/**
 * One search fires `/search` and the sidebar together, and both wait on the same cold read.
 * A request starting this soon after a cold one is cold too, or the second surface would
 * log the cold read's time as warm.
 */
const COLD_SPAN_MS = 5_000;

export type SearchPackState = 'loading' | 'loaded' | 'failed';

export type SearchServiceMethods = Pick<
  SearchMethods,
  | 'readVocabFrequencies'
  | 'readVocabRange'
  | 'readRecordWindow'
  | 'readRecordTies'
  | 'readRecordTokens'
  | 'readMessageTexts'
  | 'readConversationRecords'
  | 'getSearchableMessages'
  | 'getSearchHitConversations'
  | 'readSearchState'
>;

export interface SearchServiceDeps {
  config: SearchConfigSnapshot;
  methods: SearchServiceMethods;
  metrics: SearchMetrics;
  logger: { warn(message: string, meta: object): unknown };
  /** Keys load-more's cursor. The caller reads it from `JWT_SECRET`, so this module reads no env. */
  cursorSecret: string;
  resolvePacks?: (
    ids: readonly string[],
    deps: { languageDataDir: string },
  ) => SearchPackResolution;
  now?: () => number;
}

export interface MessageSearchHits {
  hits: Array<Pick<SearchWindowRow, 'messageId' | 'conversationId'>>;
  /** Non-null whenever more matches may exist, even after a short page (FR-013). */
  nextCursor: string | null;
  words: number;
  tierReached: SearchTier;
  reads: number;
  rows: number;
  reason?: SearchReason;
}

/** What `search.request` reports of a search's reads. Reads it was served are not its own. */
export type SearchReadStats = Pick<SearchRequestEvent, 'reads' | 'rows' | 'words' | 'tierReached'>;

export interface SearchRequestNotes {
  coldAfterIdle: boolean;
  isLargestUser: boolean;
}

/** Answers `null` wherever Meilisearch serves, so its caller runs today's code unchanged. */
export interface SearchService extends SearchPort {
  readonly config: SearchConfigSnapshot;
  isServing(): boolean;
  packState(): SearchPackState;
  /** Called once, in the background, after the server listens. Never rejects. */
  loadPacks(): Promise<void>;
  /** What jobs build records with, or `null` until packs have loaded. */
  jobAnalyzer(): {
    analyzer: Analyzer;
    version: string;
    /** Enabled packs, for the attribution the writer records (FR-043). */
    packs?: ReadonlyArray<Pick<LanguagePack, 'id' | 'attribution'>>;
  } | null;
  searchMessages(
    ctx: SearchContext,
    query: string,
    cursor?: unknown,
  ): Promise<MessageSearchHits | null>;
  /** A runner for one request's reads outside the shared read, under the same timeout. */
  requestRunner(ctx: SearchContext, surface: SearchSurface): SearchReadRunner;
  /** A sidebar search's figures, for its `search.request`. */
  readStats(ctx: SearchContext): SearchReadStats;
  /** Call once, when the request starts: the answer depends on when the last one started. */
  noteRequest(user: string): SearchRequestNotes;
}

const failureCode = (error: unknown) => (isSearchError(error) ? error.code : 'search_failed');

export function createSearchService(deps: SearchServiceDeps): SearchService {
  const { config, methods, metrics, logger, now = Date.now } = deps;
  const { resolvePacks = resolveSearchPacks } = deps;
  const limiter = createSearchLimiter({
    maxConcurrent: config.maxConcurrentSearches,
    maxPerUser: userShare(config.maxConcurrentSearches),
    timeoutMs: config.searchTimeoutMs,
  });
  /*
   * Title reads stay outside the serving cap, so the sidebar still answers while message
   * search is busy (FR-017). They get a gate of their own, sized from the same setting: one
   * user's parallel requests could otherwise each open several word list reads at once.
   */
  const titleLimiter = createSearchLimiter({
    maxConcurrent: config.maxConcurrentSearches * TITLE_GATE_FACTOR,
    maxPerUser: config.maxConcurrentSearches,
    timeoutMs: config.searchTimeoutMs,
  });
  const sharedRead = createSharedRead<PlanRead>({
    ttlMs: SHARED_READ_TTL_MS,
    maxBytes: config.sharedReadMaxBytes,
    sizeOf: estimatePlanReadBytes,
    now,
  });
  const sharedExpansions = createSharedRead<Expansion>({
    ttlMs: SHARED_READ_TTL_MS,
    maxBytes: SHARED_EXPANSION_BYTES,
    sizeOf: ({ tokens }) => ESTIMATED_ENTRY_BYTES + tokens.length * ESTIMATED_TOKEN_BYTES,
    now,
  });
  const size = sharedReadSize(config);
  const cursors = createSearchCursorCodec(deps.cursorSecret);
  /** A multi-word page reads tokens and text to rank, once per shared read, in flight or done. */
  const rankedPages = new WeakMap<PlanRead, Promise<DerivedHits>>();

  let state: SearchPackState = 'loading';
  let analyzer: Analyzer | null = null;
  let analyzerVersion = '';
  let loadedPacks: ReadonlyArray<Pick<LanguagePack, 'id' | 'attribution'>> = [];
  let lastRequestAt: number | null = null;
  let coldSince: number | null = null;
  const gates = new WeakMap<SearchContext, ReadGate>();
  const sidebarStats = new WeakMap<SearchContext, SearchReadStats>();

  const emitPack = (id: string, packState: SearchPackState, startedAt: number, rss: number) =>
    metrics.pack({
      id,
      state: packState,
      ms: now() - startedAt,
      rssDelta: process.memoryUsage().rss - rss,
    });

  async function loadPacks(): Promise<void> {
    if (!isSearchDataOn(config)) {
      return;
    }
    try {
      const resolved = resolvePacks(config.languages, { languageDataDir: config.languageDataDir });
      if (!resolved.ok) {
        state = 'failed';
        logger.warn('[search] Language pack failed', {
          id: resolved.error.id,
          code: resolved.error.code,
        });
        emitPack(resolved.error.id, 'failed', now(), process.memoryUsage().rss);
        return;
      }
      for (const pack of resolved.packs) {
        const startedAt = now();
        const rss = process.memoryUsage().rss;
        try {
          await pack.load?.();
          emitPack(pack.id, 'loaded', startedAt, rss);
        } catch (error) {
          state = 'failed';
          logger.warn('[search] Language pack failed', {
            id: pack.id,
            code: error instanceof SearchPackError ? error.code : 'pack_load_failed',
          });
          emitPack(pack.id, 'failed', startedAt, rss);
          return;
        }
      }
      analyzer = createAnalyzer({
        packs: resolved.packs,
        cacheWords: config.analysisCacheWords,
        realtext: metrics.realtext,
      });
      analyzerVersion = computeAnalyzerVersion(resolved.packs);
      loadedPacks = resolved.packs.map(({ id, attribution }) => ({ id, attribution }));
      state = 'loaded';
    } catch (error) {
      state = 'failed';
      logger.warn('[search] Language packs failed to load', safeFailure(error));
    }
  }

  function readyAnalyzer(): Analyzer {
    if (!isSearchDataOn(config) || state === 'failed') {
      throw new SearchError('search_failed');
    }
    if (state === 'loading' || !analyzer) {
      throw new SearchError('search_busy');
    }
    return analyzer;
  }

  /** A pack throwing on a word is a coded failure, on every surface (FR-018). */
  const analyze = (query: string): AnalyzedQuery => {
    const ready = readyAnalyzer();
    try {
      return analyzeQuery(ready, query, {
        queryWordLimit: config.queryWordLimit,
        realtext: metrics.realtext,
      });
    } catch (error) {
      logger.warn('[search] Query analysis failed', safeFailure(error));
      throw new SearchError('search_failed');
    }
  };

  /**
   * One per search, so a sidebar's title and message reads share `readConcurrency` (FR-017).
   * A read joined from another search stays on that search's gate (R-12).
   */
  const gateFor = (ctx: SearchContext): ReadGate => {
    const existing = gates.get(ctx);
    if (existing) {
      return existing;
    }
    const gate = createReadGate(config.readConcurrency);
    gates.set(ctx, gate);
    return gate;
  };

  const requestRunner = (ctx: SearchContext, surface: SearchSurface): SearchReadRunner =>
    createReadRunner({
      surface,
      signal: ctx.signal,
      deadline: ctx.startedAt + config.searchTimeoutMs,
      gate: gateFor(ctx),
      metrics,
      logger,
    });

  /**
   * A word's prefix or typo expansion, read once for the title and message reads of one
   * user's search and for both surfaces that fire it. The first caller's runner makes the read.
   */
  const expansionsFor = (
    user: string,
    signal: AbortSignal,
    run: SearchReadRunner,
  ): PlanExpansions => {
    const shared = async (
      kind: 'prefix' | 'typo',
      exact: string,
      read: () => Promise<Expansion>,
    ) => {
      /* Per user, like every shared read (FR-015): across users, a skipped read would tell
       * one of them that someone else had just searched the same word. */
      const key = JSON.stringify([getTenantId() ?? '', user, kind, exact]);
      try {
        return await sharedExpansions.get(key, signal, read);
      } catch (error) {
        /* The search that started the read left. This one is still waiting, so it reads. */
        if (signal.aborted || !isSearchError(error) || error.code !== 'search_busy') {
          throw error;
        }
        return sharedExpansions.get(key, signal, read);
      }
    };
    return {
      prefix: (exact) =>
        shared('prefix', exact, () =>
          expandPrefix(exact, config.prefix, { run, methods, realtext: metrics.realtext }),
        ),
      typos: (exact) =>
        shared('typo', exact, () =>
          expandTypos(exact, config.typo, { run, methods, realtext: metrics.realtext }),
        ),
    };
  };

  /** Counts once against the cap, whichever surfaces wait on it (FR-015). */
  const readShared = async (
    ctx: SearchContext,
    { words }: AnalyzedQuery,
    surface: SearchSurface,
  ): Promise<{ read: PlanRead; reads: number; rows: number }> => {
    let started = false;
    const read = await sharedRead.get(
      JSON.stringify([getTenantId() ?? '', ctx.user, words.map(({ raw }) => raw)]),
      ctx.signal,
      (signal) => {
        started = true;
        return limiter.run(
          signal,
          (scope) => {
            const run = createReadRunner({
              surface,
              signal: scope.signal,
              deadline: scope.deadline,
              gate: gateFor(ctx),
              metrics,
              logger,
            });
            return readSearchPlan({
              user: ctx.user,
              words,
              ...size,
              readConcurrency: config.readConcurrency,
              methods,
              run,
              prefix: config.prefix,
              typo: config.typo,
              expansions: expansionsFor(ctx.user, scope.signal, run),
              realtext: metrics.realtext,
              now,
            });
          },
          ctx.user,
        );
      },
    );
    return { read, reads: started ? read.reads : 0, rows: started ? read.rows : 0 };
  };

  const derive = (read: PlanRead, limit: number) =>
    deriveRanked(read, {
      limit,
      rankWindow: config.rankWindow,
      lengthBucket: config.rank.lengthBucket,
    });

  const rank = async (ctx: SearchContext, read: PlanRead): Promise<DerivedHits> => {
    const options = {
      limit: SEARCH_PAGE_SIZE,
      rankWindow: config.rankWindow,
      lengthBucket: config.rank.lengthBucket,
    };
    const analyzer_ = readyAnalyzer();
    const until = ctx.startedAt + config.searchTimeoutMs;
    const reads = (signal: AbortSignal, deadline: number) => ({
      user: ctx.user,
      run: createReadRunner({
        surface: 'messages',
        signal,
        deadline,
        gate: gateFor(ctx),
        metrics,
        logger,
      }),
      methods,
      analyzer: analyzer_,
      signal,
      deadline,
    });
    if (read.plan.words.length < 2) {
      /* One word ranks from the rows already read: no read, so no slot. */
      return derivePage(read, options, reads(ctx.signal, until));
    }
    /*
     * Several words read every candidate's tokens and the text of the top ones, which is the
     * costly part of such a search. So it holds a slot of the cap, as the plan read did.
     */
    return limiter.run(
      ctx.signal,
      (scope) => derivePage(read, options, reads(scope.signal, Math.min(scope.deadline, until))),
      ctx.user,
    );
  };

  /** Kept from the moment it starts, so identical requests in flight share one ranking. */
  const startRanking = (ctx: SearchContext, read: PlanRead): Promise<DerivedHits> => {
    const ranking = rank(ctx, read);
    rankedPages.set(read, ranking);
    ranking.catch(() => {
      if (rankedPages.get(read) === ranking) {
        rankedPages.delete(read);
      }
    });
    return ranking;
  };

  const firstPage = async (ctx: SearchContext, read: PlanRead): Promise<DerivedHits> => {
    const joined = rankedPages.get(read);
    if (joined) {
      try {
        return await joined;
      } catch (error) {
        /* The search that started this ranking left or ran out of time. This one is still waiting. */
        if (ctx.signal.aborted || !isSearchError(error) || error.code !== 'search_busy') {
          throw error;
        }
      }
    }
    return rankedPages.get(read) ?? startRanking(ctx, read);
  };

  /** Load-more reads directly: its position is its own, so there is nothing to share (R-08). */
  const loadMore = async (
    ctx: SearchContext,
    query: string,
    cursorText: unknown,
  ): Promise<MessageSearchHits> => {
    readyAnalyzer();
    const scope = { user: ctx.user, query };
    const cursor = cursors.decode(cursorText, scope);
    const walked = await limiter.run(
      ctx.signal,
      (limited) => {
        const run = createReadRunner({
          surface: 'messages',
          signal: limited.signal,
          deadline: limited.deadline,
          gate: gateFor(ctx),
          metrics,
          logger,
        });
        return walkPage({
          user: ctx.user,
          cursor,
          pageSize: SEARCH_PAGE_SIZE,
          rankWindow: config.rankWindow,
          lengthBucket: config.rank.lengthBucket,
          prefix: config.prefix,
          run,
          methods,
          expansions: expansionsFor(ctx.user, limited.signal, run),
          realtext: metrics.realtext,
        });
      },
      ctx.user,
    );
    return {
      hits: walked.rows.map(({ messageId, conversationId }) => ({ messageId, conversationId })),
      nextCursor: walked.cursor ? cursors.encode(walked.cursor, scope) : null,
      words: cursor.plan.words.length,
      tierReached: walked.rows.length ? walked.rows[walked.rows.length - 1].tier : 'none',
      reads: walked.reads,
      rows: walked.rowsRead,
    };
  };

  const emptyReason = ({ status }: AnalyzedQuery): { reason?: SearchReason } =>
    status === 'only_stop_words' ? { reason: 'only_stop_words' } : {};

  const titles = (ctx: SearchContext, analyzed: AnalyzedQuery, surface: SearchSurface) => {
    const run = requestRunner(ctx, surface);
    return titleLimiter.run(
      ctx.signal,
      () =>
        readTitleMatches({
          user: ctx.user,
          words: analyzed.words,
          run,
          methods,
          expansions: expansionsFor(ctx.user, ctx.signal, run),
        }),
      ctx.user,
    );
  };

  async function searchMessages(
    ctx: SearchContext,
    query: string,
    cursor?: unknown,
  ): Promise<MessageSearchHits | null> {
    if (!isSearchServing(config)) {
      return null;
    }
    if (cursor != null && cursor !== '') {
      return loadMore(ctx, query, cursor);
    }
    const analyzed = analyze(query);
    if (analyzed.status !== 'ok') {
      return {
        hits: [],
        nextCursor: null,
        words: 0,
        tierReached: 'none',
        reads: 0,
        rows: 0,
        ...emptyReason(analyzed),
      };
    }
    const { read, reads, rows } = await readShared(ctx, analyzed, 'messages');
    const { hits, tierReached, more } = await firstPage(ctx, read);
    metrics.realtext.addTier(tierReached);
    return {
      hits: hits.map(({ messageId, conversationId }) => ({ messageId, conversationId })),
      nextCursor: more ? cursors.encode(firstCursor(read, hits), { user: ctx.user, query }) : null,
      words: analyzed.words.length,
      tierReached,
      reads,
      rows,
    };
  }

  async function conversationMatches(
    ctx: SearchContext,
    query: string,
  ): Promise<SearchPortMatches | null> {
    if (!isSearchServing(config)) {
      return null;
    }
    const analyzed = analyze(query);
    if (analyzed.status !== 'ok') {
      sidebarStats.set(ctx, { words: 0, tierReached: 'none', reads: 0, rows: 0 });
      return { conversationIds: [], ...emptyReason(analyzed) };
    }
    const words = analyzed.words.length;
    const messageRead = readShared(ctx, analyzed, 'conversations').then(
      (shared) => ({ ok: true as const, ...shared }),
      (error: unknown) => ({ ok: false as const, code: failureCode(error) }),
    );
    /* A title failure discards message hits (FR-018); the message read has no rejection to leak. */
    const titleIds = await titles(ctx, analyzed, 'conversations');
    const message = await messageRead;
    if (!message.ok) {
      /* The client left: a failed read would raise an alarm for a search nobody is waiting on. */
      if (ctx.signal.aborted) {
        throw new SearchError('search_busy');
      }
      metrics.partial({ surface: 'conversations', code: message.code });
      sidebarStats.set(ctx, { words });
      return { conversationIds: titleIds, partial: true };
    }
    const { hits, tierReached } = derive(message.read, config.sidebarLimit);
    sidebarStats.set(ctx, { words, tierReached, reads: message.reads, rows: message.rows });
    return {
      conversationIds: [
        ...new Set([...titleIds, ...hits.map(({ conversationId }) => conversationId)]),
      ],
    };
  }

  async function titleMatches(
    ctx: SearchContext,
    query: string,
  ): Promise<SearchPortMatches | null> {
    if (!isSearchServing(config)) {
      return null;
    }
    const analyzed = analyze(query);
    if (analyzed.status !== 'ok') {
      return { conversationIds: [], ...emptyReason(analyzed) };
    }
    return { conversationIds: await titles(ctx, analyzed, 'shares') };
  }

  return {
    config,
    isServing: () => isSearchServing(config),
    packState: () => state,
    loadPacks,
    jobAnalyzer: () =>
      state === 'loaded' && analyzer
        ? { analyzer, version: analyzerVersion, packs: loadedPacks }
        : null,
    searchMessages,
    conversationMatches,
    titleMatches,
    requestRunner,
    readStats: (ctx) => sidebarStats.get(ctx) ?? {},
    noteRequest(user) {
      const at = now();
      if (lastRequestAt === null || at - lastRequestAt >= COLD_AFTER_IDLE_MS) {
        coldSince = at;
      }
      const coldAfterIdle = coldSince !== null && at - coldSince < COLD_SPAN_MS;
      lastRequestAt = at;
      const { largestUserId } = config;
      return { coldAfterIdle, isLargestUser: largestUserId !== '' && user === largestUserId };
    },
  };
}
