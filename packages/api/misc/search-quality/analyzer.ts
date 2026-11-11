import { createAnalyzer } from '~/search/analyzer/analyze';
import { resolveSearchPacks } from '~/search/languages/registry';
import type { Analyzer } from '~/search/analyzer/analyze';

/** The analyzer FR-007 ties to the reference: `is` and `en`, as first enabled. */
export async function loadQualityAnalyzer(languageDataDir: string): Promise<Analyzer> {
  const resolved = resolveSearchPacks(['is', 'en'], { languageDataDir });
  if (!resolved.ok) {
    throw new Error(resolved.error.code);
  }
  await Promise.all(resolved.packs.map((pack) => pack.load?.()));
  return createAnalyzer({ packs: resolved.packs, cacheWords: 2_000_000 });
}
