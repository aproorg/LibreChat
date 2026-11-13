/** Stable codes a search failure exposes. Clients map them to localized copy. */
export const SEARCH_ERROR_CODES = [
  'search_busy',
  'search_failed',
  'search_cursor_invalid',
] as const;
export type SearchErrorCode = (typeof SEARCH_ERROR_CODES)[number];

/** `/search`'s page size. The client reads a shorter page as one thinned by filtering. */
export const SEARCH_PAGE_SIZE = 25;

/**
 * With a cursor, the client sends this much of the query, and both sides bind the cursor to
 * the same text.
 */
export const SEARCH_CURSOR_QUERY_CHARS = 256;

/**
 * Carries `/api/messages?search=`'s load-more cursor. The cursor is a fixed ~2.9 KB, past the
 * query-string size limit common WAF rules enforce, so it travels in this header instead of the
 * URL. The server still accepts a `cursor` query parameter from older clients.
 */
export const SEARCH_CURSOR_HEADER = 'X-Search-Cursor';

/** Why a successful search came back empty, when that needs its own message. */
export const SEARCH_REASONS = ['only_stop_words'] as const;
export type SearchReason = (typeof SEARCH_REASONS)[number];

/** Body of a failed search response. Carries no message text. */
export type SearchErrorResponse = {
  code: SearchErrorCode;
};

/** `GET /api/search/meta`. Empty with the default configuration. */
export type SearchMeta = {
  attribution?: {
    text: string;
    url: string;
  };
};
