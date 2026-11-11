import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import ArchivedChatsTable from '../ArchivedChatsTable';

type Page = {
  conversations: Array<{ conversationId: string; title: string }>;
  nextCursor: string | null;
  partial?: boolean;
  reason?: string;
};

const mockRefetch = jest.fn();
const mockQueryOptions = jest.fn();
const mockQueryResult = {
  data: { pages: [{ conversations: [], nextCursor: null }] } as { pages: Page[] } | undefined,
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
  useConversationsInfiniteQuery: (_params: unknown, options: unknown) => {
    mockQueryOptions(options);
    return mockQueryResult;
  },
  useDeleteConversationMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useArchiveConvoMutation: () => ({ mutate: jest.fn(), isLoading: false }),
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
    data: Array<{ conversationId: string; title: string }>;
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
        <span key={row.conversationId}>{row.title}</span>
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
jest.mock('~/components/Endpoints', () => ({ MinimalIcon: () => null }));
jest.mock('~/common', () => ({ NotificationSeverity: { SUCCESS: 'success', ERROR: 'error' } }));
jest.mock('~/utils', () => ({
  formatDate: () => '',
  logger: { error: jest.fn() },
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

const renderSearching = (term = 'harbor') => {
  const view = render(<ArchivedChatsTable />);
  fireEvent.change(screen.getByLabelText('filter'), { target: { value: term } });
  return view;
};

describe('ArchivedChatsTable search states', () => {
  afterEach(() => {
    Object.assign(mockQueryResult, initialQueryResult);
    jest.clearAllMocks();
  });

  it('announces a partial search and still lists the title matches', () => {
    mockQueryResult.data = {
      pages: [
        {
          conversations: [{ conversationId: 'chat-1', title: 'Title match' }],
          nextCursor: null,
          partial: true,
        },
      ],
    };
    renderSearching();

    const partial = screen.getByTestId('search-partial-state');
    expect(partial).toHaveAttribute('role', 'status');
    expect(partial).toHaveAttribute('aria-live', 'polite');
    expect(partial).toHaveTextContent('com_ui_search_partial');
    expect(screen.getByText('Title match')).toBeInTheDocument();
  });

  it('announces the stop-word hint', () => {
    mockQueryResult.data = {
      pages: [{ conversations: [], nextCursor: null, reason: 'only_stop_words' }],
    };
    renderSearching('the');

    const hint = screen.getByTestId('search-stop-word-hint');
    expect(hint).toHaveAttribute('role', 'status');
    expect(hint).toHaveTextContent('com_ui_search_stop_words');
  });

  it('shows the busy state and retries on request', () => {
    mockQueryResult.data = undefined;
    mockQueryResult.isError = true;
    mockQueryResult.error = httpError(503, 'search_busy');
    renderSearching();

    const busy = screen.getByTestId('search-busy-state');
    expect(busy).toHaveAttribute('role', 'status');
    expect(busy).toHaveTextContent('com_ui_search_busy');

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('shows the failed state as an alert', () => {
    mockQueryResult.data = undefined;
    mockQueryResult.isError = true;
    mockQueryResult.error = httpError(500, 'search_failed');
    renderSearching();

    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_search_failed');
  });

  it('does not retry a busy search at the query layer', () => {
    render(<ArchivedChatsTable />);
    const { retry } = mockQueryOptions.mock.calls[0][0] as {
      retry: (failureCount: number, error: unknown) => boolean;
    };
    expect(retry(0, httpError(503, 'search_busy'))).toBe(false);
    expect(retry(0, httpError(500))).toBe(true);
    expect(retry(3, httpError(500))).toBe(false);
  });

  it('shows no state while the search is still being fetched', () => {
    mockQueryResult.data = {
      pages: [{ conversations: [], nextCursor: null, partial: true, reason: 'only_stop_words' }],
    };
    mockQueryResult.isFetching = true;
    renderSearching();
    expectNoSearchStates();
    expect(screen.getByTestId('table-stub')).toBeInTheDocument();
  });

  describe('on the default backend (FR-041)', () => {
    it('shows none of them for a search, with or without results', () => {
      const { unmount } = renderSearching();
      expectNoSearchStates();
      unmount();

      mockQueryResult.data = {
        pages: [
          { conversations: [{ conversationId: 'chat-1', title: 'Match' }], nextCursor: null },
        ],
      };
      renderSearching();
      expectNoSearchStates();
      expect(screen.getByText('Match')).toBeInTheDocument();
    });

    it('shows none of them when a search fails without a code', () => {
      mockQueryResult.data = undefined;
      mockQueryResult.isError = true;
      mockQueryResult.error = httpError(500);
      renderSearching();
      expectNoSearchStates();
      expect(screen.getByTestId('table-stub')).toBeInTheDocument();
    });

    it('shows none of them outside a search', () => {
      mockQueryResult.data = undefined;
      mockQueryResult.isError = true;
      mockQueryResult.error = httpError(503, 'search_busy');
      render(<ArchivedChatsTable />);
      expectNoSearchStates();
      expect(screen.getByTestId('table-stub')).toBeInTheDocument();
    });
  });
});
