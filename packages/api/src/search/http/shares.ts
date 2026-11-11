import { isSearchError } from '@librechat/data-schemas';
import type { SearchContext } from '@librechat/data-schemas';
import type { SearchContextRequest, SearchContextResponse } from './context';
import type { SearchRequestNotes, SearchService } from '../service';
import type { SearchMetrics, SearchOutcome } from '../metrics';
import type { SearchHttpResponse } from './errors';
import { createSearchContext } from './context';
import { searchErrorResponse } from './errors';
import { safeFailure } from '../failure';

export interface ShareSearch {
  /** A context when the new backend serves. Otherwise `undefined`, so today's path runs. */
  context(req: SearchContextRequest, res: SearchContextResponse): SearchContext | undefined;
  /** Records a completed shared-link search. */
  completed(ctx: SearchContext | undefined, result: { links: readonly unknown[] }): void;
  /**
   * The response for any failure of a search on the new backend, including the link read
   * after its matches, so an outage never reads as no results (FR-018). `null` without a
   * context, so the route answers as today.
   */
  failure(ctx: SearchContext | undefined, error: unknown): SearchHttpResponse | null;
}

export function createShareSearch({
  service,
  metrics,
  logger,
}: {
  service: Pick<SearchService, 'isServing' | 'noteRequest'>;
  metrics: Pick<SearchMetrics, 'request'>;
  logger: { warn(message: string, meta: object): unknown };
}): ShareSearch {
  /* Taken when the request starts, as the messages route does, so both surfaces of one
   * search agree on whether it was cold. */
  const notes = new WeakMap<SearchContext, SearchRequestNotes>();
  const emit = (ctx: SearchContext, outcome: SearchOutcome) =>
    metrics.request({
      surface: 'shares',
      backend: 'search',
      ms: Date.now() - ctx.startedAt,
      ...notes.get(ctx),
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
    completed(ctx, { links }) {
      if (ctx) {
        emit(ctx, links.length ? 'ok' : 'empty');
      }
    },
    failure(ctx, error) {
      if (!ctx) {
        return null;
      }
      if (!isSearchError(error)) {
        logger.warn('[search] Shared link list failed', safeFailure(error));
      }
      const response = searchErrorResponse(error);
      emit(ctx, ctx.signal.aborted ? 'aborted' : response.body.code);
      return response;
    },
  };
}
