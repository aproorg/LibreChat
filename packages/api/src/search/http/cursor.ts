import { SEARCH_CURSOR_HEADER } from 'librechat-data-provider';

export interface SearchCursorRequest {
  get(name: string): string | undefined;
  query: { cursor?: unknown };
}

/**
 * `/api/messages?search=`'s load-more cursor: the header first, since the cursor outgrows a
 * WAF's query-string limit, then the `cursor` query parameter an older client still sends.
 * `null` when neither carries one. The value is user-scoped state: never log it.
 */
export function readSearchCursor(req: SearchCursorRequest): unknown {
  const header = req.get(SEARCH_CURSOR_HEADER);
  if (header) {
    return header;
  }
  return req.query.cursor ?? null;
}
