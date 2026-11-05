import type { TMessage } from '../schemas';

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
  panel?: {
    eligible: boolean;
  };
};

export type SearchPanelState = 'ok' | 'dropped' | 'failed';
export type SearchPanelVerdict = 'better' | 'equal' | 'worse';

/** `GET /api/search/panel/compare`, for the caller's own search. */
export type SearchPanelCompareResponse = {
  meilisearch: {
    messages: TMessage[];
  };
  search: {
    messages: TMessage[];
    state: SearchPanelState;
  };
};

/** `POST /api/search/panel/verdict`. Nothing else is accepted or stored. */
export type SearchPanelVerdictRequest = {
  verdict: SearchPanelVerdict;
  knownMissed: boolean;
};
