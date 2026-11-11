import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import SharedLinks from '../SharedLinks';

type Page = {
  links: Array<{ shareId: string; title: string; createdAt: string; conversationId: string }>;
  nextCursor: string | null;
  hasNextPage: boolean;
  reason?: string;
};

const emptyPage: Page = { links: [], nextCursor: null, hasNextPage: false };

const mockRefetch = jest.fn();
const mockQueryOptions = jest.fn();
const mockQueryResult = {
  data: { pages: [emptyPage] } as { pages: Page[] } | undefined,
  error: null as unknown,
  isError: false,
  fetchNextPage: jest.fn(),
  hasNextPage: false,
  isFetchingNextPage: false,
  refetch: mockRefetch,
  isLoading: false,
  isFetching: false,
  isPreviousData: false,
};
const initialQueryResult = { ...mockQueryResult };

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider/search'),
  useSharedLinksQuery: (_params: unknown, options: unknown) => {
    mockQueryOptions(options);
    return mockQueryResult;
  },
  useDeleteSharedLinkMutation: () => ({ mutateAsync: jest.fn(), isLoading: false }),
}));

/** The table is replaced by its two inputs to this component: the rows and the search field. */
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: jest.fn() }),
  useMediaQuery: () => false,
  VirtualizedDataTable: ({
    data,
    filterValue,
    onFilterChange,
  }: {
    data: Array<{ shareId: string; title: string }>;
    filterValue: string;
    onFilterChange: (value: string) => void;
  }) => (
    <div data-testid="table-stub">
      <input
        aria-label="filter"
        value={filterValue}
        onChange={(event) => onFilterChange(event.target.value)}
      />
      {data.map((row) => (
        <span key={row.shareId}>{row.title}</span>
      ))}
    </div>
  ),
}));

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useRecoilValue: () => ({ enabled: true }),
}));
jest.mock('~/store', () => ({ __esModule: true, default: { search: 'search-atom' } }));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/common', () => ({
  NotificationSeverity: { SUCCESS: 'success', ERROR: 'error', WARNING: 'warning' },
}));
jest.mock('~/utils', () => ({
  formatDate: () => '',
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

/** A failed response as axios reports it: a status and, on the new backend, a body of `{ code }`. */
const httpError = (status: number, code?: string) => ({
  isAxiosError: true,
  response: { status, data: code ? { code } : 'Error' },
});

const NEW_STATE_IDS = [
  'search-busy-state',
  'search-failed-state',
  'search-partial-state',
  'search-stop-word-hint',
  'search-cursor-restart',
];

const expectNoSearchStates = () => {
  for (const id of NEW_STATE_IDS) {
    expect(screen.queryByTestId(id)).not.toBeInTheDocument();
  }
};

const openDialog = () => {
  const view = render(<SharedLinks />);
  fireEvent.click(screen.getByRole('button', { name: 'com_nav_shared_links' }));
  return view;
};

const openSearching = (term = 'harbor') => {
  const view = openDialog();
  fireEvent.change(screen.getByLabelText('filter'), { target: { value: term } });
  return view;
};

describe('SharedLinks search states', () => {
  afterEach(() => {
    Object.assign(mockQueryResult, initialQueryResult);
    jest.clearAllMocks();
  });

  it('announces the stop-word hint', () => {
    mockQueryResult.data = { pages: [{ ...emptyPage, reason: 'only_stop_words' }] };
    openSearching('the');

    const hint = screen.getByTestId('search-stop-word-hint');
    expect(hint).toHaveAttribute('role', 'status');
    expect(hint).toHaveAttribute('aria-live', 'polite');
    expect(hint).toHaveTextContent('com_ui_search_stop_words');
  });

  it('shows the busy state and retries on request', () => {
    mockQueryResult.data = undefined;
    mockQueryResult.isError = true;
    mockQueryResult.error = httpError(503, 'search_busy');
    openSearching();

    const busy = screen.getByTestId('search-busy-state');
    expect(busy).toHaveAttribute('role', 'status');
    expect(busy).toHaveTextContent('com_ui_search_busy');

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('shows the failed state as an alert, so an outage never reads as no results', () => {
    mockQueryResult.data = undefined;
    mockQueryResult.isError = true;
    mockQueryResult.error = httpError(500, 'search_failed');
    openSearching();

    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_search_failed');
  });

  it('does not retry a busy search at the query layer', () => {
    render(<SharedLinks />);
    const { retry } = mockQueryOptions.mock.calls[0][0] as {
      retry: (failureCount: number, error: unknown) => boolean;
    };
    expect(retry(0, httpError(503, 'search_busy'))).toBe(false);
    expect(retry(0, httpError(500))).toBe(true);
    expect(retry(3, httpError(500))).toBe(false);
  });

  it('shows no state while the search is still being fetched', () => {
    mockQueryResult.data = { pages: [{ ...emptyPage, reason: 'only_stop_words' }] };
    mockQueryResult.isFetching = true;
    openSearching();
    expectNoSearchStates();
    expect(screen.getByTestId('table-stub')).toBeInTheDocument();
  });

  describe('on the default backend (FR-041)', () => {
    it('shows none of them for a search, with or without results', () => {
      const { unmount } = openSearching();
      expectNoSearchStates();
      unmount();

      mockQueryResult.data = {
        pages: [
          {
            ...emptyPage,
            links: [{ shareId: 's1', title: 'Match', createdAt: '', conversationId: 'c1' }],
          },
        ],
      };
      openSearching();
      expectNoSearchStates();
      expect(screen.getByText('Match')).toBeInTheDocument();
    });

    it('shows none of them when a search fails without a code', () => {
      mockQueryResult.data = undefined;
      mockQueryResult.isError = true;
      mockQueryResult.error = httpError(500);
      openSearching();
      expectNoSearchStates();
      expect(screen.getByTestId('table-stub')).toBeInTheDocument();
    });

    it('shows none of them outside a search', () => {
      mockQueryResult.data = undefined;
      mockQueryResult.isError = true;
      mockQueryResult.error = httpError(503, 'search_busy');
      openDialog();
      expectNoSearchStates();
      expect(screen.getByTestId('table-stub')).toBeInTheDocument();
    });
  });
});
