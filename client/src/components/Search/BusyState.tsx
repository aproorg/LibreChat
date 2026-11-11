import { Alert, Button } from '@librechat/client';
import { useLocalize } from '~/hooks';

type BusyStateProps = {
  onRetry?: () => void;
  className?: string;
};

/** Search is at capacity. Announced politely: nothing is lost, and trying again soon works. */
export default function BusyState({ onRetry, className }: BusyStateProps) {
  const localize = useLocalize();
  return (
    <Alert
      variant="warning"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={className}
      data-testid="search-busy-state"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{localize('com_ui_search_busy')}</span>
        {onRetry && (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {localize('com_ui_retry')}
          </Button>
        )}
      </div>
    </Alert>
  );
}
