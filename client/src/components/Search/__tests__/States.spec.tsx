import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import {
  SearchLoadMore,
  SearchBusyState,
  SearchErrorState,
  SearchFailedState,
  SearchPartialState,
  SearchStopWordHint,
  SearchCursorRestart,
} from '..';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('search states', () => {
  it('announces the busy state politely and retries on request', async () => {
    const onRetry = jest.fn();
    render(<SearchBusyState onRetry={onRetry} />);

    const state = screen.getByRole('status');
    expect(state).toHaveAttribute('aria-live', 'polite');
    expect(state).toHaveTextContent('com_ui_search_busy');

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders the busy state without a button when there is nothing to retry', () => {
    render(<SearchBusyState />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('announces the failed state as an alert and retries on request', async () => {
    const onRetry = jest.fn();
    render(<SearchFailedState onRetry={onRetry} />);

    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_search_failed');
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('announces the partial state politely', () => {
    render(<SearchPartialState />);
    const state = screen.getByRole('status');
    expect(state).toHaveAttribute('aria-live', 'polite');
    expect(state).toHaveTextContent('com_ui_search_partial');
  });

  it('announces the stop-word hint politely', () => {
    render(<SearchStopWordHint />);
    const state = screen.getByRole('status');
    expect(state).toHaveAttribute('aria-live', 'polite');
    expect(state).toHaveTextContent('com_ui_search_stop_words');
  });

  it('offers a restart that works by keyboard', async () => {
    const onRestart = jest.fn();
    render(<SearchCursorRestart onRestart={onRestart} />);
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_search_cursor_restart');

    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole('button', { name: 'com_ui_search_restart' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});

describe('SearchLoadMore', () => {
  it('loads more by keyboard', async () => {
    const onLoadMore = jest.fn();
    render(<SearchLoadMore onLoadMore={onLoadMore} />);

    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole('button', { name: 'com_ui_load_more' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onLoadMore).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('is marked busy while loading, ignores presses, and keeps keyboard focus', async () => {
    const onLoadMore = jest.fn();
    render(<SearchLoadMore onLoadMore={onLoadMore} isLoading />);
    const button = screen.getByTestId('search-load-more');
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    /* Not the `disabled` attribute, which would drop focus to the document. */
    expect(button).not.toBeDisabled();

    const user = userEvent.setup();
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('becomes a retry with an alert when the last page failed', async () => {
    const onLoadMore = jest.fn();
    render(<SearchLoadMore onLoadMore={onLoadMore} isError hint="ignored while failing" />);

    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_search_load_more_failed');
    expect(screen.queryByText('ignored while failing')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('announces a busy last page politely', () => {
    render(<SearchLoadMore onLoadMore={jest.fn()} isError isBusy />);
    const state = screen.getByRole('status');
    expect(state).toHaveAttribute('aria-live', 'polite');
    expect(state).toHaveTextContent('com_ui_search_busy');
  });

  it('announces its hint', () => {
    render(<SearchLoadMore onLoadMore={jest.fn()} hint="More may exist" />);
    expect(screen.getByRole('status')).toHaveTextContent('More may exist');
  });
});

describe('SearchErrorState', () => {
  it('maps the busy code to the busy state', () => {
    render(<SearchErrorState code="search_busy" />);
    expect(screen.getByTestId('search-busy-state')).toBeInTheDocument();
  });

  it('maps the failed code to the failed state', () => {
    render(<SearchErrorState code="search_failed" />);
    expect(screen.getByTestId('search-failed-state')).toBeInTheDocument();
  });

  it('maps a rejected cursor to a restart where one is offered', () => {
    render(<SearchErrorState code="search_cursor_invalid" onRestart={jest.fn()} />);
    expect(screen.getByTestId('search-cursor-restart')).toBeInTheDocument();
  });

  it('maps a rejected cursor to the failed state on a surface that cannot restart', () => {
    render(<SearchErrorState code="search_cursor_invalid" onRetry={jest.fn()} />);
    expect(screen.getByTestId('search-failed-state')).toBeInTheDocument();
  });
});
