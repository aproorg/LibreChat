import React from 'react';
import { useRecoilValue } from 'recoil';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { useMessagesInfiniteQuery } from '~/data-provider';
import Search from '../Search';

/* react-virtualized measures nothing in jsdom; render every row flatly so the
   list contents are exercised. */
jest.mock('react-virtualized', () => ({
  __esModule: true,
  CellMeasurerCache: class {
    getHeight() {
      return 100;
    }

    clearAll() {}
  },
  CellMeasurer: ({
    children,
  }: {
    children: (a: { registerChild: () => void }) => React.ReactNode;
  }) => children({ registerChild: () => {} }),
  List: ({
    rowCount,
    rowRenderer,
    onRowsRendered,
    className,
  }: {
    rowCount: number;
    rowRenderer: (p: {
      index: number;
      key: string;
      parent: unknown;
      style: object;
    }) => React.ReactNode;
    onRowsRendered?: (p: { startIndex: number; stopIndex: number }) => void;
    className?: string;
  }) => {
    // expose the near-bottom trigger for the pagination test
    (globalThis as Record<string, unknown>).__triggerRowsRendered = () =>
      onRowsRendered?.({ startIndex: 0, stopIndex: rowCount - 1 });
    return (
      <div data-testid="virtual-list" className={className}>
        {Array.from({ length: rowCount }, (_, i) =>
          rowRenderer({ index: i, key: String(i), parent: {}, style: {} }),
        )}
      </div>
    );
  },
}));

jest.mock('recoil', () => ({ useRecoilValue: jest.fn() }));
jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider/search'),
  useMessagesInfiniteQuery: jest.fn(),
}));
jest.mock('~/Providers', () => ({ useFileMapContext: () => ({}) }));
const mockShowToast = jest.fn();
jest.mock('@librechat/client', () => ({
  Spinner: () => <div data-testid="spinner" />,
  useToastContext: () => ({ showToast: mockShowToast }),
  Alert: ({
    children,
    variant: _variant,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { variant?: string }) => (
    <div {...props}>{children}</div>
  ),
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ isAuthenticated: true }),
  useElementSize: () => ({ ref: () => {}, width: 800, height: 600 }),
}));
jest.mock('~/store', () => ({ __esModule: true, default: { search: 'search-atom' } }));
jest.mock('~/components/Chat/Messages/SearchMessage', () => ({
  __esModule: true,
  default: ({ message }: { message: { text: string } }) => (
    <div className="search-row">{message.text}</div>
  ),
}));
jest.mock('~/utils', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }));
jest.mock('jotai', () => ({ useAtomValue: () => 'text-base' }));
jest.mock('~/store/fontSize', () => ({ fontSizeAtom: {} }));

const mockUseRecoilValue = useRecoilValue as jest.Mock;
const mockUseQuery = useMessagesInfiniteQuery as jest.Mock;

const searchState = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  query: 'zephyrine',
  debouncedQuery: 'zephyrine',
  isSearching: false,
  isTyping: false,
  ...over,
});

const queryResult = (over: Record<string, unknown> = {}) => ({
  data: { pages: [{ messages: [{ messageId: 'm1', text: 'row one' }], nextCursor: null }] },
  error: null,
  isLoading: false,
  isError: false,
  refetch: jest.fn(),
  remove: jest.fn(),
  fetchNextPage: jest.fn(),
  isFetchingNextPage: false,
  hasNextPage: false,
  isPreviousData: false,
  ...over,
});

describe('Search route', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders result rows when data is present', () => {
    mockUseRecoilValue.mockReturnValue(searchState());
    mockUseQuery.mockReturnValue(queryResult());
    const { container } = render(<Search />);
    expect(screen.getByText('row one')).toBeInTheDocument();
    expect(screen.queryByTestId('spinner')).not.toBeInTheDocument();
    expect(screen.getByTestId('virtual-list')).toHaveClass(
      'focus-visible:ring-2',
      'focus-visible:ring-ring-primary',
    );
    expect(container.firstElementChild).toHaveClass('bg-presentation');
    expect(container.querySelector('.bg-gradient-to-t')).toHaveClass('from-presentation');
  });

  it('keeps results mounted while typing (does NOT flash the full spinner)', () => {
    mockUseRecoilValue.mockReturnValue(searchState({ isTyping: true }));
    mockUseQuery.mockReturnValue(queryResult());
    render(<Search />);
    // The whole list must stay — this is the core regression fix.
    expect(screen.getByText('row one')).toBeInTheDocument();
  });

  it('shows the full spinner only on initial load with no results', () => {
    mockUseRecoilValue.mockReturnValue(searchState());
    mockUseQuery.mockReturnValue(queryResult({ isLoading: true, data: undefined }));
    render(<Search />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    expect(screen.queryByText('row one')).not.toBeInTheDocument();
  });

  it('shows nothing-found when the query returned no results', () => {
    mockUseRecoilValue.mockReturnValue(searchState());
    mockUseQuery.mockReturnValue(
      queryResult({ data: { pages: [{ messages: [], nextCursor: null }] } }),
    );
    render(<Search />);
    expect(screen.getAllByText('com_ui_nothing_found').length).toBeGreaterThan(0);
  });

  it('shows the spinner (not a false nothing-found) when stale empty data is held during a refetch', () => {
    mockUseRecoilValue.mockReturnValue(searchState());
    mockUseQuery.mockReturnValue(
      queryResult({
        data: { pages: [{ messages: [], nextCursor: null }] },
        isPreviousData: true,
      }),
    );
    render(<Search />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_nothing_found')).not.toBeInTheDocument();
  });

  it('renders nothing when there is no query and the user is idle', () => {
    mockUseRecoilValue.mockReturnValue(searchState({ debouncedQuery: '' }));
    mockUseQuery.mockReturnValue(queryResult({ data: undefined }));
    const { container } = render(<Search />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the spinner during the initial debounce (query typed, not yet debounced)', () => {
    mockUseRecoilValue.mockReturnValue(
      searchState({ query: 'zephyrine', debouncedQuery: '', isTyping: true }),
    );
    mockUseQuery.mockReturnValue(queryResult({ data: undefined }));
    render(<Search />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('announces empty results through a live region', () => {
    mockUseRecoilValue.mockReturnValue(searchState());
    mockUseQuery.mockReturnValue(
      queryResult({ data: { pages: [{ messages: [], nextCursor: null }] } }),
    );
    render(<Search />);
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_nothing_found');
  });

  it('fetches the next page when scrolled near the bottom', () => {
    const fetchNextPage = jest.fn();
    mockUseRecoilValue.mockReturnValue(searchState());
    mockUseQuery.mockReturnValue(queryResult({ hasNextPage: true, fetchNextPage }));
    render(<Search />);
    (globalThis as unknown as Record<string, () => void>).__triggerRowsRendered();
    expect(fetchNextPage).toHaveBeenCalled();
  });

  it('does NOT paginate the outgoing query while the user is still typing', () => {
    const fetchNextPage = jest.fn();
    mockUseRecoilValue.mockReturnValue(searchState({ isTyping: true }));
    mockUseQuery.mockReturnValue(queryResult({ hasNextPage: true, fetchNextPage }));
    render(<Search />);
    (globalThis as unknown as Record<string, () => void>).__triggerRowsRendered();
    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it('does NOT paginate while previous-query results are still mounted (refetch in flight)', () => {
    const fetchNextPage = jest.fn();
    mockUseRecoilValue.mockReturnValue(searchState());
    mockUseQuery.mockReturnValue(
      queryResult({ hasNextPage: true, isPreviousData: true, fetchNextPage }),
    );
    render(<Search />);
    (globalThis as unknown as Record<string, () => void>).__triggerRowsRendered();
    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it('renders a trailing spacer row so the last result clears the bottom overlay', () => {
    mockUseRecoilValue.mockReturnValue(searchState());
    mockUseQuery.mockReturnValue(queryResult());
    render(<Search />);
    expect(screen.getByText('row one')).toBeInTheDocument();
    expect(screen.getByTestId('search-footer')).toBeInTheDocument();
  });
});

/** A failed response as axios reports it: a status and, on the new backend, a body of `{ code }`. */
const httpError = (status: number, code?: string) => ({
  isAxiosError: true,
  response: { status, data: code ? { code } : 'Error fetching messages' },
});

const rows = (count: number, prefix = 'm') =>
  Array.from({ length: count }, (_, i) => ({
    messageId: `${prefix}${i}`,
    text: `${prefix} row ${i}`,
  }));

/** Every state the new backend adds, by the test id its component carries. */
const NEW_STATE_IDS = [
  'search-busy-state',
  'search-failed-state',
  'search-stop-word-hint',
  'search-cursor-restart',
  'search-load-more',
  'search-load-more-error',
];

const expectNoNewStates = () => {
  for (const id of NEW_STATE_IDS) {
    expect(screen.queryByTestId(id)).not.toBeInTheDocument();
  }
};

type QueryOptions = {
  retry: (failureCount: number, error: unknown) => boolean;
  refetchOnWindowFocus: (query: { state: { data?: { pages: unknown[] } } }) => boolean;
};

const passedOptions = (): QueryOptions => mockUseQuery.mock.calls[0][1] as QueryOptions;

describe('Search route on the new search backend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseRecoilValue.mockReturnValue(searchState());
  });

  describe('failures', () => {
    it('shows the busy state, announced politely, in place of the toast', async () => {
      const refetch = jest.fn();
      mockUseQuery.mockReturnValue(
        queryResult({
          data: undefined,
          isError: true,
          error: httpError(503, 'search_busy'),
          refetch,
        }),
      );
      render(<Search />);

      const busy = screen.getByRole('status');
      expect(busy).toHaveAttribute('aria-live', 'polite');
      expect(busy).toHaveTextContent('com_ui_search_busy');
      expect(screen.queryByText('com_ui_nothing_found')).not.toBeInTheDocument();
      expect(mockShowToast).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
      expect(refetch).toHaveBeenCalledTimes(1);
    });

    it('shows the failed state as an alert, never as nothing found', () => {
      mockUseQuery.mockReturnValue(
        queryResult({ data: undefined, isError: true, error: httpError(500, 'search_failed') }),
      );
      render(<Search />);

      expect(screen.getByRole('alert')).toHaveTextContent('com_ui_search_failed');
      expect(screen.queryByText('com_ui_nothing_found')).not.toBeInTheDocument();
      expect(mockShowToast).not.toHaveBeenCalled();
    });

    it('keeps the results when a later page fails, and retries it from the same place', async () => {
      const fetchNextPage = jest.fn();
      const refetch = jest.fn();
      mockUseQuery.mockReturnValue(
        queryResult({
          data: { pages: [{ messages: rows(25), nextCursor: 'cursor-1' }] },
          isError: true,
          error: httpError(503, 'search_busy'),
          hasNextPage: true,
          fetchNextPage,
          refetch,
        }),
      );
      render(<Search />);

      expect(screen.getByText('m row 0')).toBeInTheDocument();
      expect(screen.getByText('m row 24')).toBeInTheDocument();
      expect(screen.getByTestId('search-load-more-error')).toHaveTextContent('com_ui_search_busy');
      expect(screen.getByTestId('search-load-more-error')).toHaveAttribute('role', 'status');
      expect(mockShowToast).not.toHaveBeenCalled();

      /** Scrolling must not hammer a failing page: only the button retries it. */
      (globalThis as unknown as Record<string, () => void>).__triggerRowsRendered();
      expect(fetchNextPage).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
      expect(fetchNextPage).toHaveBeenCalledTimes(1);
      expect(refetch).not.toHaveBeenCalled();
    });

    it('describes a later page that failed without a busy code as an alert', () => {
      mockUseQuery.mockReturnValue(
        queryResult({
          data: { pages: [{ messages: rows(25), nextCursor: 'cursor-1' }] },
          isError: true,
          error: httpError(500, 'search_failed'),
          hasNextPage: true,
        }),
      );
      render(<Search />);

      expect(screen.getByText('m row 0')).toBeInTheDocument();
      const failure = screen.getByTestId('search-load-more-error');
      expect(failure).toHaveAttribute('role', 'alert');
      expect(failure).toHaveTextContent('com_ui_search_load_more_failed');
    });
  });

  describe('restart', () => {
    it.each([
      ['a rejected cursor', httpError(400, 'search_cursor_invalid')],
      ['a 414 from a proxy', httpError(414)],
    ])('offers a restart on %s and starts over from the first page', async (_name, error) => {
      const refetch = jest.fn();
      const remove = jest.fn();
      const fetchNextPage = jest.fn();
      mockUseQuery.mockReturnValue(
        queryResult({
          data: { pages: [{ messages: rows(25), nextCursor: 'cursor-1' }] },
          isError: true,
          error,
          hasNextPage: true,
          refetch,
          remove,
          fetchNextPage,
        }),
      );
      render(<Search />);

      expect(screen.getByText('m row 0')).toBeInTheDocument();
      expect(screen.getByTestId('search-cursor-restart')).toHaveTextContent(
        'com_ui_search_cursor_restart',
      );
      expect(screen.getByTestId('search-cursor-restart')).toHaveAttribute('role', 'status');
      expect(screen.queryByTestId('search-load-more')).not.toBeInTheDocument();
      expect(mockShowToast).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole('button', { name: 'com_ui_search_restart' }));
      expect(remove).toHaveBeenCalledTimes(1);
      expect(refetch).toHaveBeenCalledTimes(1);
      expect(remove.mock.invocationCallOrder[0]).toBeLessThan(refetch.mock.invocationCallOrder[0]);
      expect(fetchNextPage).not.toHaveBeenCalled();
    });
  });

  describe('stop words', () => {
    it('shows the hint, announced politely, instead of nothing found', () => {
      mockUseQuery.mockReturnValue(
        queryResult({
          data: { pages: [{ messages: [], nextCursor: null, reason: 'only_stop_words' }] },
        }),
      );
      render(<Search />);

      const hint = screen.getByRole('status');
      expect(hint).toHaveAttribute('aria-live', 'polite');
      expect(hint).toHaveTextContent('com_ui_search_stop_words');
      expect(screen.queryByText('com_ui_nothing_found')).not.toBeInTheDocument();
    });
  });

  describe('load more', () => {
    it('shows the button under a full page and pages by keyboard', async () => {
      const fetchNextPage = jest.fn();
      mockUseQuery.mockReturnValue(
        queryResult({
          data: { pages: [{ messages: rows(25), nextCursor: 'cursor-1' }] },
          hasNextPage: true,
          fetchNextPage,
        }),
      );
      render(<Search />);

      /** A full page is left to scrolling, so nothing is fetched until asked. */
      expect(fetchNextPage).not.toHaveBeenCalled();
      const button = screen.getByRole('button', { name: 'com_ui_load_more' });

      const user = userEvent.setup();
      await user.tab();
      expect(button).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(fetchNextPage).toHaveBeenCalledTimes(1);
      await user.keyboard(' ');
      expect(fetchNextPage).toHaveBeenCalledTimes(2);
    });

    it('keeps the button mounted and busy while its page loads, so focus stays on it', async () => {
      const fetchNextPage = jest.fn();
      const page = { pages: [{ messages: rows(25), nextCursor: 'cursor-1' }] };
      mockUseQuery.mockReturnValue(queryResult({ data: page, hasNextPage: true, fetchNextPage }));
      const { rerender } = render(<Search />);
      const user = userEvent.setup();
      await user.tab();
      const button = screen.getByTestId('search-load-more');
      expect(button).toHaveFocus();

      mockUseQuery.mockReturnValue(
        queryResult({ data: page, hasNextPage: true, isFetchingNextPage: true, fetchNextPage }),
      );
      rerender(<Search />);

      expect(screen.getByTestId('search-load-more')).toBe(button);
      expect(button).toHaveFocus();
      expect(button).toHaveAttribute('aria-busy', 'true');
      await user.keyboard('{Enter}');
      expect(fetchNextPage).not.toHaveBeenCalled();
    });

    it('fetches after a short page three times, then shows the button', async () => {
      const fetchNextPage = jest.fn();
      const shortPages = (count: number) =>
        queryResult({
          data: {
            pages: Array.from({ length: count }, (_, i) => ({
              messages: rows(2, `p${i}-`),
              nextCursor: `cursor-${i + 1}`,
            })),
          },
          hasNextPage: true,
          fetchNextPage,
        });

      mockUseQuery.mockReturnValue(shortPages(1));
      const { rerender } = render(<Search />);
      expect(fetchNextPage).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('search-load-more')).not.toBeInTheDocument();

      /** The same page count must never fetch twice, however often the route re-renders. */
      rerender(<Search />);
      expect(fetchNextPage).toHaveBeenCalledTimes(1);

      mockUseQuery.mockReturnValue(shortPages(2));
      rerender(<Search />);
      expect(fetchNextPage).toHaveBeenCalledTimes(2);

      mockUseQuery.mockReturnValue(shortPages(3));
      rerender(<Search />);
      expect(fetchNextPage).toHaveBeenCalledTimes(3);
      expect(screen.queryByTestId('search-load-more')).not.toBeInTheDocument();

      mockUseQuery.mockReturnValue(shortPages(4));
      rerender(<Search />);
      expect(fetchNextPage).toHaveBeenCalledTimes(3);
      expect(screen.getByText('p3- row 1')).toBeInTheDocument();

      /** The user's own request fetches once and earns a new automatic run. */
      await userEvent.click(screen.getByRole('button', { name: 'com_ui_load_more' }));
      expect(fetchNextPage).toHaveBeenCalledTimes(4);
      mockUseQuery.mockReturnValue(shortPages(5));
      rerender(<Search />);
      expect(fetchNextPage).toHaveBeenCalledTimes(5);
    });

    it('keeps the button, and focus, through the fetches that follow a press on a short page', async () => {
      const fetchNextPage = jest.fn();
      const shortPages = (count: number, isFetchingNextPage = false) =>
        queryResult({
          data: {
            pages: Array.from({ length: count }, (_, i) => ({
              messages: rows(2, `p${i}-`),
              nextCursor: `cursor-${i + 1}`,
            })),
          },
          hasNextPage: true,
          isFetchingNextPage,
          fetchNextPage,
        });
      mockUseQuery.mockReturnValue(shortPages(1));
      const { rerender } = render(<Search />);
      for (const count of [2, 3, 4]) {
        mockUseQuery.mockReturnValue(shortPages(count));
        rerender(<Search />);
      }
      expect(fetchNextPage).toHaveBeenCalledTimes(3);

      const user = userEvent.setup();
      await user.tab();
      const button = screen.getByTestId('search-load-more');
      expect(button).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(fetchNextPage).toHaveBeenCalledTimes(4);

      /** While the page the user asked for loads. */
      mockUseQuery.mockReturnValue(shortPages(4, true));
      rerender(<Search />);
      expect(screen.getByTestId('search-load-more')).toBe(button);
      expect(button).toHaveFocus();
      expect(button).toHaveAttribute('aria-busy', 'true');

      /** It lands short as well, so an automatic fetch follows, and the button is still there. */
      mockUseQuery.mockReturnValue(shortPages(5));
      rerender(<Search />);
      expect(fetchNextPage).toHaveBeenCalledTimes(5);
      expect(screen.getByTestId('search-load-more')).toBe(button);
      expect(button).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(fetchNextPage).toHaveBeenCalledTimes(5);
    });

    it('does not call a run of empty pages nothing found', () => {
      const fetchNextPage = jest.fn();
      const emptyPages = (count: number) =>
        queryResult({
          data: {
            pages: Array.from({ length: count }, (_, i) => ({
              messages: [],
              nextCursor: `cursor-${i + 1}`,
            })),
          },
          hasNextPage: true,
          fetchNextPage,
        });

      mockUseQuery.mockReturnValue(emptyPages(1));
      const { rerender } = render(<Search />);
      expect(screen.getByTestId('spinner')).toBeInTheDocument();
      expect(screen.queryByText('com_ui_nothing_found')).not.toBeInTheDocument();

      for (const count of [2, 3, 4]) {
        mockUseQuery.mockReturnValue(emptyPages(count));
        rerender(<Search />);
      }
      expect(fetchNextPage).toHaveBeenCalledTimes(3);
      expect(screen.queryByText('com_ui_nothing_found')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('com_ui_search_more_available');
      expect(screen.getByRole('button', { name: 'com_ui_load_more' })).toBeInTheDocument();
    });

    it('does not fetch after a short page while the previous search is still shown', () => {
      const fetchNextPage = jest.fn();
      mockUseQuery.mockReturnValue(
        queryResult({
          data: { pages: [{ messages: rows(2), nextCursor: 'cursor-1' }] },
          hasNextPage: true,
          isPreviousData: true,
          fetchNextPage,
        }),
      );
      render(<Search />);
      expect(fetchNextPage).not.toHaveBeenCalled();
    });
  });

  it('shows a repeated messageId once', () => {
    mockUseQuery.mockReturnValue(
      queryResult({
        data: {
          pages: [
            {
              messages: [
                { messageId: 'm1', text: 'first copy' },
                { messageId: 'm2', text: 'other row' },
              ],
              nextCursor: 'cursor-1',
            },
            { messages: [{ messageId: 'm1', text: 'second copy' }], nextCursor: null },
          ],
        },
      }),
    );
    render(<Search />);

    expect(screen.getByText('first copy')).toBeInTheDocument();
    expect(screen.getByText('other row')).toBeInTheDocument();
    expect(screen.queryByText('second copy')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('search-result-row')).toHaveLength(2);
  });

  it('turns off query-layer retries for a busy search and a rejected cursor only', () => {
    mockUseQuery.mockReturnValue(queryResult());
    render(<Search />);
    const { retry } = passedOptions();

    expect(retry(0, httpError(503, 'search_busy'))).toBe(false);
    expect(retry(0, httpError(400, 'search_cursor_invalid'))).toBe(false);
    expect(retry(0, httpError(500, 'search_failed'))).toBe(true);
    expect(retry(2, httpError(500))).toBe(true);
    expect(retry(3, httpError(500))).toBe(false);
  });

  it('refetches on focus with one page loaded and not with more', () => {
    mockUseQuery.mockReturnValue(queryResult());
    render(<Search />);
    const { refetchOnWindowFocus } = passedOptions();

    expect(refetchOnWindowFocus({ state: {} })).toBe(true);
    expect(refetchOnWindowFocus({ state: { data: { pages: [{}] } } })).toBe(true);
    expect(refetchOnWindowFocus({ state: { data: { pages: [{}, {}] } } })).toBe(false);
  });
});

describe('Search route on the default backend (FR-041)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseRecoilValue.mockReturnValue(searchState());
  });

  it("keeps today's toast and shows no new state when a search fails", () => {
    mockUseQuery.mockReturnValue(
      queryResult({ data: undefined, isError: true, error: httpError(500) }),
    );
    render(<Search />);

    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'An error occurred during search',
      status: 'error',
    });
    expect(screen.getAllByText('com_ui_nothing_found').length).toBeGreaterThan(0);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expectNoNewStates();
  });

  it('treats a 414 on a first page as any other failure, with no restart', () => {
    mockUseQuery.mockReturnValue(
      queryResult({ data: undefined, isError: true, error: httpError(414) }),
    );
    render(<Search />);

    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expectNoNewStates();
  });

  it('keeps the toast when a refetch fails over results, and adds nothing', () => {
    mockUseQuery.mockReturnValue(queryResult({ isError: true, error: httpError(500) }));
    render(<Search />);

    expect(screen.getByText('row one')).toBeInTheDocument();
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expectNoNewStates();
  });

  it('shows results and an empty result exactly as before, with no new state', () => {
    const fetchNextPage = jest.fn();
    mockUseQuery.mockReturnValue(queryResult({ fetchNextPage }));
    const { unmount } = render(<Search />);
    expect(screen.getByText('row one')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expectNoNewStates();
    unmount();

    mockUseQuery.mockReturnValue(
      queryResult({ data: { pages: [{ messages: [], nextCursor: null }] }, fetchNextPage }),
    );
    render(<Search />);
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_nothing_found');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expectNoNewStates();
    expect(fetchNextPage).not.toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalled();
  });
});
