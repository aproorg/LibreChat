import type { SearchContext } from '@librechat/data-schemas';

export interface SearchContextRequest {
  user?: { id?: string };
}

export interface SearchContextResponse {
  readonly writableFinished: boolean;
  once(event: 'close', listener: () => void): unknown;
}

/**
 * What a search needs from its request. The user comes from the session and nowhere
 * else. A response that completed normally leaves the signal alone; only a real
 * disconnect fires it. Reads no config.
 */
export function createSearchContext(
  req: SearchContextRequest,
  res: SearchContextResponse,
): SearchContext {
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) {
      controller.abort();
    }
  });
  return {
    user: req.user?.id ?? '',
    signal: controller.signal,
    startedAt: Date.now(),
  };
}
