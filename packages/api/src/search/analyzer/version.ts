import { createHash } from 'node:crypto';
import { MAX_SEARCH_TOKENS } from '@librechat/data-schemas';
import type { LanguagePack } from '../languages/pack';
import { FOLD_RULE_VERSION } from './fold';
import { MAX_WORD_LENGTH } from './words';

/** What bounds a record's tokens. A change here is a token change (FR-026). */
export interface AnalyzerCaps {
  wordLength: number;
  docTokens: number;
}

export const ANALYZER_CAPS: Readonly<AnalyzerCaps> = {
  wordLength: MAX_WORD_LENGTH,
  docTokens: MAX_SEARCH_TOKENS,
};

export interface AnalyzerVersionOptions {
  foldRuleVersion?: number;
  caps?: AnalyzerCaps;
}

const compare = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/**
 * Identifies everything that decides a record's tokens: enabled packs and their
 * versions, stop lists, the fold rule and the caps. A record stored under another
 * value is re-analyzed by reconcile (FR-026).
 */
export function computeAnalyzerVersion(
  packs: ReadonlyArray<Pick<LanguagePack, 'id' | 'version' | 'stopWords'>>,
  options: AnalyzerVersionOptions = {},
): string {
  const { foldRuleVersion = FOLD_RULE_VERSION, caps = ANALYZER_CAPS } = options;
  const canonical = {
    packs: packs
      .map(({ id, version, stopWords }) => ({
        id,
        version,
        stopWords: [...stopWords].sort(compare),
      }))
      .sort((a, b) => compare(a.id, b.id)),
    foldRuleVersion,
    caps: { wordLength: caps.wordLength, docTokens: caps.docTokens },
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}
