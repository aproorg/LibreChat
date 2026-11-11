import axios from 'axios';
import { SEARCH_ERROR_CODES, SEARCH_CURSOR_QUERY_CHARS } from 'librechat-data-provider';
import type { InfiniteData, Query } from '@tanstack/react-query';
import type { SearchErrorCode } from 'librechat-data-provider';

/** React Query's own default, kept so a search that may retry does so exactly as before. */
const MAX_SEARCH_RETRIES = 3;

const NO_RETRY_CODES: ReadonlySet<SearchErrorCode> = new Set<SearchErrorCode>([
  'search_busy',
  'search_cursor_invalid',
]);

const isSearchErrorCode = (value: unknown): value is SearchErrorCode =>
  typeof value === 'string' && (SEARCH_ERROR_CODES as readonly string[]).includes(value);

/** The stable code a failed search carried. Undefined for any other failure, including every
 *  failure of the default backend, which sends no code. */
export function getSearchErrorCode(error: unknown): SearchErrorCode | undefined {
  if (!axios.isAxiosError(error)) {
    return undefined;
  }
  const body: unknown = error.response?.data;
  const code = body != null && typeof body === 'object' && 'code' in body ? body.code : undefined;
  return isSearchErrorCode(code) ? code : undefined;
}

/** False for the failures a retry cannot help: a busy search only adds load at the cap, and a
 *  rejected cursor is rejected again. */
export function shouldRetrySearch(error: unknown): boolean {
  const code = getSearchErrorCode(error);
  return code == null || !NO_RETRY_CODES.has(code);
}

/** A `retry` option for search queries: the default three retries, minus `shouldRetrySearch`. */
export function retrySearch(failureCount: number, error: unknown): boolean {
  return failureCount < MAX_SEARCH_RETRIES && shouldRetrySearch(error);
}

/** A `refetchOnWindowFocus`, `refetchOnMount` and `refetchOnReconnect` option for paged search:
 *  refetching more than one page re-reads every page under a new anchor and reorders the list,
 *  so only a single page refetches. */
export function refetchSinglePage<TPage>(
  query: Query<TPage, unknown, InfiniteData<TPage>>,
): boolean {
  return (query.state.data?.pages.length ?? 0) <= 1;
}

/** The search text sent with a cursor, bounded so the request line stays within a proxy's limit. */
export function cursorSearchText(search: string | undefined): string | undefined {
  const text = search?.normalize('NFC').slice(0, SEARCH_CURSOR_QUERY_CHARS);
  if (text == null || text.length < SEARCH_CURSOR_QUERY_CHARS) {
    return text;
  }
  /* The cut can split a surrogate pair, and a lone half cannot be encoded into a URL. The
   * server hashes that half as U+FFFD, so sending U+FFFD keeps the cursor valid. */
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? `${text.slice(0, -1)}\uFFFD` : text;
}
