import type { LanguagePack } from '../pack';
import { SearchPackError } from '../pack';

export const EN_PACK_ID = 'en';

const STOP_WORDS =
  'the a an and or of to in on at for is are was were be been being am it its this that these those with as by from have has had having not no but you your yours i me my mine we us our they them their he him his she her hers if then so do does did doing can could will would should shall may might must what which who whom how when where why there here than too very just also about into over under out up down more most some any each both only own same such again further once';

interface Stemmer {
  stem(word: string): string;
}

interface StemmerModule {
  newStemmer?: (language: string) => Stemmer;
  default?: { newStemmer: (language: string) => Stemmer };
}

export interface EnPackOptions {
  /** Replaces the Snowball import, for a test of a failed load. */
  importStemmer?: () => Promise<StemmerModule>;
}

/** The English stemmer pack. Snowball stays unloaded until `load`, so nothing runs with search data off. */
export function createEnPack({
  importStemmer = () => import('snowball-stemmers'),
}: EnPackOptions = {}): LanguagePack {
  let stemmer: Stemmer | null = null;
  let loading: Promise<void> | null = null;

  async function loadStemmer(): Promise<void> {
    try {
      const library = await importStemmer();
      const newStemmer = library.newStemmer ?? library.default?.newStemmer;
      if (!newStemmer) {
        throw new SearchPackError('pack_load_failed', EN_PACK_ID);
      }
      stemmer = newStemmer('english');
    } catch {
      loading = null;
      throw new SearchPackError('pack_load_failed', EN_PACK_ID);
    }
  }

  return {
    id: EN_PACK_ID,
    version: '1',
    kind: 'stemmer',
    stopWords: new Set(STOP_WORDS.split(' ')),
    lemmas(word) {
      if (!stemmer) {
        throw new SearchPackError('pack_not_loaded', EN_PACK_ID);
      }
      return [stemmer.stem(word)];
    },
    load() {
      loading ??= loadStemmer();
      return loading;
    },
  };
}
