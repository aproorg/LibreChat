import type { SearchStateEntry } from '@librechat/data-schemas';
import type { SearchService, SearchServiceMethods } from '../service';
import { getSafeErrorMetadata } from '~/utils/errors';

const VERIFICATION_KEY = 'verification';

export interface SearchStatus {
  /** The `search` row of `/enable`, or `null` where another backend keeps today's check. */
  enabled(): Promise<boolean | null>;
}

const timeOf = (value: unknown): number | null =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value.getTime() : null;

/** A pass counts only when it is later than the last invalidation (FR-037). */
function hasPassed(entry: SearchStateEntry | null): boolean {
  if (entry?.status !== 'passed') {
    return false;
  }
  const passedAt = timeOf(entry.passedAt);
  const invalidatedAt = timeOf(entry.invalidatedAt);
  return passedAt !== null && (invalidatedAt === null || passedAt > invalidatedAt);
}

export function createSearchStatus({
  service,
  methods,
  logger,
  now = Date.now,
}: {
  service: Pick<SearchService, 'config' | 'packState'>;
  methods: Pick<SearchServiceMethods, 'readSearchState'>;
  logger: { warn(message: string, meta: object): unknown };
  now?: () => number;
}): SearchStatus {
  const { backend, data, statusCacheSeconds, searchTimeoutMs } = service.config;
  let cached: { passed: boolean; expiresAt: number } | null = null;

  /* `useSearchEnabled` calls `/enable` on every app load, so this read is cached (R-15). */
  async function verificationPassed(): Promise<boolean> {
    if (cached && now() < cached.expiresAt) {
      return cached.passed;
    }
    try {
      const entry = await methods.readSearchState(VERIFICATION_KEY, { maxTimeMS: searchTimeoutMs });
      const passed = hasPassed(entry);
      cached = { passed, expiresAt: now() + statusCacheSeconds * 1000 };
      return passed;
    } catch (error) {
      logger.warn('[search] Status read failed', getSafeErrorMetadata(error));
      return false;
    }
  }

  return {
    async enabled() {
      if (backend !== 'search') {
        return null;
      }
      if (!data || service.packState() !== 'loaded') {
        return false;
      }
      return verificationPassed();
    },
  };
}
