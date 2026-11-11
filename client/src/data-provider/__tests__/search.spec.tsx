import { RecoilRoot } from 'recoil';
import { AxiosError, AxiosHeaders } from 'axios';
import { QueryKeys, request } from 'librechat-data-provider';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import type { MessagesListResponse, ConversationListResponse } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  retrySearch,
  cursorSearchText,
  shouldRetrySearch,
  getSearchErrorCode,
  refetchSinglePage,
} from '../search';
import { useConversationsInfiniteQuery, useMessagesInfiniteQuery } from '../queries';
import { useGetSearchMetaQuery } from '../Misc/queries';

/** A failed response shaped like the server's: a status and a body of `{ code }`. */
const httpError = (status: number, data?: unknown): AxiosError => {
  const headers = new AxiosHeaders();
  return new AxiosError('Request failed', 'ERR_BAD_RESPONSE', { headers }, undefined, {
    status,
    data,
    statusText: '',
    headers,
    config: { headers },
  });
};

const messagesPage = (ids: string[], nextCursor: string | null = null): MessagesListResponse => ({
  messages: ids.map((messageId) => ({ messageId, text: messageId })) as never,
  nextCursor,
});

/** What a request to the messages route asked for, read back from its URL. */
const sent = (get: jest.SpyInstance, call: number) => {
  const [url, options] = get.mock.calls[call] as [string, { signal?: AbortSignal } | undefined];
  const params = new URL(url, 'http://localhost').searchParams;
  return { search: params.get('search'), cursor: params.get('cursor'), signal: options?.signal };
};

/** First page, then a last page for any request carrying a cursor. */
const twoPages = async (url: string) =>
  url.includes('cursor=') ? messagesPage(['m2']) : messagesPage(['m1'], 'cursor-1');

let queryClient: QueryClient;

const wrapper = ({ children }: { children: ReactNode }) => (
  <RecoilRoot>
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  </RecoilRoot>
);

beforeEach(() => {
  /** No `retry` default: the hooks under test must behave under React Query's own. */
  queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
});

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  focusManager.setFocused(undefined);
});

describe('search error predicates', () => {
  it('reads a known code from the response body and nothing else', () => {
    expect(getSearchErrorCode(httpError(503, { code: 'search_busy' }))).toBe('search_busy');
    expect(getSearchErrorCode(httpError(500, { code: 'search_failed' }))).toBe('search_failed');
    expect(getSearchErrorCode(httpError(400, { code: 'search_cursor_invalid' }))).toBe(
      'search_cursor_invalid',
    );
    expect(getSearchErrorCode(httpError(500, { code: 'something_else' }))).toBeUndefined();
    expect(getSearchErrorCode(httpError(500, 'Error fetching messages'))).toBeUndefined();
    expect(getSearchErrorCode(httpError(500))).toBeUndefined();
    expect(getSearchErrorCode(new Error('search_busy'))).toBeUndefined();
    expect(getSearchErrorCode({ response: { data: { code: 'search_busy' } } })).toBeUndefined();
  });

  it('does not retry a busy search or a rejected cursor', () => {
    expect(shouldRetrySearch(httpError(503, { code: 'search_busy' }))).toBe(false);
    expect(shouldRetrySearch(httpError(400, { code: 'search_cursor_invalid' }))).toBe(false);
  });

  it('retries every other failure, as before', () => {
    expect(shouldRetrySearch(httpError(500, { code: 'search_failed' }))).toBe(true);
    expect(shouldRetrySearch(httpError(500))).toBe(true);
    expect(shouldRetrySearch(new Error('Network Error'))).toBe(true);
  });

  it('keeps the default of three retries for a failure that may retry', () => {
    const failure = httpError(500);
    expect(retrySearch(0, failure)).toBe(true);
    expect(retrySearch(2, failure)).toBe(true);
    expect(retrySearch(3, failure)).toBe(false);
    expect(retrySearch(0, httpError(503, { code: 'search_busy' }))).toBe(false);
  });
});

describe('cursorSearchText', () => {
  it('normalizes to NFC and keeps the first 256 characters', () => {
    const decomposed = 'é'.repeat(300);
    const sent = cursorSearchText(decomposed);
    expect(sent).toBe('é'.repeat(256));
    expect(cursorSearchText('short')).toBe('short');
    expect(cursorSearchText(undefined)).toBeUndefined();
  });

  it('replaces a surrogate half left by the cut, so the text still encodes into a URL', () => {
    const sent = cursorSearchText(`${'a'.repeat(255)}\u{1F600}tail`);
    expect(sent).toBe(`${'a'.repeat(255)}\uFFFD`);
    expect(() => encodeURIComponent(sent ?? '')).not.toThrow();
    /* A pair that fits whole is left alone. */
    expect(cursorSearchText(`${'a'.repeat(254)}\u{1F600}tail`)).toBe(`${'a'.repeat(254)}\u{1F600}`);
  });
});

describe('useMessagesInfiniteQuery', () => {
  it('passes the query signal to the request, and aborts it when the query is cancelled', async () => {
    let release: (page: MessagesListResponse) => void = () => undefined;
    const get = jest.spyOn(request, 'get').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as (page: MessagesListResponse) => void;
        }),
    );

    renderHook(() => useMessagesInfiniteQuery({ search: 'harbor' }), { wrapper });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    const [url, options] = get.mock.calls[0] as [string, { signal: AbortSignal }];
    expect(url).toContain('/api/messages?search=harbor');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);

    await act(async () => {
      await queryClient.cancelQueries([QueryKeys.messages]);
    });
    expect(options.signal.aborted).toBe(true);
    release(messagesPage([]));
  });

  it('sends the whole query on the first page and a bounded NFC query with a cursor', async () => {
    const long = 'é'.repeat(300);
    const listMessages = jest
      .spyOn(request, 'get')
      .mockResolvedValueOnce(messagesPage(['m1'], 'cursor-1'))
      .mockResolvedValueOnce(messagesPage(['m2']));

    const { result } = renderHook(() => useMessagesInfiniteQuery({ search: long }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(sent(listMessages, 0)).toMatchObject({ search: long, cursor: null });

    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(sent(listMessages, 1)).toMatchObject({ search: 'é'.repeat(256), cursor: 'cursor-1' });
    expect(sent(listMessages, 1).signal).toBeInstanceOf(AbortSignal);
  });

  it('does not retry a busy search at the query layer', async () => {
    const listMessages = jest
      .spyOn(request, 'get')
      .mockRejectedValue(httpError(503, { code: 'search_busy' }));

    const { result } = renderHook(
      () => useMessagesInfiniteQuery({ search: 'harbor' }, { retry: retrySearch }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(listMessages).toHaveBeenCalledTimes(1);
  });

  it('still retries a failure without a code three times', async () => {
    const listMessages = jest.spyOn(request, 'get').mockRejectedValue(httpError(500));

    const { result } = renderHook(
      () => useMessagesInfiniteQuery({ search: 'harbor' }, { retry: retrySearch }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(listMessages).toHaveBeenCalledTimes(4);
  });

  it('keeps the loaded pages when a later page fails, and retries from the same cursor', async () => {
    const listMessages = jest
      .spyOn(request, 'get')
      .mockResolvedValueOnce(messagesPage(['m1'], 'cursor-1'))
      .mockRejectedValueOnce(httpError(503, { code: 'search_busy' }))
      .mockResolvedValueOnce(messagesPage(['m2']));

    const { result } = renderHook(
      () => useMessagesInfiniteQuery({ search: 'harbor' }, { retry: retrySearch }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data?.pages).toHaveLength(1);
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(sent(listMessages, 2)).toMatchObject({ search: 'harbor', cursor: 'cursor-1' });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(result.current.isError).toBe(false);
  });

  it('refetches on focus with one page loaded, and not with more', async () => {
    const listMessages = jest.spyOn(request, 'get').mockImplementation(twoPages);
    const { result } = renderHook(
      () =>
        useMessagesInfiniteQuery(
          { search: 'harbor' },
          { staleTime: 0, refetchOnWindowFocus: refetchSinglePage },
        ),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listMessages).toHaveBeenCalledTimes(1);

    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(listMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    const callsWithTwoPages = listMessages.mock.calls.length;

    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(listMessages).toHaveBeenCalledTimes(callsWithTwoPages);
  });

  it('does not refetch several loaded pages when the view mounts again', async () => {
    const listMessages = jest.spyOn(request, 'get').mockImplementation(twoPages);
    const options = { staleTime: 0, refetchOnMount: refetchSinglePage };
    const first = renderHook(() => useMessagesInfiniteQuery({ search: 'harbor' }, options), {
      wrapper,
    });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(first.result.current.data?.pages).toHaveLength(1);
    await act(async () => {
      await first.result.current.fetchNextPage();
    });
    await waitFor(() => expect(first.result.current.data?.pages).toHaveLength(2));
    const callsWithTwoPages = listMessages.mock.calls.length;
    first.unmount();

    const again = renderHook(() => useMessagesInfiniteQuery({ search: 'harbor' }, options), {
      wrapper,
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(again.result.current.data?.pages).toHaveLength(2);
    expect(listMessages).toHaveBeenCalledTimes(callsWithTwoPages);
  });

  it('restarts from the first page alone when the cached pages are removed first', async () => {
    const listMessages = jest.spyOn(request, 'get').mockImplementation(twoPages);
    const { result } = renderHook(() => useMessagesInfiniteQuery({ search: 'harbor' }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    /** Read before it changes: React Query re-renders only for properties a render has read. */
    expect(result.current.data?.pages).toHaveLength(1);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    listMessages.mockClear();

    await act(async () => {
      result.current.remove();
      await result.current.refetch();
    });
    expect(listMessages).toHaveBeenCalledTimes(1);
    expect(sent(listMessages, 0)).toMatchObject({ search: 'harbor', cursor: null });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
  });
});

describe('useConversationsInfiniteQuery', () => {
  it('passes the query signal to the request, and aborts it when the query is cancelled', async () => {
    let release: (page: ConversationListResponse) => void = () => undefined;
    const get = jest.spyOn(request, 'get').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as (page: ConversationListResponse) => void;
        }),
    );

    renderHook(() => useConversationsInfiniteQuery({ search: 'harbor' }), { wrapper });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    const [url, options] = get.mock.calls[0] as [string, { signal: AbortSignal }];
    expect(url).toContain('search=harbor');
    expect(options.signal).toBeInstanceOf(AbortSignal);

    await act(async () => {
      await queryClient.cancelQueries([QueryKeys.allConversations]);
    });
    expect(options.signal.aborted).toBe(true);
    release({ conversations: [], nextCursor: null });
  });
});

describe('a plain list, with no search', () => {
  /** The base behaviour: a fetch whose view left still finishes and is cached. */
  const held = <T,>() => {
    let release: (page: T) => void = () => undefined;
    const get = jest.spyOn(request, 'get').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as (page: T) => void;
        }),
    );
    return { get, release: (page: T) => release(page) };
  };

  it('conversations: passes no signal, and still caches a page that lands after its view left', async () => {
    const { get, release } = held<ConversationListResponse>();

    const { unmount } = renderHook(() => useConversationsInfiniteQuery({}), { wrapper });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    const [, options] = get.mock.calls[0] as [string, { signal?: AbortSignal } | undefined];
    expect(options?.signal).toBeUndefined();

    unmount();
    await act(async () => {
      release({ conversations: [], nextCursor: null });
    });

    await waitFor(() => {
      const [[, cached]] = queryClient.getQueriesData<{ pages: unknown[] }>([
        QueryKeys.allConversations,
      ]);
      expect(cached?.pages).toHaveLength(1);
    });
  });

  it('messages: passes no signal, and still caches a page that lands after its view left', async () => {
    const { get, release } = held<MessagesListResponse>();

    const { unmount } = renderHook(() => useMessagesInfiniteQuery({ conversationId: 'c1' }), {
      wrapper,
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    const [, options] = get.mock.calls[0] as [string, { signal?: AbortSignal } | undefined];
    expect(options?.signal).toBeUndefined();

    unmount();
    await act(async () => {
      release(messagesPage(['m1']));
    });

    await waitFor(() => {
      const [[, cached]] = queryClient.getQueriesData<{ pages: unknown[] }>([QueryKeys.messages]);
      expect(cached?.pages).toHaveLength(1);
    });
  });
});

describe('useGetSearchMetaQuery', () => {
  it('reads the attribution from /api/search/meta', async () => {
    const attribution = { text: 'Example Lexicon. Example Institute.', url: 'https://example.org' };
    const get = jest.spyOn(request, 'get').mockResolvedValue({ attribution });

    const { result } = renderHook(() => useGetSearchMetaQuery(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(get.mock.calls[0][0]).toMatch(/\/api\/search\/meta$/);
    expect(result.current.data).toEqual({ attribution });
    expect(queryClient.getQueryData([QueryKeys.searchMeta])).toEqual({ attribution });
  });

  it('returns an empty object with the default configuration', async () => {
    jest.spyOn(request, 'get').mockResolvedValue({});
    const { result } = renderHook(() => useGetSearchMetaQuery(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({});
  });
});
