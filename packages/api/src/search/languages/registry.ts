import type { LanguagePack } from './pack';
import { createEnPack, EN_PACK_ID } from './en';
import { createIsPack, IS_PACK_ID } from './is';

export interface SearchPackDeps {
  /** Directory holding language data delivered outside this repository. */
  languageDataDir: string;
}

export type SearchPackResolution =
  | { ok: true; packs: LanguagePack[] }
  | { ok: false; error: { code: 'pack_unregistered'; id: string } };

const FACTORIES = new Map<string, (deps: SearchPackDeps) => LanguagePack>([
  [IS_PACK_ID, ({ languageDataDir }) => createIsPack({ languageDataDir })],
  [EN_PACK_ID, () => createEnPack()],
]);

export function isRegisteredSearchPack(id: string): boolean {
  return FACTORIES.has(id);
}

/**
 * Builds the enabled packs without loading them. An unregistered ID is an answer,
 * not a throw: the service reports a pack failure and startup carries on.
 */
export function resolveSearchPacks(
  ids: readonly string[],
  deps: SearchPackDeps,
): SearchPackResolution {
  const packs: LanguagePack[] = [];
  for (const id of ids) {
    const create = FACTORIES.get(id);
    if (!create) {
      return { ok: false, error: { code: 'pack_unregistered', id } };
    }
    packs.push(create(deps));
  }
  return { ok: true, packs };
}
