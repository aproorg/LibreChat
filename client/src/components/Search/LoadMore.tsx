import { Button, Spinner } from '@librechat/client';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type LoadMoreProps = {
  onLoadMore: () => void;
  isLoading?: boolean;
  /** The last page failed. The button then retries it from the same place. */
  isError?: boolean;
  /** With `isError`: the failure was the busy code. */
  isBusy?: boolean;
  /** Shown above the button when nothing failed, e.g. that more results may exist. */
  hint?: string;
  className?: string;
};

/** The keyboard path to the next page, and the only path when a page has nothing to scroll. */
export default function LoadMore({
  onLoadMore,
  isLoading = false,
  isError = false,
  isBusy = false,
  hint,
  className,
}: LoadMoreProps) {
  const localize = useLocalize();
  const errorKey: TranslationKeys = isBusy
    ? 'com_ui_search_busy'
    : 'com_ui_search_load_more_failed';
  return (
    <div className={cn('flex flex-col items-center gap-2 text-sm', className)}>
      {isError && (
        <p
          role={isBusy ? 'status' : 'alert'}
          aria-live={isBusy ? 'polite' : undefined}
          aria-atomic="true"
          className="text-center text-text-secondary"
          data-testid="search-load-more-error"
        >
          {localize(errorKey)}
        </p>
      )}
      {!isError && hint != null && (
        <p role="status" aria-live="polite" className="text-center text-text-secondary">
          {hint}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onLoadMore}
        disabled={isLoading}
        aria-busy={isLoading}
        data-testid="search-load-more"
      >
        {isLoading && <Spinner className="size-4" aria-hidden="true" />}
        {localize(isError ? 'com_ui_retry' : 'com_ui_load_more')}
      </Button>
    </div>
  );
}
