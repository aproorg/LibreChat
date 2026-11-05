import { searchConfigSchema } from 'librechat-data-provider';
import type { ConversationSearchConfig, TCustomConfig, DeepPartial } from 'librechat-data-provider';
import logger from '~/config/winston';

/**
 * Resolves the `search` block with its defaults. Omitted, the result is the default-off
 * configuration, which behaves as the app does without this feature. An invalid block
 * normally stops at `configSchema`, as with any other section, so startup exits there
 * (`packages/api/src/app/loader.ts`); the fallback here covers a block that reached this
 * function another way. A `backend` that needs search data while `data` is off logs a
 * configuration error and keeps its values, because the routes define that state
 * and startup must not fail on it.
 */
export function loadSearchConfig(config: DeepPartial<TCustomConfig>): ConversationSearchConfig {
  const parsed = searchConfigSchema.safeParse(config.search ?? {});
  if (!parsed.success) {
    logger.error('[AppService] Invalid search config, using defaults', parsed.error.flatten());
    return searchConfigSchema.parse({});
  }

  const search = parsed.data;
  if (search.backend !== 'meilisearch' && !search.data) {
    logger.error(
      `[AppService] search.backend '${search.backend}' needs search.data to be true. ` +
        "Until corrected, 'shadow' serves Meilisearch with no detached run and 'search' reports search as disabled.",
    );
  }
  return search;
}
