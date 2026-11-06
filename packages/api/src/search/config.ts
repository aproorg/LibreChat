import { loadSearchConfig } from '@librechat/data-schemas';
import type { ConversationSearchConfig } from 'librechat-data-provider';

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/**
 * The `search` block as one process sees it for its whole life. It comes from
 * `getAppConfig({ baseOnly: true })` once at start and is handed to the service,
 * so no request reads config and a change takes effect by rolling restart.
 */
export type SearchConfigSnapshot = DeepReadonly<ConversationSearchConfig>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Copies and freezes the block, so a later change to the source cannot reach the snapshot. */
export function createSearchConfigSnapshot(appConfig: {
  search?: ConversationSearchConfig;
}): SearchConfigSnapshot {
  return deepFreeze(structuredClone(appConfig.search ?? loadSearchConfig({})));
}

/** Sync, backfill and language packs run only with this on. */
export function isSearchDataOn(config: SearchConfigSnapshot): boolean {
  return config.data;
}

/**
 * The new search answers requests. With search data off the backend still routes
 * to the service, which reports `search_failed` rather than falling back.
 */
export function isSearchServing(config: SearchConfigSnapshot): boolean {
  return config.backend === 'search';
}

/** Meilisearch serves and the new search runs detached, which needs search data. */
export function isShadowRunEnabled(config: SearchConfigSnapshot): boolean {
  return config.backend === 'shadow' && config.data;
}
