import { logger } from '@librechat/data-schemas';
import { EModelEndpoint, normalizeEndpointName } from 'librechat-data-provider';
import type { TEndpointsConfig, TModelsConfig, TEndpoint, TConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';

/**
 * Model availability helpers for custom endpoints.
 *
 * A leaf module — it imports nothing from `~` — so the models loader, the
 * custom-endpoints loader and the endpoints route can share one definition of
 * "can this endpoint serve models at all" without a cycle. They used to hold
 * copies of that predicate, which is how they drifted.
 */

/** The `models` block is all these helpers read; validated and raw-config shapes both satisfy it. */
export type EndpointModelsSource = { models?: TEndpoint['models'] };

/** `models.default` as plain names. Entries may be bare strings or `{ name }` objects. */
export function declaredModelNames(endpoint?: EndpointModelsSource | null): string[] {
  const declared = endpoint?.models?.default;
  if (!Array.isArray(declared)) {
    return [];
  }
  return declared.map((model) => (typeof model === 'string' ? model : model.name));
}

/**
 * Whether an endpoint has any source of models: a live fetch, or a non-empty
 * declared list.
 *
 * The length test is load-bearing. `models.default` may legitimately be empty —
 * that is how a base configuration ships an endpoint template — and `[]` is
 * truthy, so a bare truthiness check would admit an endpoint that can never
 * produce a model.
 */
export function hasModelSource(endpoint?: EndpointModelsSource | null): boolean {
  if (!endpoint?.models) {
    return false;
  }
  return Boolean(endpoint.models.fetch) || declaredModelNames(endpoint).length > 0;
}

/**
 * Names of the custom endpoints whose served list is decided by `models.filter`.
 *
 * Nothing outside this set may change behaviour: an endpoint that does not
 * filter cannot end up with an unexpectedly empty list, so withholding it or
 * exempting it from a violation would be a change no deployment asked for.
 * `filter` also needs `fetch` to mean anything — without one there is no
 * fetched catalog to intersect against, and the served list is just the
 * declared one.
 *
 * Keyed by `normalizeEndpointName`, matching how the models config is keyed.
 */
export function filterManagedEndpoints(appConfig?: AppConfig | null): Set<string> {
  const managed = new Set<string>();
  const custom = appConfig?.endpoints?.[EModelEndpoint.custom] as TEndpoint[] | undefined;
  if (!Array.isArray(custom)) {
    return managed;
  }

  for (const endpoint of custom) {
    if (endpoint?.name && endpoint.models?.filter && endpoint.models.fetch) {
      managed.add(normalizeEndpointName(endpoint.name));
    }
  }
  return managed;
}

/**
 * Custom endpoints with nothing to serve this request, removed.
 *
 * An empty model list is not a usable endpoint: it renders as an empty picker
 * entry, and the agent builder offers it as a provider with no model to pick.
 *
 * Two kinds are exempt. Built-in endpoints, whose model lists come from
 * elsewhere and are not per-request; and user-provided endpoints, whose empty
 * list reflects the user's own key — missing, expired, or granted nothing — for
 * which the picker entry is the only route to a fix. `validateModel` exempts the
 * latter the same way.
 *
 * Only `filterManaged` endpoints are considered, so this is inert for a
 * deployment that does not use `models.filter`.
 *
 * Fails open: an absent models config, or one with no entry for an endpoint,
 * withholds nothing.
 */
export function withholdEmptyEndpoints(
  endpointsConfig: TEndpointsConfig,
  modelsConfig: TModelsConfig | null | undefined,
  filterManaged: ReadonlySet<string>,
): TEndpointsConfig {
  if (endpointsConfig == null || modelsConfig == null || filterManaged.size === 0) {
    return endpointsConfig;
  }

  const available: Record<string, TConfig | null | undefined> = {};
  for (const [name, config] of Object.entries(endpointsConfig)) {
    const models = modelsConfig[name];
    const withhold =
      filterManaged.has(name) &&
      config?.type === EModelEndpoint.custom &&
      !config.userProvide &&
      !config.userProvideURL &&
      Array.isArray(models) &&
      models.length === 0;

    if (withhold) {
      logger.debug(`[withholdEmptyEndpoints] "${name}": no models available for this request`);
      continue;
    }
    available[name] = config;
  }

  return available;
}
