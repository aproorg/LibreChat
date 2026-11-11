import { Alert } from '@librechat/client';
import { useLocalize } from '~/hooks';

type PartialStateProps = {
  className?: string;
};

/** Message search failed while title search worked, so the list holds title matches only. */
export default function PartialState({ className }: PartialStateProps) {
  const localize = useLocalize();
  return (
    <Alert
      variant="warning"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={className}
      data-testid="search-partial-state"
    >
      {localize('com_ui_search_partial')}
    </Alert>
  );
}
