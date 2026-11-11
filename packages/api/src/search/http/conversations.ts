import { isSearchError } from '@librechat/data-schemas';
import type { SearchContext } from '@librechat/data-schemas';
import type { SearchReadStats, SearchRequestNotes, SearchService } from '../service';
import type { SearchContextRequest, SearchContextResponse } from './context';
import type { SearchMetrics, SearchOutcome } from '../metrics';
import type { SearchHttpResponse } from './errors';
import { createSearchContext } from './context';
import { searchErrorResponse } from './errors';
import { safeFailure } from '../failure';

export interface ConversationSearch {
  /** A context when the new backend serves. Otherwise `undefined`, so today's path runs. */
  context(req: SearchContextRequest, res: SearchContextResponse): SearchContext | undefined;
  /** Records a completed sidebar search. */
  completed(
    ctx: SearchContext | undefined,
    result: { conversations: readonly unknown[]; partial?: boolean },
  ): void;
  /**
   * The response for any failure of a search on the new backend, including the conversation
   * list read after its matches. `null` without a context, so the route runs as today.
   */
  failure(ctx: SearchContext | undefined, error: unknown): SearchHttpResponse | null;
}

export function createConversationSearch({
  service,
  metrics,
  logger,
}: {
  service: Pick<SearchService, 'isServing' | 'noteRequest' | 'readStats'>;
  metrics: Pick<SearchMetrics, 'request'>;
  logger: { warn(message: string, meta: object): unknown };
}): ConversationSearch {
  /* Taken when the request starts, as the messages route does, so both surfaces of one
   * search agree on whether it was cold. */
  const notes = new WeakMap<SearchContext, SearchRequestNotes>();
  const emit = (ctx: SearchContext, outcome: SearchOutcome, stats?: SearchReadStats) =>
    metrics.request({
      surface: 'conversations',
      backend: 'search',
      ms: Date.now() - ctx.startedAt,
      ...notes.get(ctx),
      ...stats,
      outcome,
    });

  return {
    context(req, res) {
      if (!service.isServing()) {
        return undefined;
      }
      const ctx = createSearchContext(req, res);
      notes.set(ctx, service.noteRequest(ctx.user));
      return ctx;
    },
    completed(ctx, { conversations, partial }) {
      if (ctx) {
        const found: SearchOutcome = conversations.length ? 'ok' : 'empty';
        emit(ctx, partial ? 'partial' : found, service.readStats(ctx));
      }
    },
    failure(ctx, error) {
      if (!ctx) {
        return null;
      }
      if (!isSearchError(error)) {
        logger.warn('[search] Conversation list failed', safeFailure(error));
      }
      const response = searchErrorResponse(error);
      emit(ctx, ctx.signal.aborted ? 'aborted' : response.body.code);
      return response;
    },
  };
}
