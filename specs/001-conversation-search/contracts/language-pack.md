# Language Pack Contract

Extends §4's interface. `claims` is new because the spec keeps the Icelandic-letter test inside the Icelandic pack (FR-001). `version` feeds the analyzer version, `load` keeps the cost off when search data is off, and `attribution` gains a URL for FR-043.

```ts
interface LanguagePack {
  id: string;                            // 'is', 'en'
  version: string;                       // part of the analyzer version
  kind: 'dictionary' | 'stemmer';
  stopWords: ReadonlySet<string>;        // NFC, lowercase, unfolded
  knows?(word: string): boolean;         // dictionary packs: core forms
  claims?(word: string): boolean;        // dictionary packs: unknown words stemmers must skip
  lemmas(word: string): string[];        // both sides; a stemmer returns its stem
  parts?(word: string): string[];        // index side only, nouns only; stored with `~`
  queryLemmas?(folded: string): string[];// query words typed without the language's letters
  attribution?: { text: string; url: string };
  load?(): Promise<void>;                // called only when search data is on, after the server listens
}
```

`search.languages` is a list of strings in the config schema, so a new pack edits nothing outside `languages/`. An unregistered ID is a pack failure in the service: not ready and an alarm, with chat unaffected.

## Shared routing (`analyzer/analyze.ts`)

For one word, after NFC, lowercase and the 48-character limit:

1. If it is in the combined stop list on the unfolded surface, it yields nothing.
2. Surface token: `fold(word)`.
3. All-digit words stop here.
4. Add `pack.lemmas(word)`, folded, from every enabled dictionary pack. A pack returns its known-form lemmas, its wider table, or its guarded fallback as it sees fit.
5. If no dictionary pack `knows` the word and none `claims` it, add every stemmer pack's stem.
6. Add `~` + `fold(part)` for every `pack.parts(word)`, dropping any part in the combined stop list, as parity requires.

Query side: the same, except a query word is never split, and `parts` tokens are the `~` forms of its own surface and lemmas. Query-side `queryLemmas` applies when no pack `claims` the word. Where this text and `final/analyze.mjs` differ, the reference wins, and the parity test decides.

The shared layer holds word splitting, folding, the token format, the read plan, ranking, storage and the word list. No code outside `languages/` names a language.

## Today's packs

- **`en`**: stemmer, Snowball, stop list from the reference.
- **`is`**: dictionary. `knows` is the library's core; `claims` is the Icelandic-letter test; `lemmas` covers core, fold table and the guarded suffix fallback; `parts` guards `word in Object.prototype` and the function-verb block list; `stopWords` is the library's list plus the reference's additions; `attribution` is FR-043's text. The stop-lemma list, the additions and the block list load from `languageDataDir`, because FR-045 keeps them out of this repository.

## Contract tests (every pack, `languages/__tests__/helpers/contract.ts`)

A shared suite each pack runs. It covers:

- `lemmas`, `parts` and `queryLemmas` never throw for prototype keys (`constructor`, `__proto__`), empty strings, digits, NFD input or 48-character words.
- Outputs are strings with no `~`; `parts` returns no entry from the pack's own stop list.
- `stopWords` entries are NFC, lowercase and unfolded.
- `version` is non-empty, and changing it changes the analyzer version.
- `load` is idempotent, and a failed load surfaces as a pack error rather than a partial pack.

A new pack also adds golden queries and measures tokens per message and stop-word collisions on real text (FR-046).

**SC-016 check**: The invented dictionary pack, whose words include letters from the Icelandic set, and the English pack pass this suite in public CI, and the Icelandic pack passes it outside CI. Owner decision, 2026-11-10: the throwaway stemmer pack is cut, so the invented pack stands in for a new language.

## Analyzer version

`analyzer/version.ts` hashes enabled pack IDs and versions, stop lists, the fold rule version and the caps. A change is what FR-026 calls token-changing. The writer compares it to `search_state.analyzer` at start, and a mismatch queues reconcile once a backfill chain has finished. The runbook also requests reconcile after a token-changing deploy finishes ([R-11](../research.md#r-11-backfill-reconcile-verify)).
