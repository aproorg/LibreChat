/** Stable codes a search failure exposes. Clients map them to localized copy. */
export const SEARCH_ERROR_CODES = [
  'search_busy',
  'search_failed',
  'search_cursor_invalid',
] as const;
export type SearchErrorCode = (typeof SEARCH_ERROR_CODES)[number];

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
