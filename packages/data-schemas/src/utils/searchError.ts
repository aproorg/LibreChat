import { SEARCH_ERROR_CODES } from 'librechat-data-provider';
import type { SearchErrorCode } from 'librechat-data-provider';

const SEARCH_ERROR_NAME = 'SearchError';

/**
 * A search failure a route maps to its HTTP contract. It holds only a stable
 * code, so no query text, driver message or stack detail can reach a response.
 */
export class SearchError extends Error {
  readonly code: SearchErrorCode;

  constructor(code: SearchErrorCode) {
    super(code);
    this.name = SEARCH_ERROR_NAME;
    this.code = code;
  }
}

/** Checks name and code too, because bundles can each hold their own copy of the class. */
export function isSearchError(error: unknown): error is SearchError {
  if (error instanceof SearchError) {
    return true;
  }
  if (!(error instanceof Error) || error.name !== SEARCH_ERROR_NAME) {
    return false;
  }
  const { code } = error as { code?: unknown };
  return (SEARCH_ERROR_CODES as readonly unknown[]).includes(code);
}
