import type { Access } from '~/access';

/** Drops the model list of every endpoint the caller may not use. Null access returns the input. */
export function filterModelsByAccess(
  modelsConfig: Record<string, string[]>,
  access: Access | null,
): Record<string, string[]> {
  if (!access) {
    return modelsConfig;
  }
  return Object.fromEntries(
    Object.entries(modelsConfig).filter(([endpoint]) => access.allowsEndpoint(endpoint)),
  );
}
