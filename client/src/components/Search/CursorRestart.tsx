import { Alert, Button } from '@librechat/client';
import { useLocalize } from '~/hooks';

type CursorRestartProps = {
  onRestart: () => void;
  className?: string;
};

/** The server rejected the paging cursor, so the only way on is the search's first page. */
export default function CursorRestart({ onRestart, className }: CursorRestartProps) {
  const localize = useLocalize();
  return (
    <Alert
      variant="neutral"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={className}
      data-testid="search-cursor-restart"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{localize('com_ui_search_cursor_restart')}</span>
        <Button type="button" variant="outline" size="sm" onClick={onRestart}>
          {localize('com_ui_search_restart')}
        </Button>
      </div>
    </Alert>
  );
}
