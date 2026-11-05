import { SearchError } from '@librechat/data-schemas';
import type { SearchableMessage, SearchContext } from '@librechat/data-schemas';
import type { MessageSearchHits, SearchService, SearchServiceMethods } from '../service';
import type { SearchMetrics, SearchRequestEvent } from '../metrics';
import type { SearchHttpResponse } from './errors';
import { searchErrorResponse } from './errors';

/** `getSearchableMessages` and `getSearchHitConversations`, counted in `search.request`. */
const HYDRATION_READS = 2;

export interface SearchMessagesRouteDeps {
  service: SearchService;
  methods: Pick<SearchServiceMethods, 'getSearchableMessages' | 'getSearchHitConversations'>;
  metrics: Pick<SearchMetrics, 'request'>;
}

export type SearchMessagesRoute = (
  ctx: SearchContext,
  query: unknown,
  cursor: unknown,
) => Promise<SearchHttpResponse | null>;

/**
 * `/search`'s answer on the new backend, or `null` where Meilisearch serves. Hits come
 * from search records, so each passes the live message and conversation checks here:
 * a stale record cannot reach the client (FR-014).
 */
export function createSearchMessagesRoute(deps: SearchMessagesRouteDeps): SearchMessagesRoute {
  const { service, methods, metrics } = deps;

  async function hydrate(ctx: SearchContext, hits: MessageSearchHits['hits']) {
    const run = service.requestRunner(ctx, 'messages');
    const conversationIds = [...new Set(hits.map(({ conversationId }) => conversationId))];
    const [messages, conversations] = await Promise.all([
      run((read) =>
        methods.getSearchableMessages(
          ctx.user,
          hits.map(({ messageId }) => messageId),
          read,
        ),
      ),
      run((read) => methods.getSearchHitConversations(ctx.user, conversationIds, read)),
    ]);
    const messageById = new Map<string, SearchableMessage>(
      messages.map((message) => [message.messageId, message]),
    );
    const conversationById = new Map(
      conversations.map((conversation) => [conversation.conversationId, conversation]),
    );
    return hits.flatMap(({ messageId, conversationId }) => {
      const message = messageById.get(messageId);
      const conversation = conversationById.get(conversationId);
      if (!message || !conversation || message.conversationId !== conversationId) {
        return [];
      }
      return [{ ...message, title: conversation.title, model: conversation.model }];
    });
  }

  return async function searchMessagesRoute(ctx, query, cursor) {
    if (!service.isServing()) {
      return null;
    }
    const notes = service.noteRequest(ctx.user);
    const emit = (
      outcome: SearchRequestEvent['outcome'],
      stats: Pick<SearchRequestEvent, 'reads' | 'rows' | 'words' | 'tierReached'> = {},
    ) =>
      metrics.request({
        surface: 'messages',
        backend: 'search',
        detached: false,
        ms: Date.now() - ctx.startedAt,
        ...notes,
        ...stats,
        outcome,
      });

    try {
      /* No page 1 hands out a cursor until load-more exists, so none sent can be valid. */
      if (cursor) {
        throw new SearchError('search_cursor_invalid');
      }
      if (typeof query !== 'string') {
        emit('empty');
        return { status: 200, body: { messages: [], nextCursor: null } };
      }
      const result = await service.searchMessages(ctx, query);
      if (!result) {
        return null;
      }
      const { hits, reason, words, tierReached, reads, rows } = result;
      const messages = hits.length ? await hydrate(ctx, hits) : [];
      emit(messages.length ? 'ok' : 'empty', {
        words,
        tierReached,
        rows,
        reads: reads + (hits.length ? HYDRATION_READS : 0),
      });
      return {
        status: 200,
        body: { messages, nextCursor: null, ...(reason ? { reason } : {}) },
      };
    } catch (error) {
      const response = searchErrorResponse(error);
      emit(ctx.signal.aborted ? 'aborted' : response.body.code);
      return response;
    }
  };
}
