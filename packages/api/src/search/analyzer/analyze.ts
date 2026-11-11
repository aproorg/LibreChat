import type { LanguagePack } from '../languages/pack';
import type { SearchRealtext } from '../metrics';
import { ANALYZER_CAPS } from './version';
import { words } from './words';
import { fold } from './fold';

export const PART_MARKER = '~';
export const MAX_DOC_TOKENS: number = ANALYZER_CAPS.docTokens;

const ALL_DIGITS = /^\p{N}+$/u;

export interface AnalyzerOptions {
  packs: readonly LanguagePack[];
  /** Most words kept in the cache. Affects speed only. */
  cacheWords: number;
  realtext?: Pick<SearchRealtext, 'addMessage'>;
}

export interface Analyzer {
  readonly packs: readonly LanguagePack[];
  /** Every enabled pack's stop words together. */
  readonly stopWords: ReadonlySet<string>;
  /** Index-side tokens of one word, which is already NFC and lowercase. */
  analyzeWord(word: string): readonly string[];
  /** Index-side tokens of a text, in first-seen order, up to the cap. */
  docTokens(text: string): string[];
  /** `docTokens` for a message body, counted in `search.realtext`. */
  analyzeMessage(text: string): string[];
  cacheSize(): number;
}

/** Routing steps 3 to 5 of `contracts/language-pack.md`, shared by the index and the query side. */
export function addLemmaTokens(
  packs: readonly LanguagePack[],
  word: string,
  folded: string,
  tokens: Set<string>,
): void {
  if (ALL_DIGITS.test(word)) {
    return;
  }
  let routed = false;
  for (const pack of packs) {
    if (pack.kind !== 'dictionary') {
      continue;
    }
    routed = routed || pack.knows?.(word) === true || pack.claims?.(word) === true;
    for (const lemma of pack.lemmas(word)) {
      tokens.add(fold(lemma));
    }
  }
  if (routed) {
    return;
  }
  for (const pack of packs) {
    if (pack.kind === 'stemmer') {
      for (const stem of pack.lemmas(folded)) {
        tokens.add(stem);
      }
    }
  }
}

function combineStopWords(packs: readonly LanguagePack[]): ReadonlySet<string> {
  const combined = new Set<string>();
  for (const { stopWords } of packs) {
    for (const word of stopWords) {
      combined.add(word);
    }
  }
  return combined;
}

/** Packs must have finished loading: the analyzer takes each pack's stop list once. */
export function createAnalyzer({ packs, cacheWords, realtext }: AnalyzerOptions): Analyzer {
  const stopWords = combineStopWords(packs);
  const cache = new Map<string, readonly string[]>();

  function computeWord(word: string): readonly string[] {
    if (stopWords.has(word)) {
      return [];
    }
    const folded = fold(word);
    const tokens = new Set([folded]);
    addLemmaTokens(packs, word, folded, tokens);
    if (ALL_DIGITS.test(word)) {
      return [...tokens];
    }
    for (const pack of packs) {
      for (const part of pack.parts?.(word) ?? []) {
        if (!stopWords.has(part)) {
          tokens.add(PART_MARKER + fold(part));
        }
      }
    }
    return [...tokens];
  }

  function analyzeWord(word: string): readonly string[] {
    const cached = cache.get(word);
    if (cached) {
      cache.delete(word);
      cache.set(word, cached);
      return cached;
    }
    const computed = computeWord(word);
    cache.set(word, computed);
    if (cache.size > cacheWords) {
      cache.delete(cache.keys().next().value as string);
    }
    return computed;
  }

  function docTokens(text: string): string[] {
    const tokens = new Set<string>();
    for (const word of words(text)) {
      for (const token of analyzeWord(word)) {
        tokens.add(token);
        if (tokens.size >= MAX_DOC_TOKENS) {
          return [...tokens];
        }
      }
    }
    return [...tokens];
  }

  function analyzeMessage(text: string): string[] {
    const tokens = docTokens(text);
    realtext?.addMessage(tokens.length, tokens.length >= MAX_DOC_TOKENS);
    return tokens;
  }

  return {
    packs,
    stopWords,
    analyzeWord,
    docTokens,
    analyzeMessage,
    cacheSize: () => cache.size,
  };
}
