import type { SearchErrorCode } from 'librechat-data-provider';
import CursorRestart from './CursorRestart';
import FailedState from './FailedState';
import BusyState from './BusyState';

type ErrorStateProps = {
  code: SearchErrorCode;
  onRetry?: () => void;
  /** Without it a rejected cursor reads as a plain failure, for surfaces that never page by it. */
  onRestart?: () => void;
  className?: string;
};

/** Maps a search failure's stable code to its state. */
export default function ErrorState({ code, onRetry, onRestart, className }: ErrorStateProps) {
  if (code === 'search_cursor_invalid' && onRestart) {
    return <CursorRestart onRestart={onRestart} className={className} />;
  }
  if (code === 'search_busy') {
    return <BusyState onRetry={onRetry} className={className} />;
  }
  return <FailedState onRetry={onRetry} className={className} />;
}
