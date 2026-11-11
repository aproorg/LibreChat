import { isSearchError } from '@librechat/data-schemas';
import type { SearchErrorCode, SearchErrorResponse } from 'librechat-data-provider';

const STATUS_BY_CODE: Readonly<Record<SearchErrorCode, number>> = {
  search_busy: 503,
  search_failed: 500,
  search_cursor_invalid: 400,
};

export interface SearchHttpResponse<Body = unknown> {
  status: number;
  body: Body;
}

/** The HTTP boundary for a failed search. Only the stable code leaves, never error text (FR-020). */
export function searchErrorResponse(error: unknown): SearchHttpResponse<SearchErrorResponse> {
  const code: SearchErrorCode = isSearchError(error) ? error.code : 'search_failed';
  return { status: STATUS_BY_CODE[code], body: { code } };
}
