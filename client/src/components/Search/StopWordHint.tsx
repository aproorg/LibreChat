import { Alert } from '@librechat/client';
import { useLocalize } from '~/hooks';

type StopWordHintProps = {
  className?: string;
};

/** The query held only words too common to search for, which is why nothing came back. */
export default function StopWordHint({ className }: StopWordHintProps) {
  const localize = useLocalize();
  return (
    <Alert
      variant="info"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={className}
      data-testid="search-stop-word-hint"
    >
      {localize('com_ui_search_stop_words')}
    </Alert>
  );
}
