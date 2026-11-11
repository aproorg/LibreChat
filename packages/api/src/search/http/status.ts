import type { SearchStateEntry } from '@librechat/data-schemas';
import type { SearchMeta } from 'librechat-data-provider';
import type { SearchService, SearchServiceMethods } from '../service';
import type { MeiliHealthClient, MeiliStatusDeps } from '../meili';
import {
  isMeiliSyncCaughtUp,
  meiliSyncThreshold,
  isMeiliConfigured,
  MEILI_SYNC_MODELS,
  isSearchEnvOn,
} from '../meili';
import { ANALYZER_KEY, VERIFICATION_KEY } from '../jobs/control';
import { getSafeErrorMetadata } from '~/utils/errors';

export interface SearchStatus {
  /** `/api/search/enable`: the whole table in `contracts/http.md`. Never rejects. */
  enabled(): Promise<boolean>;
  /** `/api/search/meta`: `{}` unless search data is on and a pack carries an attribution. Never rejects. */
  meta(): Promise<SearchMeta>;
}

type Attribution = NonNullable<SearchMeta['attribution']>;

/** How long one sync-progress answer stands: each costs eight counts over the source collections. */
const RESYNC_CACHE_MS = 60_000;

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

function attributionOf(pack: unknown): Attribution | null {
  const { text, url } = (pack as { attribution?: { text?: unknown; url?: unknown } } | null)
    ?.attribution ?? { text: undefined, url: undefined };
  return typeof text === 'string' && typeof url === 'string' ? { text, url } : null;
}

const firstAttribution = (packs: unknown): Attribution | null => {
  for (const pack of Array.isArray(packs) ? packs : []) {
    const found = attributionOf(pack);
    if (found) {
      return found;
    }
  }
  return null;
};

export function createSearchStatus({
  service,
  methods,
  logger,
  meili,
  now = Date.now,
}: {
  service: Pick<SearchService, 'config' | 'packState' | 'jobAnalyzer'>;
  methods: Pick<SearchServiceMethods, 'readSearchState'>;
  logger: { warn(message: string, meta: object): unknown };
  meili: MeiliStatusDeps;
  now?: () => number;
}): SearchStatus {
  const { backend, data, statusCacheSeconds, searchTimeoutMs, meiliResyncPending } = service.config;
  const searchOn = isSearchEnvOn(meili.env);
  const syncThreshold = meiliSyncThreshold(meili.env);
  const cacheMs = statusCacheSeconds * 1000;

  let verification: { passed: boolean; expiresAt: number } | null = null;
  let kept: { attribution: Attribution | null; expiresAt: number } | null = null;
  let client: MeiliHealthClient | null | undefined;
  /* Once the full sync has caught up it stays so for this process: later saves index as they land. */
  let resyncPassed = false;
  let resyncCheck: { result: Promise<boolean>; expiresAt: number } | null = null;

  /* `useSearchEnabled` calls `/enable` on every app load, so this read is cached (R-15). */
  async function verificationPassed(): Promise<boolean> {
    if (verification && now() < verification.expiresAt) {
      return verification.passed;
    }
    try {
      const entry = await methods.readSearchState(VERIFICATION_KEY, { maxTimeMS: searchTimeoutMs });
      const passed = hasPassed(entry);
      verification = { passed, expiresAt: now() + cacheMs };
      return passed;
    } catch (error) {
      logger.warn('[search] Status read failed', getSafeErrorMetadata(error));
      return false;
    }
  }

  /** Built on first use and kept, so a process without Meilisearch never builds one. */
  function meiliClient(): MeiliHealthClient | null {
    if (client !== undefined) {
      return client;
    }
    const { MEILI_HOST: host, MEILI_MASTER_KEY: apiKey } = meili.env;
    client = null;
    if (!isMeiliConfigured(meili.env) || !meili.MeiliSearch || !host || !apiKey) {
      return client;
    }
    try {
      client = new meili.MeiliSearch({ host, apiKey });
    } catch (error) {
      logger.warn('[search] Meilisearch client failed', getSafeErrorMetadata(error));
    }
    return client;
  }

  async function meiliHealthy(): Promise<boolean> {
    const current = meiliClient();
    if (!current) {
      return false;
    }
    try {
      return (await current.health()).status === 'available';
    } catch {
      return false;
    }
  }

  async function readResync(): Promise<boolean> {
    try {
      const progress = await Promise.all(
        MEILI_SYNC_MODELS.map((name) => {
          const model = meili.models?.[name];
          if (typeof model?.getSyncProgress !== 'function') {
            throw new Error(`No sync progress on ${name}`);
          }
          return model.getSyncProgress();
        }),
      );
      resyncPassed = progress.every((entry) => isMeiliSyncCaughtUp(entry, syncThreshold));
      return resyncPassed;
    } catch (error) {
      logger.warn('[search] Meilisearch sync progress read failed', getSafeErrorMetadata(error));
      return false;
    }
  }

  /** A failed read is cached like any other answer, so an outage is not met with more counts. */
  function resyncCaughtUp(): Promise<boolean> {
    if (resyncPassed) {
      return Promise.resolve(true);
    }
    const at = now();
    if (resyncCheck && at < resyncCheck.expiresAt) {
      return resyncCheck.result;
    }
    const result = readResync();
    resyncCheck = { result, expiresAt: at + RESYNC_CACHE_MS };
    return result;
  }

  /**
   * What `search_state.analyzer` holds: a removed pack's attribution until reconcile has
   * rewritten its records (FR-043), then the packs the writer last recorded, which covers
   * a process whose own packs are still loading.
   */
  async function keptAttribution(): Promise<Attribution | null> {
    if (kept && now() < kept.expiresAt) {
      return kept.attribution;
    }
    try {
      const entry = await methods.readSearchState(ANALYZER_KEY, { maxTimeMS: searchTimeoutMs });
      const attribution =
        firstAttribution(entry?.attributionUntilReanalyzed) ?? firstAttribution(entry?.packs);
      kept = { attribution, expiresAt: now() + cacheMs };
      return attribution;
    } catch (error) {
      logger.warn('[search] Attribution read failed', getSafeErrorMetadata(error));
      return null;
    }
  }

  return {
    async enabled() {
      if (!searchOn) {
        return false;
      }
      if (backend === 'search') {
        if (!data || service.packState() !== 'loaded') {
          return false;
        }
        return verificationPassed();
      }
      if (!(await meiliHealthy())) {
        return false;
      }
      return meiliResyncPending ? resyncCaughtUp() : true;
    },
    async meta() {
      if (!data) {
        return {};
      }
      const attribution =
        firstAttribution(service.jobAnalyzer()?.packs) ?? (await keptAttribution());
      return attribution ? { attribution } : {};
    },
  };
}
