/** Stable codes for a pack failure. The message holds nothing but these and the pack's ID. */
export type SearchPackErrorCode =
  | 'pack_not_loaded'
  | 'pack_data_missing'
  | 'pack_data_checksum'
  | 'pack_load_failed';

/**
 * A pack that cannot serve. The service turns it into not ready and an alarm,
 * with chat unaffected. It carries no path or cause, so it is safe to log.
 */
export class SearchPackError extends Error {
  readonly code: SearchPackErrorCode;
  readonly packId: string;

  constructor(code: SearchPackErrorCode, packId: string) {
    super(`Language pack ${packId}: ${code}`);
    this.name = 'SearchPackError';
    this.code = code;
    this.packId = packId;
  }
}

/** All language knowledge sits behind this. See `contracts/language-pack.md`. */
export interface LanguagePack {
  id: string;
  /** Part of the analyzer version. */
  version: string;
  kind: 'dictionary' | 'stemmer';
  /** NFC, lowercase, unfolded. */
  stopWords: ReadonlySet<string>;
  /** Dictionary packs: core forms. */
  knows?(word: string): boolean;
  /** Dictionary packs: unknown words stemmers must skip. */
  claims?(word: string): boolean;
  /** Both sides. A stemmer returns its stem. */
  lemmas(word: string): string[];
  /** Index side only, nouns only. Stored with `~`. */
  parts?(word: string): string[];
  /** Query words typed without the language's letters. */
  queryLemmas?(folded: string): string[];
  attribution?: { text: string; url: string };
  /** Called only when search data is on, after the server listens. */
  load?(): Promise<void>;
}
