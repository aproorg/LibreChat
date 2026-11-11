import type { LanguagePack } from '../../pack';
import { SearchPackError } from '../../pack';

/**
 * A dictionary pack over an invented vocabulary, so public CI covers routing
 * without any real language data. The words mean nothing and come from no source.
 */
const CORE = new Map<string, string[]>([
  ['blorg', ['blorg']],
  ['blorgum', ['blorg']],
  ['kvartana', ['kvartur', 'kvart']],
  ['bláfum', ['bláfur']],
]);
const TABLE = new Map<string, string[]>([
  ['snidrum', ['snidur']],
  ['mal', ['malur']],
  ['blafum', ['blafur']],
]);
const PARTS = new Map<string, string[]>([
  ['blorgkvartana', ['blorg', 'kvart']],
  ['blorgwith', ['blorg', 'with']],
]);
const CLAIMED = /[áðþ]/;

export function createFakeDictionaryPack(options: { failLoad?: boolean } = {}): LanguagePack & {
  loads: () => number;
} {
  let loaded = false;
  let loads = 0;
  const assertLoaded = () => {
    if (!loaded) {
      throw new SearchPackError('pack_not_loaded', 'fake');
    }
  };
  return {
    id: 'fake',
    version: '1',
    kind: 'dictionary',
    get stopWords() {
      return loaded ? new Set(['zog', 'ðox']) : new Set<string>();
    },
    loads: () => loads,
    knows(word) {
      assertLoaded();
      return CORE.has(word);
    },
    claims(word) {
      assertLoaded();
      return CLAIMED.test(word);
    },
    lemmas(word) {
      assertLoaded();
      const known = CORE.get(word);
      if (known) {
        return known;
      }
      const wider = TABLE.get(word) ?? [];
      return CLAIMED.test(word) && word.endsWith('ði') ? [...wider, word.slice(0, -2)] : wider;
    },
    parts(word) {
      assertLoaded();
      return PARTS.get(word) ?? [];
    },
    queryLemmas(folded) {
      assertLoaded();
      return TABLE.get(folded) ?? [];
    },
    async load() {
      loads += 1;
      if (options.failLoad) {
        throw new SearchPackError('pack_load_failed', 'fake');
      }
      loaded = true;
    },
  };
}
