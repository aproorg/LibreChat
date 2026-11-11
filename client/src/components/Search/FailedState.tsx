import { Alert, Button } from '@librechat/client';
import { useLocalize } from '~/hooks';

type FailedStateProps = {
  onRetry?: () => void;
  className?: string;
};

/** Search failed, which must never read as a search that found nothing. */
export default function FailedState({ onRetry, className }: FailedStateProps) {
  const localize = useLocalize();
  return (
    <Alert variant="error" role="alert" className={className} data-testid="search-failed-state">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{localize('com_ui_search_failed')}</span>
        {onRetry && (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {localize('com_ui_retry')}
          </Button>
        )}
      </div>
    </Alert>
  );
}
