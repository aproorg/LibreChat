import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import type { LanguagePack, SearchPackErrorCode } from '../pack';
import { fold } from '../../analyzer/fold';
import { SearchPackError } from '../pack';
import { FoldTable } from './foldTable';

export const IS_PACK_ID = 'is';

/**
 * The delivered files as they must be, per `hashDeliveredData`. A checksum holds none
 * of the data it covers. A new delivery changes it, and through it the pack version.
 */
export const IS_DATA_SHA512 =
  'bb777a2007966f0f0273f3ce5575d290eb839df55b86e21ae77e8fb599e41ad39cf1d94db944028de77499ba59cfae4f00576c30e5ed8b465ee0e1b39607b417';

/** FR-043's text, shown verbatim in every locale. */
export const IS_ATTRIBUTION = {
  text: 'The Database of Icelandic Morphology. The Árni Magnússon Institute for Icelandic Studies. Author and editor Kristín Bjarnadóttir.',
  url: 'https://bin.arnastofnun.is',
} as const;

const LIBRARY_ENTRY = 'lemma-is/dist/index.mjs';
const CORE_DATA = 'lemma-is/data-dist/lemma-is.core.bin';
const FOLD_TABLE = 'fold-table.bin';
const MANIFEST = 'manifest.json';
const STOP_LEMMA_LIST = 'lists/stop-lemma.json';
const STOP_EXTRA_LIST = 'lists/stop-extra.json';
const BLOCKED_PART_LIST = 'lists/function-verbs.json';

/** The shortest word worth splitting, and the shortest part worth keeping. */
const MIN_SPLIT = 8;
const MIN_PART = 3;
const ICELANDIC_LETTERS = /[þðæöáéíóúý]/;

interface Lemmatizer {
  isKnown(word: string): boolean;
  lemmatize(word: string): string[];
  lemmatizeWithPOS(word: string): Array<{ lemma: string; pos: string }>;
  getAllLemmas(): string[];
}

/** The parts of the ESM-only library this pack uses. It has no types here: it is not a dependency. */
interface LemmaLibrary {
  STOPWORDS_IS: ReadonlySet<string>;
  BinaryLemmatizer: { loadFromBuffer(buffer: ArrayBuffer): Lemmatizer };
  CompoundSplitter: new (
    lemmatizer: Lemmatizer,
    known: unknown,
    options: { mode: string },
  ) => { split(word: string): { isCompound: boolean; parts: string[] } | null | undefined };
  createKnownLemmaFilter(lemmas: string[]): unknown;
}

interface LoadedData {
  lemmatizer: Lemmatizer;
  split: (word: string) => { isCompound: boolean; parts: string[] } | null | undefined;
  foldTable: FoldTable;
  stopWords: ReadonlySet<string>;
  stopLemmas: ReadonlySet<string>;
  stopLemmasFolded: ReadonlySet<string>;
  blockedParts: ReadonlySet<string>;
}

export interface IsPackOptions {
  languageDataDir: string;
  /** Replaces the checksum in code, for tests over other data. */
  expectedSha512?: string;
}

const failure = (code: SearchPackErrorCode): SearchPackError =>
  new SearchPackError(code, IS_PACK_ID);

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function deliveredFiles(root: string, relative = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await deliveredFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw failure('pack_data_checksum');
    }
  }
  return files;
}

/**
 * The manifest's rule: sha512 over one `<file sha512>  <path>\n` line per delivered
 * file, sorted by the bytes of the path, leaving out the manifest itself. It reads the
 * files rather than the manifest's list, so a changed or added file is noticed.
 */
export async function hashDeliveredData(root: string): Promise<string> {
  const files = (await deliveredFiles(root))
    .filter((path) => path !== MANIFEST)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const hash = createHash('sha512');
  for (const path of files) {
    hash.update(`${await hashFile(join(root, path))}  ${path}\n`);
  }
  return hash.digest('hex');
}

async function verifyDelivery(root: string, expected: string): Promise<void> {
  let declared: unknown;
  try {
    declared = JSON.parse(await readFile(join(root, MANIFEST), 'utf8'));
  } catch {
    throw failure('pack_data_missing');
  }
  const actual = await hashDeliveredData(root);
  const manifest = declared as { sha512?: unknown } | null;
  if (actual !== expected || manifest?.sha512 !== expected) {
    throw failure('pack_data_checksum');
  }
}

async function readStringList(path: string): Promise<string[]> {
  const list: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) {
    throw failure('pack_load_failed');
  }
  return list;
}

async function loadData(root: string, expected: string): Promise<LoadedData> {
  if (!root) {
    throw failure('pack_data_missing');
  }
  await verifyDelivery(root, expected);
  const entry = pathToFileURL(join(root, LIBRARY_ENTRY)).href;
  const library = (await import(entry)) as LemmaLibrary;
  const [core, foldTable, stopLemmas, stopExtra, blockedParts] = await Promise.all([
    readFile(join(root, CORE_DATA)),
    FoldTable.load(join(root, FOLD_TABLE)),
    readStringList(join(root, STOP_LEMMA_LIST)),
    readStringList(join(root, STOP_EXTRA_LIST)),
    readStringList(join(root, BLOCKED_PART_LIST)),
  ]);
  const lemmatizer = library.BinaryLemmatizer.loadFromBuffer(
    core.buffer.slice(core.byteOffset, core.byteOffset + core.byteLength),
  );
  const splitter = new library.CompoundSplitter(
    lemmatizer,
    library.createKnownLemmaFilter(lemmatizer.getAllLemmas()),
    { mode: 'balanced' },
  );
  return {
    lemmatizer,
    split: (word) => splitter.split(word),
    foldTable,
    stopWords: new Set([...library.STOPWORDS_IS, ...stopExtra].map((w) => w.normalize('NFC'))),
    stopLemmas: new Set(stopLemmas),
    stopLemmasFolded: new Set(stopLemmas.map(fold)),
    blockedParts: new Set(blockedParts),
  };
}

const NO_STOP_WORDS: ReadonlySet<string> = new Set();

/**
 * The Icelandic dictionary pack. Its library and data come from `languageDataDir` at
 * `load`, which runs only with search data on, so this file holds no language data.
 * A failed load leaves nothing behind: the pack keeps refusing, and can load again.
 */
export function createIsPack({
  languageDataDir,
  expectedSha512 = IS_DATA_SHA512,
}: IsPackOptions): LanguagePack {
  let data: LoadedData | null = null;
  let loading: Promise<void> | null = null;

  const loaded = (): LoadedData => {
    if (!data) {
      throw failure('pack_not_loaded');
    }
    return data;
  };

  async function load(): Promise<void> {
    try {
      data = await loadData(languageDataDir, expectedSha512);
    } catch (error) {
      loading = null;
      throw error instanceof SearchPackError ? error : failure('pack_load_failed');
    }
  }

  return {
    id: IS_PACK_ID,
    version: `1-${expectedSha512.slice(0, 16)}`,
    kind: 'dictionary',
    get stopWords() {
      return data?.stopWords ?? NO_STOP_WORDS;
    },
    attribution: IS_ATTRIBUTION,
    knows(word) {
      return loaded().lemmatizer.isKnown(word);
    },
    claims(word) {
      loaded();
      return ICELANDIC_LETTERS.test(word);
    },
    lemmas(word) {
      const { lemmatizer, foldTable, stopLemmas, stopLemmasFolded } = loaded();
      if (lemmatizer.isKnown(word)) {
        return lemmatizer.lemmatize(word).filter((lemma) => !stopLemmas.has(lemma));
      }
      // The core holds 350,000 forms. The table holds them all, so a rarer form reaches its lemma.
      const lemmas = foldTable.lookup(fold(word)).filter((lemma) => !stopLemmasFolded.has(lemma));
      if (ICELANDIC_LETTERS.test(word)) {
        // Folding can collide, so the suffix fallback runs as well. It only guesses for these words.
        for (const lemma of lemmatizer.lemmatize(word)) {
          if (lemma !== word && !stopLemmas.has(lemma)) {
            lemmas.push(lemma);
          }
        }
      }
      return lemmas;
    },
    queryLemmas(folded) {
      const { foldTable, stopLemmas } = loaded();
      return foldTable.lookup(folded).filter((lemma) => !stopLemmas.has(lemma));
    },
    parts(word) {
      const { lemmatizer, split, stopWords, blockedParts } = loaded();
      // The library reads a plain object by key, so `split('constructor')` throws.
      if (word.length < MIN_SPLIT || word in Object.prototype) {
        return [];
      }
      const result = split(word);
      if (!result?.isCompound) {
        return [];
      }
      return result.parts.filter(
        (part) =>
          part !== word &&
          part.length >= MIN_PART &&
          !blockedParts.has(part) &&
          !stopWords.has(part) &&
          lemmatizer
            .lemmatizeWithPOS(part)
            .some((reading) => reading.lemma === part && reading.pos === 'no'),
      );
    },
    load() {
      loading ??= load();
      return loading;
    },
  };
}
