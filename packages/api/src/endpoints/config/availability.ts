import type { TEndpoint } from 'librechat-data-provider';

/**
 * Model availability helpers for custom endpoints.
 *
 * Kept as a leaf module — it imports nothing from `~` — so both the models
 * loader and the endpoints loader can share one definition of "can this
 * endpoint serve models at all" without a cycle between them. The two used to
 * carry copies of that predicate, which is how they drifted.
 */

/**
 * The `models` block is all these helpers read, and both the validated
 * (`TEndpoint`) and raw-config (`Partial<TEndpoint>`) shapes satisfy this.
 */
export type EndpointModelsSource = { models?: TEndpoint['models'] };

/**
 * `models.default` normalized to plain names. Entries may be bare strings or
 * `{ name }` objects; both forms mean the same model.
 */
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
 * that is how a base configuration ships an endpoint template for a deployment
 * to fill in — and `[]` is truthy, so a bare truthiness check would admit an
 * endpoint that can never produce a model and leave it advertised but unusable.
 */
export function hasModelSource(endpoint?: EndpointModelsSource | null): boolean {
  if (!endpoint?.models) {
    return false;
  }
  return Boolean(endpoint.models.fetch) || declaredModelNames(endpoint).length > 0;
}
