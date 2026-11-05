# Tasks: Icelandic and English Conversation Search Without a Separate Service

**Input**: `specs/001-conversation-search/`: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md).

**Outside this repository**: The design (§) and its `search-experiments/` scripts: `final/analyze.mjs`, `final/search.mjs`, `final/paging.mjs`, `final/changestream.mjs`, `final/golden2.mjs`, `final/conditions.mjs`, `final/oracle.mjs`, `final/relevance.mjs`, `final/load-local.mjs`, `gen.mjs`, `golden.mjs`, `foldtable.mjs`, `normalize.mjs`. The migration owner supplies the path. Nothing from them that is derived from BÍN enters this repository (FR-045).

**Tests**: Requested. `AGENTS.md`, the spec's scenarios and [quickstart.md](quickstart.md) all require them. Write each test task before the code it covers and see it fail.

**Rules for every code task**: Follow `AGENTS.md`. Run focused Jest from the owning workspace and `npx tsc --noEmit` there. A `misc/` suite is typechecked with `npx tsc --noEmit -p misc/<suite>/tsconfig.json`, because the workspace `tsconfig.json` includes only `src`. No tenant names, hosts or IPs (FR-047). With default configuration, behaviour, data and API contracts stay as today (FR-041).

**Spec Kit on a fresh checkout**: `.specify/feature.json` is gitignored, so set `SPECIFY_FEATURE_DIRECTORY=specs/001-conversation-search` before running `speckit-*` commands.

**Every PR**: Phases merge dark, each as its own PR with `--base aproorg/0.8.8`, passed explicitly, because `pr-retarget-dev.yml` moves PRs opened against `main`. Before each: the default-config test (T039, once it exists), `npm run sort-imports` on changed paths, `npx tsc --noEmit` in each changed workspace, `npm run static-checks -- --against origin/aproorg/0.8.8`, `npm run lighthouse`, and the public repository check (T006).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Different files, no dependency on an incomplete task
- **[Story]**: US1 to US4, from [spec.md](spec.md). **[OP]** marks operator work with no repository code; the record it names lives outside this repository unless it says otherwise.

---

## Phase 1: Setup

**Purpose**: Skeleton and dependency, no behaviour.

- [X] T001 Create empty modules per [plan.md](plan.md)'s tree in `packages/api/src/search/` with `index.ts`, and export it from `packages/api/src/index.ts`
- [X] T002 [P] Add `snowball-stemmers` pinned at exactly `0.6.0`, the version behind the reference tokens (FR-007), to `dependencies` in `packages/api/package.json`, and record its licence in the PR. T045 loads it
- [X] T003 [P] Add `vendor/search-language/` to `.gitignore`, so private language data cannot be committed (R-02)
- [X] T004 [P] Keep private suites out of public CI (FR-045) in three places: add `/misc/` to `testPathIgnorePatterns` in `packages/api/jest.config.mjs`, to both `--testPathIgnorePatterns` values in `packages/api/package.json`, whose command-line value replaces the config's, and to the `pkgapi` filter in `.github/workflows/backend-review.yml`. Add `packages/api/misc/search-quality/tsconfig.json` with relative `extends` and `paths`, modeled on `packages/data-schemas/misc/documentdb/tsconfig.json`. Prove it with `npm run test:ci -- --listTests` in `packages/api`: no `misc/` path is listed
- [X] T005 [P] Create `specs/001-conversation-search/runbook.md` with empty sections: upgrade, backfill, shadow, cutover, rollback, retention, release checklist. It holds no tenant data
- [X] T006 Write the public repository check in `specs/001-conversation-search/runbook.md`: a grep over the diff for the tenant list held outside this repository, plus IP patterns, and a check that no BÍN-derived file is tracked (FR-045, FR-047)

---

## Phase 2: Operator prework (plan stages 0 to 2)

**Purpose**: Answers that can stop or reshape everything after them. T017 must finish before Phase 6 starts and before T021; the owner lifted it for Phase 4's code (see Blocking gates). T022 must finish before T151, and T149's tenant must already be on 8.0. T010 must finish before Phase 3 starts.

- [ ] T007 [OP] Gather per-user message counts per tenant and identify the Azure deployments' database (§10 step 1, FR-031)
- [X] T008 [OP] Closed by owner decision, with no questions sent: the data is used under BÍN's published conditions, and `STOP_LEMMA`, `IS_STOP_EXTRA` and the function-verb block list are treated as BÍN-derived (FR-045). npm lists `lemma-is` and `tokenize-is` as MIT
- [X] T009 [OP] Copy the private language data out of tree, trimmed per §9, including `node_modules/tokenize-is`, the one bare import in `lemma-is/dist/index.mjs`, in the copy and the manifest, and build `fold-table.bin` with `node foldtable.mjs build`. Record upstream's package checksums as provenance (FR-044), and a manifest sha512 over the delivered files for T052, since a trimmed directory cannot match upstream's checksum. T146 copies this built table rather than rebuilding it, so the check holds. No tenant image holds any of it until T011. The copy also holds `STOP_LEMMA`, `IS_STOP_EXTRA` and the function-verb block list, so they stay out of the public repository until T011 records otherwise. Use R-02's layout
- [X] T010 [OP] Check upstream's own search direction before Phase 3 starts and record it. If upstream has shipped or announced a conflicting search, the owner decides in writing whether to continue (§9)
- [X] T011 [OP] Record the owner's decision in FR-043 and FR-045: the attribution goes in the About tab in Settings, and the data may enter tenant images but not this public repository
- [ ] T012 [OP] Write the B4 DocumentDB harness in `search-experiments`, outside this repository, because the existing DocumentDB scripts run the earlier build and `final/` targets local Docker: a B4 loader, latency for the 100k, 20k and 2k users at each floor, both surfaces firing per user, stream load, and load-then-index time (§10 step 3)
- [ ] T013 [OP] Run §10 step 3 in the sandbox on 8.0 and on 5.0 with planner v2, using T012's harness. Record the results in `specs/001-conversation-search/research.md` under R-05, without tenant data
- [ ] T014 [OP] Write sandbox scripts for every [R-05](research.md#r-05-what-the-sandbox-must-also-answer) question in `search-experiments`, outside this repository, because no existing script covers them, including the `$nor` plan, `modifyChangeStreams`, the tie read and the word list rebuild
- [ ] T015 [OP] Run T014's scripts on both engines and record each answer under R-05, without tenant data
- [X] T016 [OP] After T009, generate quality inputs in `search-experiments`, outside this repository: the corpus with `gen.mjs`, the corpus-wide word list, expected index and query tokens from `final/analyze.mjs`, and a small command-line grader over `final/oracle.mjs`'s `grade`, which T055 calls on each first page. About two hours and 20 GB, per `final/run.sh`
- [ ] T017 [OP] Read T013 and T015 against FR-031's stop rules, then get the owner's written verdict on each remaining answer. If streams are ruled out, apply [R-17](research.md#r-17-if-the-sandbox-rules-out-change-streams) and re-plan Phase 6's sync tasks first. Update defaults in `specs/001-conversation-search/contracts/config.md` and R-16. If T025 has already merged, update `loadSearchConfig` and its tests in the same change
- [X] T018 Write the upgrade section of `specs/001-conversation-search/runbook.md`: pre-upgrade snapshot, restore-to-new-cluster path, data-loss window, halt rule for a blocker in rollout, hibernating tenants (FR-031, §8)
- [X] T019 Add a `LIGHTHOUSE_MONGO_URI` option to `e2e/playwright.config.lighthouse.ts`: when set, the server env gets `MONGO_URI: LIGHTHOUSE_MONGO_URI` and `E2E_USE_MEMORY_MONGO: 'false'` (`e2e/setup/start-server.js` reads both), so FR-031's clone run and release reruns measure the target engine, with `E2E_LATENCY_MONGO_DELAY_MS` off since the clone has real latency. `load.spec.ts` seeds a conversation, so point it only at clones. Test that the config output is unchanged when it is unset
- [ ] T020 [OP] In the infrastructure repository, allow the major version upgrade and add the unit inputs on the database module (§8)
- [ ] T021 [OP] Upgrade a clone of the largest tenant. Time the downtime, check the `$type` partial indexes, run `packages/data-schemas/misc/documentdb/*.documentdb.spec.ts`, and run the lighthouse lane with T019's option. On a blocker, follow §8's fallback if it passed T013, otherwise reopen the design
- [ ] T022 [OP] Roll 8.0 out in batches, keeping each pre-upgrade snapshot. A hibernating tenant upgrades on wake-up. A blocker halts rollout, keeps healthy upgraded tenants and reopens the design (FR-031)

---

## Phase 3: Foundational

**Purpose**: Config, storage, errors, record building, analyzer and packs. No user story's main path can start before this ends, though T156 can start after T046. T052 to T056 also need T009's private copy.

### Config and errors

- [X] T023 Add the `search` block to `configSchema` in `packages/data-provider/src/config.ts` per [contracts/config.md](contracts/config.md): `.strict()`, integers with a minimum of 1, `rankWindow` "max 200", `languages` a plain string array, `backend` one of `meilisearch | shadow | search`. Doc comment on each field. Add `search` to `BASE_ONLY_CONFIG_SECTIONS`, so no config document can change it ([R-19](research.md#r-19-config-channel))
- [X] T024 [P] Add a neutral `search` section to `librechat.example.yaml`
- [X] T025 Create `packages/data-schemas/src/app/search.ts` with `loadSearchConfig`, which applies the defaults; add `search` to `AppService` in `packages/data-schemas/src/app/service.ts`, alongside `loadLangfuseConfig`, and to `AppConfig` in `packages/data-schemas/src/types/app.ts`. A cross-field mismatch of `backend` and `data` logs a configuration error and never fails startup (FR-019). Test that a stored config document cannot change `search`
- [X] T026 [P] Add `SearchErrorCode`, `SearchReason`, `SearchMeta`, panel types and response additions in `packages/data-provider/src/types/`, per [contracts/http.md](contracts/http.md)
- [X] T027 Create `packages/data-schemas/src/utils/searchError.ts` with `SearchError` and `isSearchError`, importing the codes from `librechat-data-provider`
- [X] T028 Create `packages/api/src/search/config.ts`: types and helpers for the frozen process snapshot taken from `getAppConfig({ baseOnly: true })` and handed to `createSearchService` (T069)
- [X] T029 [P] Create `packages/api/src/search/metrics.ts` with typed emitters for every event in [contracts/telemetry.md](contracts/telemetry.md), and a test in `packages/api/src/search/metrics.spec.ts` that a sentinel string passed to any emitter never reaches a log. Each owning task below calls its emitter. `search.realtext` fields accumulate here and flush each minute, with these owners: `tokensPerMessage` and `atCap` T046; `tierShare` T062; `prefixFanout` and `vocabRowsTruncated` T082 and T083; `typoSkippedWordExists` T083; `noLetterQueries` and `stopOnlyQueries` T047. T039 extends the sentinel check through routes and the writer (FR-020)

### Storage

- [X] T030 Create `packages/data-schemas/src/schema/messageSearch.ts` for collection `msearch` per [data-model.md](data-model.md): `_id` source `_id`, `user`, `conversationId`, `messageId`, `createdAt`, `n`, `h`, `v`, `e`, `tokens` "At most 3,000", optional `tenantId`. Set `autoCreate: false` and `autoIndex: false`
- [X] T031 [P] Create `packages/data-schemas/src/schema/conversationSearch.ts` for `csearch`, same options
- [X] T032 [P] Create `packages/data-schemas/src/schema/searchVocab.ts` for `search_vocab`: `_id` string, `df`, optional `dfNext`, `r`, same options
- [X] T033 [P] Create `packages/data-schemas/src/schema/searchState.ts` for `search_state`: string `_id`, a loose document for the keys in [data-model.md](data-model.md), same options
- [X] T034 Create the four models in `packages/data-schemas/src/models/{messageSearch,conversationSearch,searchVocab,searchState}.ts`, with `applyTenantIsolation` on `msearch` and `csearch` only, and register them in `packages/data-schemas/src/models/index.ts`
- [X] T035 Test in `packages/data-schemas/src/models/search.spec.ts`: no search collection exists after `createModels` with data off; `tenantIsolation.coverage.spec.ts` still passes
- [X] T036 Add `ensureSearchCollections` and `ensureSearchIndexes` to a new `packages/data-schemas/src/methods/search.ts`, registered in `packages/data-schemas/src/methods/index.ts`: index `{ user: 1, tokens: 1, createdAt: -1 }` named `user_tokens_created` on `msearch`, `{ user: 1, tokens: 1 }` on `csearch`. Backfill and test loaders both call these
- [X] T037 Create `packages/data-schemas/src/models/plugins/indexable.ts` with pure `isIndexableSource(doc, excludePath)`: "explicit" means the stored temporary flag is present and non-null, and `unfinished` excludes. Export `buildIndexableQuery` from `mongoMeili.ts`. Leave the plugin's behaviour unchanged. Test in `indexable.spec.ts` that the predicate agrees on stored rows with the query plus `unfinished: { $ne: true }`, a clause the plugin's query does not have, and that plain objects never throw (R-03)
- [X] T038 Create `packages/data-schemas/src/types/search.ts` with plain record types and `SearchPort` (`conversationMatches`, `titleMatches`). Bind the port lazily: add a `getSearchPort` dep to `createMethods` in `packages/data-schemas/src/methods/index.ts`, supplied in `api/models/index.js`, with a `setSearchPort` beside it. `createMethods` runs at require time, before config loads, so methods call the getter, which returns `null` until the service is set. Do not change any default path
- [X] T039 Create `packages/api/src/search/http/defaults.spec.ts` with what Phase 3 can assert: no search collection is created, and `loadSearchConfig` gives today's behaviour. Named later tasks extend it: T069 (the service answers `null`), T071, T073 and T093 (no response gains a field, with route-level assertions in `api/server/routes/__tests__/`), T124 (no pack loads, no writer starts), T125 (`/enable`), T127 (no detached run, and the sentinel check through routes and the writer)

### Analyzer and packs

- [X] T040 Create `packages/api/src/search/analyzer/fold.ts` as a port of `normalize.mjs`'s `fold`, with the rule version exported
- [X] T041 [P] Create `packages/api/src/search/analyzer/words.ts`: NFC, `[\p{L}\p{N}\p{M}]+`, lowercase, words "over 48 characters" dropped before folding (FR-007)
- [X] T042 Create `packages/api/src/search/languages/pack.ts` with the `LanguagePack` interface from [contracts/language-pack.md](contracts/language-pack.md), and `languages/registry.ts`. An unregistered ID is a pack failure in the service, not a startup failure
- [X] T043 Create `packages/api/src/search/analyzer/version.ts`: hash of enabled pack IDs and versions, stop lists, fold rule version and caps. Test in `version.spec.ts` that each change alters the hash (FR-026)
- [X] T044 Create the shared contract suite in `packages/api/src/search/languages/__tests__/helpers/contract.ts` per [contracts/language-pack.md](contracts/language-pack.md), and a fake dictionary pack in `languages/__tests__/helpers/fakeDictionary.ts`, for public CI. Run it for the fake pack in `languages/__tests__/fakeDictionary.spec.ts`
- [X] T045 Create `packages/api/src/search/languages/en/index.ts`: stemmer pack, Snowball through a dynamic import inside `load`, so no pack loads with search data off (FR-030), and the reference's English stop list. Run the contract suite in `languages/__tests__/en.spec.ts`
- [X] T046 Create `packages/api/src/search/analyzer/analyze.ts` with shared routing steps 1 to 6 from [contracts/language-pack.md](contracts/language-pack.md), a bounded `analysisCacheWords` LRU, the "3,000 tokens" cap, and batch analysis that yields to the event loop. Test in `analyze.spec.ts` with the fake dictionary and `en`: a timer scheduled before a large batch fires before the batch ends, routing, `constructor`, `node_modules`, `.NET`, NFD, stop words on the unfolded surface, the mixed-language case, compound parts in the combined stop list dropped, a long message stopping at the cap, a word over 48 characters neither indexed nor queried
- [X] T047 Create `packages/api/src/search/analyzer/query.ts`: query-side analysis per `queryWord` in `final/analyze.mjs`, with the query word never split, stop words removed before the last word is chosen, and `queryWordLimit` applied after stop-word removal. Test in `query.spec.ts`: `mál` does not expand through `mal`, no-usable-words versus only-stop-words, a query over the limit using its first words

### Records

- [X] T048 Create `packages/api/src/search/sync/extract.ts`: text via `parseTextParts(content, false, { includeSteer: true })` else `text`, taken by field name, never `contextMeta`, `summary`, `metadata.thoughtSignatures` or tool output, never logging a document. `h` over text, `user`, `conversationId`, `createdAt`; conversations over title, tags, `user`, `conversationId` (FR-008, FR-022). Test that a sentinel held only in `contextMeta` and tool output never reaches the output, that thinking and steer text do, and that nothing matches on sender, user or ID fields (FR-008)
- [X] T049 Create `packages/api/src/search/sync/record.ts` with `buildMessageRecord` and `buildConversationRecord` from a source document through the analyzer, used by sync, jobs and test loaders. Add `packages/api/src/search/__tests__/helpers/loader.ts`, which loads sources into records and seeds `search_vocab` for read tests, from the loaded records by default or from a vocabulary file the caller names (T055), and can seed a passed verification record (T075)

### Icelandic pack and parity

- [X] T050 [P] Create `packages/api/src/search/languages/is/foldTable.ts`, porting the sorted-buffer lookup from `foldtable.mjs`
- [X] T051 [P] Create `packages/api/src/search/languages/is/NOTICE.md` with all changes to the data under CC BY-SA 4.0 and the derived table's own notice (FR-043, FR-044)
- [X] T052 Create `packages/api/src/search/languages/is/index.ts` with `load`: `import(pathToFileURL(entry).href)` of the ESM-only library from `languageDataDir`, T009's manifest sha512 checked inside `load`, after the server listens, against a constant `IS_DATA_SHA512` in this file (T150 measures its cost). With no directory or a wrong checksum, it fails as a pack failure. Create `packages/api/misc/search-quality/jest.config.mjs` and a `test:search-quality` script in `packages/api/package.json` that runs it with `cross-env NODE_OPTIONS=--experimental-vm-modules`, since a Jest config can't set Node flags for its own process. Prove the import works from the built `dist/index.cjs`, in a test run that way, before the tasks after it
- [X] T053 Add to `languages/is/index.ts`: `knows` as core, `claims` as the Icelandic-letter test, `lemmas` over core, table and guarded suffix fallback with the `STOP_LEMMA` filter, `queryLemmas` over the fold table. `STOP_LEMMA` loads from `languageDataDir` and enters this repository only after T011 records that it isn't BÍN-derived
- [X] T054 Add to `languages/is/index.ts`: `parts` guarding `word in Object.prototype` plus the function-verb block list, `stopWords` as the library's list plus `IS_STOP_EXTRA`, `attribution` as FR-043's text. `IS_STOP_EXTRA` and the block list load from `languageDataDir` and enter this repository only after T011 records that they aren't BÍN-derived
- [X] T055 Create the runner in `packages/api/misc/search-quality/`, under T052's config and script, reading from the environment `SEARCH_QUALITY_CORPUS` (from `gen.mjs`), `SEARCH_QUALITY_DIR` (T016's output: queries, conditions, expected tokens and the grader), `SEARCH_QUALITY_VOCAB` (the corpus-wide word list from T016, because the reference loads sample users but takes `search_vocab` from the whole corpus, per `final/load-local.mjs`), `SEARCH_QUALITY_MONGO_URI` (a local MongoDB 8.0, as `final/run.sh` starts) and `SEARCH_LANGUAGE_DATA_DIR`. It carries its own pass, top and precision scoring, as `final/relevance.mjs` defines them, since that script exports nothing, and calls T016's grader as a child process. Its config adds a transform that leaves `import()` untouched. Commit only the runner. First checks: index tokens equal T016's `final/analyze.mjs` output on the corpus and query tokens equal its `queryWord` output (FR-007)
- [X] T056 Run the contract suite for the `is` pack in `packages/api/misc/search-quality/is.contract.spec.ts`

**Checkpoint**: Analyzer matches the reference, with `is` out of tree and `en` in CI. Records can be built from text and loaded for tests.

---

## Phase 4: User Story 1 - Find a word in any form (Priority: P1) 🎯 MVP

**Goal**: One word in any form finds true matches on `/search` and the sidebar.

**Independent Test**: Load the padded corpus through the analyzer into records, run the inflection, compound and no-accent queries as the test user through the service ([quickstart.md](quickstart.md) §3).

### Tests

- [X] T057 [US1] Add single-word quality checks to `packages/api/misc/search-quality/`: US1 scenarios 1 to 6. First page means `/search`'s page, and top 200 and top 1,000 mean the ranked shared read at `sidebarLimit` 200 and 1,000 ([R-13](research.md#r-13-quality-suite-and-public-ci))
- [X] T058 [P] [US1] Test in `packages/data-schemas/src/methods/search.spec.ts` with `mongodb-memory-server`: every read requires `user`, windows never project `tokens`, reads pass `singleBatch`, `batchSize` equal to the limit, `maxTimeMS` and the index hint, and a second user never appears
- [X] T059 [P] [US1] Test in `packages/api/src/search/http/messages.spec.ts`: hits drop for a temporary, subagent, unfinished or expired message in a visible conversation; hits for a hidden conversation drop; rendered fields match today's; private fields never leave (FR-014); `pageSize` is ignored. With the default backend the handler returns `null`
- [X] T060 [P] [US1] Test in `packages/api/src/search/read/plan.spec.ts` with the loader, the fake pack and `en`: tiers in order and stopping once the page can fill, a token missing from the word list still read and found, rare and common job split, a compound-only match ranking below the word itself (US1 scenario 6), and rank order in `rank.spec.ts`, including `rank.lengthBucket: false`

### Reads

- [X] T061 [US1] Add plain-typed reads to `packages/data-schemas/src/methods/search.ts`: `readVocabFrequencies`, `readVocabRange` (bounded), `readRecordWindow`, `readRecordTokens` (by `_id`, in chunks of 50), `readConversationRecords`, `readMessageTexts` (canonical text fields only), `getSearchableMessages(user, messageIds)` with the message-level indexable query plus `unfinished: { $ne: true }` and `CLIENT_MESSAGE_SELECT`, `getSearchHitConversations(user, ids)` with the two visibility filters and no slice or shared-flag read
- [X] T062 [US1] Create `packages/api/src/search/read/plan.ts` and `read/tiers.ts`, porting `final/search.mjs` for exact, lemma and part tiers: `df` read, rare tokens sharing one `$in` job (threshold 300), each common token its own job, at most `readConcurrency` reads at once, stop once the page can fill, a token missing from the list still read. Output carries the frozen plan. Emit `tierReached`, `reads`, `rows`
- [X] T063 [US1] Create `packages/api/src/search/read/rank.ts`: words matched, tier weighted by rarity, the length bucket under `rank.lengthBucket`, newest (FR-011), constants with comments per R-16
- [X] T064 [US1] Create `packages/api/src/search/read/window.ts` per [R-08](research.md#r-08-shared-read): single-flight by tenant, user and normalized query, 30-second TTL, `sharedReadMaxBytes`, read order tags, pure surface derivation
- [X] T065 [US1] Add refcounted waiters to `read/window.ts`. Test in `window.spec.ts`: the same first page whichever surface fired first at limits 200 and 1,000; one waiter leaving does not fail the other; the read aborts when the last leaves; failures are not stored
- [X] T066 [US1] Create `packages/api/src/search/read/titles.ts`: `csearch` reads for exact, lemma and part tiers, all words, up to the 1,000 hit limit, outside the serving cap (FR-009, FR-017). Test in `titles.spec.ts`
- [X] T067 [US1] Create `packages/api/src/search/read/retry.ts` with one wrapper every search read goes through, including `df`, word list ranges, windows, `readRecordTokens`, `readMessageTexts`, title reads and both hydration reads: the signal, `maxTimeMS` and `searchTimeoutMs` applied, retry of code 2 "Cannot open a new cursor" twice with jitter, then `search_busy`; emit `search.cursor_error`. Title reads stay outside the serving cap but not outside the timeout (FR-018). Test in `retry.spec.ts`
- [X] T068 [US1] Create `packages/api/src/search/read/limiter.ts`: fail at `maxConcurrentSearches` at once, stop at `searchTimeoutMs`. Test in `limiter.spec.ts`, including that a concurrency assertion holds `readConcurrency`
- [X] T069 [US1] Create `packages/api/src/search/service.ts` with `createSearchService(deps)`: holds the config snapshot, limiter and shared read, routes by backend, answers `null` for Meilisearch, and holds `packState` (`loading`, `loaded`, `failed`): `loading` returns `search_busy`, while `failed`, or data off, returns `search_failed`, and a shadow run is skipped in any state but `loaded`, so no search runs on an analyzer without packs. Test in `service.spec.ts`, and extend T039
- [X] T070 [US1] Create `packages/api/src/search/http/context.ts` with `createSearchContext(req, res)`: session user, a signal that fires on `res` close only when `res.writableFinished` is false, a timer, no config read. Create `http/errors.ts` with `searchErrorResponse`. Tests cover a normally completed response and a real disconnect

### Surfaces

- [X] T071 [US1] Create `packages/api/src/search/http/messages.ts` with `searchMessagesRoute(ctx, query, cursor)`, starting `getSearchableMessages` and `getSearchHitConversations` in parallel, emitting `search.request` with `backend: search`, `coldAfterIdle` and `isLargestUser` from `shadow.largestUserId`. It returns `nextCursor: null` until T088 adds paging. Extend T039. Wire the `search` branch in `api/server/routes/messages.js`, adding only the call. Default-backend tests in `api/server/routes/__tests__/messages-get.spec.js` stay unmodified
- [X] T072 [US1] Add the `SearchPort.conversationMatches` branch and `searchContext` option to `getConvosByCursor` in `packages/data-schemas/src/methods/conversation.ts`, rethrowing `SearchError` from the search catch, and pass `partial` and `reason` through. A `null` answer runs today's code unchanged
- [X] T073 [US1] Wire `api/server/routes/convos.js` and `packages/api/src/search/http/conversations.ts`: build the context when `search` is present, map `SearchError`, emit `search.request` and `search.partial` on a failed message read. Sidebar union and sort per FR-015; `sidebarLimit` caps the message window only. Tests for US1 scenario 7, with a lowered limit. Extend T039
- [X] T074 [US1] Create `packages/api/src/search/start.ts`, with two functions called from `api/server/index.js` and `api/server/experimental.js`. `bindSearch()` runs after `getAppConfig({ baseOnly: true })` and before listen, so no request meets an unbound port: create the service with `JWT_SECRET` passed in, bind it with `setSearchPort`, and set `app.locals.search`, which routes read. `startSearchBackground()` is called un-awaited after the server listens, outside the post-listen `try` whose rejection calls `process.exit(1)`, with its own `.catch` logging safe metadata, so a search failure can't crash the process or delay readiness. With search data on, it loads enabled packs (FR-030), emitting `search.pack` with `id`, `state`, `ms` and `rssDelta` for each pack, including a failed `en` pack or an unregistered ID. `/api` only gains the call
- [X] T075 [US1] Create `packages/api/src/search/http/status.ts` with the `search` row of `/enable` in [contracts/http.md](contracts/http.md), reading `verification` through a new `readSearchState` method, and call it from `api/server/routes/search.js`, where other backends keep today's code, so the client shows the search field on `backend: search`. Test the row in `http/status.spec.ts`

**Checkpoint**: With `backend: search` on a loaded test database, with packs loaded and `/enable` true, US1's scenarios pass and SC-001's single-word queries are measurable. A real tenant also needs Phase 6's sync.

---

## Phase 5: User Story 2 - Harder queries, older matches, clear states (Priority: P2)

**Goal**: Typos, prefix, multi-word, natural language, load-more, shared links and clear states.

**Independent Test**: Run the query scenarios; page through a word with thousands of matches; force a busy error and a stop-word-only query ([quickstart.md](quickstart.md) §4).

### Tests

- [ ] T076 [US2] Add the rest of SC-001 to SC-004 to `packages/api/misc/search-quality/`, including condition H's loader, the 20 flood-prone queries through T016's grader, the accepted-gap queries `hvad kostadi radgjafinn` and `for`, the guard comparing concatenated load-more to the reference, and R-07's paging on the padded corpus with writes and a word list flush between pages. Record any difference; a re-baseline needs FR-034's written decision
- [ ] T077 [P] [US2] Test in `packages/api/src/search/read/page.spec.ts`, against an independent oracle on a static-word-list fixture: no duplicates and nothing lost for single and multi-word queries, and `nextCursor` stays non-null when filtering empties a page. Cases per [quickstart.md](quickstart.md) §4: same-date runs across and beyond a window, writes above and below the anchor, a late record pushing a served row, a message edited, deleted or hidden between pages, a `df` change that would move the driver, the oracle applying the same byte budget as the plan, an exact match after a typo-only page 1, reaching the prefix tier from a common word, rows of 3,000 tokens, several common tokens, and more late rows than a window holds
- [ ] T078 [P] [US2] Test in `packages/api/src/search/read/cursor.spec.ts`: a decoded cursor reveals no token; tampering, another user's cursor, another query, another backend and a bad field type each return `search_cursor_invalid`; worst-case URL at most 7.5 KB with the longest allowed query; a long NFD query keeps its `qh` on page 2; the prefix budget also stops at 1.5 KB of deflated plan when expansions are frozen, most frequent first, so the URL always fits (R-06)
- [ ] T079 [P] [US2] Test in `packages/api/src/search/read/harder.spec.ts` with the loader, the fake pack and `en`: typo for a word that matches nothing and not otherwise, prefix on the last word only and inside its budget, a stop word removed before the last word is chosen, all words required, trailing words dropped with fuller matches first, `xyzzy kerfi` returning nothing, natural-language stop words, the same on titles and tags (FR-009), `only_stop_words` on every surface. Test `read/proximity.ts` in `proximity.spec.ts`
- [ ] T080 [P] [US2] Test each FR-018 row in `packages/api/src/search/http/errors.spec.ts`, plus `api/server/routes/__tests__/` route tests: coded body, no raw text, through the search catch in `getConvosByCursor`, both the inner and the outer catch in `getSharedLinks` and both routes. Include a failed pack as `search_failed`, and for each read kind a cursor limit and a timeout as `search_busy`, including title and hydration reads (FR-018)
- [ ] T081 [P] [US2] Extend `client/src/routes/__tests__/Search.spec.tsx`: busy, failed, stop-word, restart and load-more states, keyboard use, announcements to assistive technology, a failed later page keeping results, a short page auto-fetching then showing the button, a repeated `messageId` shown once, no query-layer retry on `search_busy`, no focus refetch with more than one page, and today's toast with no new state on the default backend (FR-041)

### Harder queries

- [ ] T082 [US2] Add the prefix tier in `packages/api/src/search/read/tiers.ts`: last word only, expansions read once when first reached and then frozen, budgets from config, `maxVocabRows` bounding the range read, count truncation for `search.realtext`
- [ ] T083 [US2] Create `packages/api/src/search/read/typo.ts`: Damerau-Levenshtein per `final/search.mjs`, first letter fixed, length bands, `typo.maxCorrections`, `typo.maxVocabRows`, only for a word that matches nothing, count truncation for `search.realtext`
- [ ] T084 [US2] Add multi-word reads to `packages/api/src/search/read/plan.ts`: AND driven by the rarest, trailing words dropped when the page cannot fill, and `read/proximity.ts` over the top 50 using `readMessageTexts`. Masks fetched lazily (R-06, R-08)
- [ ] T085 [US2] Extend `packages/api/src/search/read/titles.ts` with prefix, typo and all-words matching, sharing expansions from the shared read (FR-009)
- [ ] T086 [US2] Return `reason: only_stop_words` on every search surface from `packages/api/src/search/service.ts`, and the ordinary empty state for a query with no usable words (FR-012)

### Load-more

- [ ] T087 [US2] Create `packages/api/src/search/read/cursor.ts` per [R-06](research.md#r-06-paging-model): the `s1.` prefix, deflate, AES-256-GCM with a key derived by HKDF from a secret passed in by the caller (`JWT_SECRET`, read in the T074 helper) and a search-specific label, user ID as associated data, 5-byte ID hashes, a type check on every field, and `qh` over `query.normalize('NFC').slice(0, 256)`, the same rule the client uses
- [ ] T088 [US2] Create `packages/api/src/search/read/page.ts` per R-06: page 1 from the read plan, then the single-word walk by stage, tier and job excluding `first`, `$nin` on earlier jobs and higher tiers. Non-null `nextCursor` whenever more may exist. `http/messages.ts` uses it
- [ ] T089 [US2] Add to `read/page.ts`: windows re-read by range, the same-date run as its own window, and the overflow rule (R-06)
- [ ] T090 [US2] Add to `read/page.ts` multi-word paging per [R-07](research.md#r-07-multi-word-paging), with `$nor` on earlier stages
- [ ] T091 [US2] Reject the `s1.` prefix on the Meilisearch branch through a `packages/api` helper called from `api/server/routes/messages.js`. Test on both `meilisearch` and `shadow`, and that any other cursor behaves as today

### Shared links

- [ ] T092 [US2] Add `deps` to `createShareMethods` and the `SearchPort.titleMatches` branch to `getSharedLinks` in `packages/data-schemas/src/methods/share.ts`. `SearchError` must pass through both the inner catch, which turns search errors into an empty result, and the outer catch, which rewraps them as `ShareServiceError`. A `null` answer keeps today's behaviour, including its empty 200 on error. Tests in `share.test.ts` that `SearchError` passes each catch
- [ ] T093 [US2] Create `packages/api/src/search/http/shares.ts`, emitting `search.request`, and in `api/server/routes/share.js` spread `reason` and map `SearchError` in the catch, which today returns `{ message }` with 500. Route tests for US2 scenario 9, and extend T039

### Client

- [ ] T094 [P] [US2] Pass React Query's `signal` through `listMessages` and `listConversations` in `packages/data-provider/src/data-service.ts` and `client/src/data-provider/queries.ts`, so a superseded query closes its request. In `useMessagesInfiniteQuery`, on a request with a cursor, send `search.normalize('NFC').slice(0, 256)`. Test both in `client/src/data-provider/`. Add a shared `shouldRetrySearch(error)` predicate in `client/src/data-provider/`, returning false on `search_busy` and `search_cursor_invalid`
- [ ] T095 [US2] Create `client/src/components/Search/{BusyState,FailedState,PartialState,StopWordHint,LoadMore,CursorRestart}.tsx` with `@librechat/client` primitives, semantic roles, `useLocalize` and ARIA live announcements. Add English keys only to `client/src/locales/en/translation.json` (FR-042)
- [ ] T096 [US2] Update `client/src/routes/Search.tsx`: map codes to those states, including 414 to restart, keep today's toast for the default backend, auto-fetch a short page up to 3 times then show `LoadMore`, drop a repeated `messageId`, use `shouldRetrySearch`, no focus refetch with more than one page
- [ ] T097 [US2] Show partial, stop-word, busy and failed states in `client/src/components/UnifiedSidebar/ConversationsSection.tsx`, using `shouldRetrySearch`, with focused tests, including the partial state\'s announcement to assistive technology and that the default backend shows none of them (FR-041)
- [ ] T098 [US2] Show partial, stop-word, busy and failed states in `client/src/components/Nav/SettingsTabs/General/ArchivedChatsTable.tsx`, using `shouldRetrySearch`, with focused tests, including the partial state\'s announcement to assistive technology and that the default backend shows none of them (FR-041)
- [ ] T099 [US2] Show stop-word, busy and failed states in `client/src/components/Nav/SettingsTabs/Data/SharedLinks.tsx`, using `shouldRetrySearch`, with focused tests, including that the default backend shows none of them (FR-041)

**Checkpoint**: All of `/search`, the sidebar, Archived Chats and shared links work with `backend: search` on a loaded test database. SC-001 to SC-004 pass ([quickstart.md](quickstart.md) §3).

---

## Phase 6: User Story 3 - Operator migrates tenants on numeric gates (Priority: P3)

**Goal**: Sync, backfill, reconcile, shadow, cutover and rollback, decided by numbers.

**Independent Test**: On a non-production tenant, run backfill, shadow and cutover, then roll back at each stage ([quickstart.md](quickstart.md) §7).

### Tests

- [ ] T100 [US3] Test in `packages/api/src/search/sync/writer.spec.ts` with `MongoMemoryReplSet`, covering §9's list and [quickstart.md](quickstart.md) §5: insert, edit, metadata-only, `bulkWrite`, `updateMany` to temporary, a single-message temporary flip, tag rename and deletion, title edit, subagent and unfinished, finishing a message, external `deleteMany`, resume, TTL delete with the TTL monitor tuned to run faster than its default minute, a null `fullDocument` on an update treated as a delete, and a `replace` event treated as a full change (R-09)
- [ ] T101 [P] [US3] Test in `packages/api/src/search/sync/fencing.spec.ts` with `MongoMemoryReplSet`: takeover within the configured time, a paused writer's stale write, last event per `_id`, an edit and its `_meiliIndex: true` bookkeeping event in one batch still writing the record, a poison event skipped with an alarm, an oversized event and an invalidate event as gaps, a resume failure restarting at the current position and queueing reconcile, `_meiliIndex: true` skipped with no record read, a second non-null `tenantId` stopping the writer, a stalled writer tripping `search.sync_status`, a failed pack not taking the lease
- [ ] T102 [P] [US3] Test in `packages/api/src/search/jobs/jobs.spec.ts`: backfill crash resume, sync record wins, a stored row with `subagentTask` leaving no record after backfill, repair or the source check and not counted by verification, a batch read before a delete or a turn to temporary leaves no record, pause and resume; reconcile reports before repair, loses to a live edit, resumes from any phase and pass; rebuild keeps a word arriving mid-walk and resumes in any pass; verification ignores a chat deleted between walks and an import in the lag window, and fails on a real gap; a rolling analyzer change matches by exact form until rewritten; attribution state set and cleared. Under `TENANT_ISOLATION_STRICT=true`, every job runs, and a record written by sync or backfill keeps its source's `tenantId` and reads back in that tenant's context
- [ ] T103 [P] [US3] Test in `packages/api/src/search/jobs/drop.spec.ts`: `drop` removes only the four search collections, refuses while search data is on, and exports panel facts first when asked. In `script.spec.ts`, once T130 lands, test `panel`'s tally per round
- [ ] T104 [P] [US3] Test in `packages/api/src/search/jobs/runner.spec.ts`: a request reaches only the lease holder, the chain backfill → indexes → word list → reconcile → verify, a holder killed between any two steps with the next holder resuming at that step, no reconcile from a first start, a gap, a token change or the timer before the chain has finished, the mismatch loop reconciling and failing to the owner after three rounds, the monthly timer, reconcile skipping its `vocab` phase only with no repairs, and that a token change at writer start queues reconcile
- [ ] T105 [P] [US3] Extend `packages/api/src/search/http/status.spec.ts` to the whole `/enable` table in [contracts/http.md](contracts/http.md), including a pass older than `invalidatedAt`, a failed pack, `meiliResyncPending` with an aborted message written after the full sync, restarts from `shadow` or `search` to `meilisearch`, `data` off then on, and the status cache. Test `/api/search/meta`: default `{}`, data on, after a pack is disabled, panel eligibility
- [ ] T106 [P] [US3] Test in `packages/api/src/search/shadow/runner.spec.ts`: Meilisearch's response is unaffected by a failed or slow detached run; a completed response leaves it alive; a real disconnect stops it; the limiter covers detached title reads and counts drops; load-more fires none; shadow with data off fires none (FR-019); logs hold no text. Route tests in `api/server/routes/__tests__/`: each of the three surfaces starts one detached run on `shadow`, none on `meilisearch`
- [ ] T107 [P] [US3] Test in `packages/api/src/search/shadow/panel.spec.ts`: 404 unless `shadow` and listed; only `verdict` and `knownMissed` stored; the round in the key; `compare` reports `state` as `ok`, `dropped` or `failed`, strips private fields on both sides, and logs no query text

### Sync

- [ ] T108 [US3] Add `watchSearchSources({ resumeToken, signal })` and record, lease and state methods to `packages/data-schemas/src/methods/search.ts`: plain events, opaque IDs, `fullDocument: 'updateLookup'`, a filter to the two collections, the `$project` dropping `updateDescription.updatedFields.content` and `.text`. Source reads run in `runAsSystem`, through one shared projection that includes `+subagentTask`, because the schema has `select: false` on it and `isIndexableSource` would otherwise see it as unset. Record writes go through `tenantSafeBulkWrite` in `runAsSystem` using only `replaceOne` and `insertOne`, whose documents carry the source's `tenantId` through unchanged. Never write a record with `$set`, because the wrapper strips `tenantId` from update operators and an upserted record would lose it. Backfill and reconcile use the same methods ([R-04](research.md#r-04-one-tenant-per-database))
- [ ] T109 [US3] Create `packages/api/src/search/sync/lease.ts` per [R-09](research.md#r-09-sync-writer): holder, epoch, `leaseUntil`, heartbeat at a third of `syncTakeoverSeconds`, acquired only with packs loaded, released on a pack failure, emitting `search.lease`
- [ ] T110 [US3] Create `packages/api/src/search/sync/apply.ts`: one pass per batch, dropping `_meiliIndex: true` updates first and then taking the last event per `_id`, one read of `h`, `v` and `e`, an unordered bulk of guarded upserts and deletes via `sync/record.ts`, `e` raised during replay until the stream passes the takeover time, the source check after a batch if the lease was lost
- [ ] T111 [US3] Create `packages/api/src/search/sync/stream.ts`: resume from the saved position, save `postBatchResumeToken` conditional on epoch, treat a resume failure, an oversized event's error and an invalidate as a gap (alarm with `search.sync_gap`, restart at the current position, queue reconcile only if the `chain` key has a `finishedAt`, since the chain's own backfill and reconcile cover a gap before that). When T115 sees `data` go from off to on, it discards the saved token and treats it as a gap, so the writes made while off aren't replayed. Test both. Emit `search.sync_lag`
- [ ] T112 [US3] Create `packages/api/src/search/sync/vocab.ts`: in-memory merge, `$inc` flush every `vocabFlushSeconds`, writer stamps `r` during a rebuild (FR-025, [R-10](research.md#r-10-vocabulary-upkeep-and-rebuild)). `df` only increments here, and reconcile corrects it. Test in `sync/vocab.spec.ts`: the flush interval, no per-message write, and writes from the writer only
- [ ] T113 [US3] Create `packages/api/src/search/sync/writer.ts`: `runAsSystem`, the loop over `stream` and `apply`, bounded retry then skip with `search.sync_skip`, tenant pin, analyzer check at start that writes a baseline and queues nothing when no record exists or the `chain` key has no `finishedAt`, and otherwise queues reconcile through `jobRequest:<id>` on a token change, records attribution text and URL in `search_state.analyzer` and sets `attributionUntilReanalyzed` when a pack with attribution left, and a per-minute `search.sync_status` from every process with data on
- [ ] T114 [US3] Start `indexSync` only when `MEILI_HOST` and `MEILI_MASTER_KEY` are set, through a `packages/api` helper. Add a test in `api/db/indexSync.spec.js`, and confirm the app starts with `MEILI_HOST` unset by running it ([quickstart.md](quickstart.md) §1) Add a `--yes` flag to `config/reset-meili-sync.js` that skips both prompts and exits when done, since a one-off task has no TTY and the script otherwise hangs, with a test
- [ ] T115 [US3] Create `packages/api/src/search/sync/observed.ts`, called from T124's startup path: each process, in the background after it listens, reads `search_state.observed`. A default tenant's read finds nothing and it writes nothing, so no collection appears. With state present, moving to `meilisearch` from `shadow` or `search`, or `data` going off, sets `invalidatedAt` per [R-11](research.md#r-11-backfill-reconcile-verify). With data on, after `ensureSearchCollections`, it upserts `observed`, which is how the first value gets written. Test the default tenant, and with no seeded state: start, restart, roll back, then expect invalidation (FR-037)

### Jobs and status

- [ ] T116 [US3] Create `packages/api/src/search/jobs/vocabRebuild.ts` per R-10: run number, walk by `_id`, `$inc dfNext` with `r`, resumable copy to `df`, delete unstamped rows
- [ ] T117 [US3] Create `packages/api/src/search/jobs/backfill.ts` per R-11 and §9: page by `_id` at `jobs.batchSize` and `batchDelayMs`, unordered inserts ignoring duplicates via `sync/record.ts`, the post-write source check, saved position, a pause flag, emitting `search.backfill`
- [ ] T118 [US3] Create `packages/api/src/search/jobs/reconcile.ts` per R-11: `pass` and `phase` with one `lastId` each, count first and log `search.reconcile`, then repair by compare-and-set on `h` and `v`, insert-only for missing, then the source check, then `vocabRebuild`. Clears attribution state when no older `v` remains
- [ ] T119 [US3] Create `packages/api/src/search/jobs/verify.ts` per R-11: by ID, age from source `_id`, older than 60 s at the snapshot, recheck mismatches, per-user counts, emitting `search.verify`
- [ ] T120 [US3] Create `packages/api/src/search/jobs/runner.ts`: only the lease holder runs jobs, in `runAsSystem`, with T108's write path. It polls `jobRequest:<id>` and dispatches `backfill`, `pause`, `resume`, `reconcile` and `verify`. A request is deleted only after its job's state, or `chain`, is written, so a crash can't lose it. Backfill starts only by request, so the operator chooses when load begins
- [ ] T121 [US3] Add to `jobs/runner.ts` the chain backfill → `ensureSearchIndexes` → `vocabRebuild` → reconcile → verify, the three-round mismatch loop with an alarm, and the `reconcileDays` timer. The `chain` state key records `requestId`, `step` and `finishedAt`, and each new lease holder resumes from it. The timer fires only after `finishedAt`, so reconcile can't act as an unrequested backfill. In the chain, reconcile skips its `vocab` phase when it made no repairs, because the word list step just ran
- [ ] T122 [US3] Create `packages/api/src/search/jobs/drop.ts`, running in `runAsSystem`, which exports panel facts first when asked
- [ ] T123 [US3] Create `config/search-job.js` with `status` (including distinct `tenantId` values), `backfill`, `pause`, `resume`, `reconcile`, `verify` and `drop`, with its reads in `runAsSystem`. `drop` runs in the script, and `status` only reads. The others write `jobRequest:<id>`. Test `status` in `packages/api/src/search/jobs/script.spec.ts`
- [ ] T124 [US3] Extend `startSearchBackground()` from T074, which still runs after the server listens, while `bindSearch()` stays before listen. In order: `sync/observed.ts`'s read in every process; with search data on, after packs load, `ensureSearchCollections`, so the lease write cannot create `search_state` implicitly, then `observed`'s upsert, then the writer and `jobs/runner.ts`. Backfill still starts only by request. Test both functions' order in `start.spec.ts`, and that a rejection leaves the process up, and extend T039
- [ ] T125 [US3] Extend `packages/api/src/search/http/status.ts` to the rest of `/enable` per the table, replacing the health check in `api/server/routes/search.js`, with `statusCacheSeconds`, a 60-second cached check of `getSyncProgress` on both models, passed as a dep as `api/db/indexSync.js` uses it, under `meiliResyncPending`. The gate passes per model on `pendingIndexing === 0 && pendingCleanup === 0 && totalDocuments - totalProcessed <= MEILI_SYNC_THRESHOLD`, not on `isComplete`, because one aborted message or unacknowledged save makes `isComplete` false with nothing left to clear it, and it isn't re-checked in that process once passed. Add a Meilisearch client only when configured. Extend T039
- [ ] T126 [US3] Add `GET /api/search/meta` in `packages/api/src/search/http/status.ts` and `api/server/routes/search.js`, reading attribution from enabled packs and from `search_state.analyzer` after a disable, so shared code names no language

### Shadow and panel

- [ ] T127 [US3] Create `packages/api/src/search/shadow/runner.ts`: the detached run from `http/*` on all three surfaces under `shadow.maxConcurrent`, emitting `search.request` with `detached: true` and `search.shadow`, and `shadow/route.ts` with a wrapper called from the Meilisearch branch of `api/server/routes/messages.js`, the search path of `convos.js` and `share.js`. On `shadow` it builds the context, emits `search.request` for the Meilisearch-served search, and starts the detached run. On `meilisearch` it emits nothing and runs today's code (FR-041). Extend T039
- [ ] T128 [US3] Create `packages/api/src/search/shadow/probe.ts` per [R-14](research.md#r-14-metrics-and-alarms): dedicated probe users with synthetic sentinels for temporary, subagent, tool output, server-private `contextMeta` and another user, through the service including the detached path, with cleanup, emitting `search.probe`. The subagent sentinel is also checked by reading `msearch` directly, because display filters would hide a bad record. Add `probe` to the runner's dispatch and to `config/search-job.js`. Test that a planted leak is caught
- [ ] T129 [US3] Move the Meilisearch hydration in the `search` branch of `api/server/routes/messages.js` into `packages/api/src/search/http/meili.ts`, which the route calls, so the private-field stripping stays in one place. Default-backend tests stay unmodified
- [ ] T130 [US3] Create `packages/api/src/search/shadow/panel.ts` and panel routes in `api/server/routes/search.js` per [contracts/http.md](contracts/http.md), with `panel/compare` calling `http/meili.ts` and running the new search under `shadow.maxConcurrent`. Verdicts stored under `panel:<round>:<uuid>` with only `verdict` and `knownMissed`. Add the `panel` tally to `config/search-job.js`
- [ ] T131 [US3] Add `/api/search/meta` and panel endpoints to `packages/data-provider/src/api-endpoints.ts`, services to `data-service.ts` and keys to `keys.ts`, plus React Query hooks in `client/src/data-provider/`
- [ ] T132 [US3] Create `client/src/components/Nav/SettingsTabs/About/Attribution.tsx` and render it in `client/src/components/Nav/SettingsTabs/About/About.tsx` from `/api/search/meta`: FR-043's text verbatim in every locale with `https://bin.arnastofnun.is`, the surrounding label localized, with a focused test
- [ ] T133 [US3] Create `client/src/components/Search/ShadowPanel.tsx` and render it on `client/src/routes/Search.tsx`: localized side-by-side of the user's own search, keyboard usable, saying when the new search was dropped or failed, a Jotai toggle and a local rated-query atom via `client/src/store/jotai-utils.ts`, cleared on opt-out and at logout through `client/src/hooks/Config/useClearStates.ts` (FR-033, [R-18](research.md#r-18-fr-011s-panel-re-run)), with a focused test
- [ ] T134 [US3] Add round 2 to `ShadowPanel.tsx`: list the rated queries, re-run each as the panellist's own search and record a new verdict, with a focused test
- [ ] T135 [US3] Add `packages/data-schemas/misc/documentdb/search.documentdb.spec.ts` for the search data methods
- [ ] T136 [US3] Add `packages/api/misc/search-live/` with its own Jest config, `tsconfig.json` and a `test:search-live` script using T052's Node flag, for the writer and reads, rerunning R-05's questions and §9's stream checks against the code on the sandbox, including TTL delete behaviour; if no event, reconcile's accepted interval (spec edge case)

### Runbook

- [ ] T137 [US3] Write the backfill section of `specs/001-conversation-search/runbook.md`: per-cluster `modifyChangeStreams`, 7-day retention recorded per tenant, entry checks, thresholds and the pause job (FR-028, FR-039)
- [ ] T138 [US3] Write the retention section: rules naming the word list (FR-029), TTL-delete interval if needed, data-off drop deadline
- [ ] T139 [US3] Write the shadow section: terms fixed in advance ("warm", "normal load", "working hours", chat save baseline), tenant selection, 20-sample minimum, maximum drop share, panel opt-in, probe schedule and the log check on its sentinels through shadow and the hold, seven-day reconcile, named queries per [contracts/telemetry.md](contracts/telemetry.md), the FR-034 decision table, the FR-011 re-run
- [ ] T140 [US3] Write the cutover and rollback sections: per-tenant entry, 30-day hold, thresholds, one-setting rollback with rolling restart timed, after-removal rollback in this order: roll out `data: false`, `backend: meilisearch` and `meiliResyncPending: true` with the Meilisearch variables still unset, so `indexSync` stays off and `/enable` is false; run `config/reset-meili-sync.js --yes`, whose updates would otherwise flood the writer; redeploy Meilisearch and roll out with the variables set, because `indexSync` only runs at process start; search stays hidden until the full sync passes T125's gate; then roll out `meiliResyncPending: false`, return after abort; FR-038's floor rule applied from metrics
- [ ] T141 [US3] Write the release checklist section: each release's `explain` check (FR-040), compat specs and the lighthouse lane with `LIGHTHOUSE_MONGO_URI` on a clone (FR-031), FR-034's rerun, reconcile after a token-changing deploy, a plan for any release that changes Meilisearch settings, because `indexSync` then resets every flag at start with the writer on, upstream search check before cutover

### Operator stages

- [ ] T142 [OP] [US3] In the infrastructure repository: per-tenant `search` config
- [ ] T143 [OP] [US3] In the infrastructure repository: metric filters and CloudWatch alarms per [contracts/telemetry.md](contracts/telemetry.md), including the SC-006 p95 and SC-009 alarms (FR-035, FR-039, FR-040), the probe schedule, and a metric filter on tenant logs for the probe sentinels that trips SC-005's abort
- [ ] T144 [OP] [US3] Turn on the `/metrics` scrape, and carry chat save p95 from the scrape to an alarm, so SC-008's abort threshold has a path. A tenant on `api/server/experimental.js` has no `/metrics`, so the entry check fails there. Confirm the query returns data
- [ ] T145 [OP] [US3] Per tenant, before its backfill: run `modifyChangeStreams` on the source collections, raise change stream retention to 7 days, and record each tenant's value (FR-039)
- [ ] T146 [OP] [US3] Add the private image step placing the language data in the infrastructure repository
- [ ] T147 [OP] [US3] Get the owner's written decision on FR-036: accept timing after-removal rollback on a snapshot clone of the shadow tenant's data, or amend the requirement. The spec says it is timed on the shadow tenant with new search serving; the plan uses a clone because resetting sync flags live would flood sync
- [ ] T148 [OP] [US3] Run T135 and T136 on the sandbox and record the results under R-05, without tenant data. A failure stops T149 (stage 5's exit)
- [ ] T149 [OP] [US3] On a non-production tenant already on 8.0 with streams set up (T145), run [quickstart.md](quickstart.md) §7 with `languages: [en]` if T146's image isn't ready, deferring to T151 the `is` checks: pack load, tokens on real records, and attribution in the About tab. Include rollback before cutover and during the hold. Time after-removal rollback on a snapshot clone of the shadow tenant's data with a parallel Meilisearch, following T140's order, with live writes during the sync so T125's gate is proved under traffic
- [ ] T150 [OP] [US3] With private data, measure the `is` pack's memory and load time against §4's cost and startup with it on and off, before stage 8 (FR-046)
- [ ] T151 [OP] [US3] Stage 8: with T022 done, T146's image, T007's shadow tenant chosen, streams set up on it (T145), SC-001 to SC-004 passing, working queries and alarms, two weeks of SC-008 and SC-012 baseline, and T150 recorded, turn search data on for the shadow tenant, then request backfill, see reconcile and verify pass, and run the `is` checks T149 deferred
- [ ] T152 [OP] [US3] Stage 9: the owner confirms the gate targets (§11 question 5), then `backend: shadow` for at least two weeks with the panel and probes. Record both §10 lists. The owner decides against SC-005 to SC-014 per FR-034
- [ ] T153 [OP] [US3] Stage 10, first tenant: per-tenant entry checks, `backend: search`, 30-day hold under FR-035's thresholds, then remove Meilisearch and its volume together in the infrastructure repository (SC-015)
- [ ] T154 [OP] [US3] Stage 10, the fleet: repeat T153 tenant by tenant, each with stage 8's entry checks, streams set up (T145) and a verified backfill first, until every tenant in scope has removed Meilisearch
- [ ] T155 [OP] [US3] From the first backfill until T154 ends, apply FR-038's floor rule weekly and record each decision

**Checkpoint**: A tenant moves through every stage and back, on numbers.

---

## Phase 7: User Story 4 - Maintainer adds a language later (Priority: P4)

**Goal**: A language is one pack and a setting.

**Independent Test**: A throwaway stemmer pack passes the contract suite and is enabled in a test tenant with no change to storage, read or ranking code ([quickstart.md](quickstart.md) §2).

- [ ] T156 [P] [US4] Add a throwaway stemmer pack in `packages/api/src/search/languages/__tests__/helpers/throwaway.ts`, whose words include letters from the Icelandic set, and run the contract suite with `is` off in `languages/__tests__/throwaway.spec.ts` for public CI and on in `packages/api/misc/search-quality/` (SC-016). Its diff touches only `languages/`
- [ ] T157 [US4] After T069 and T125, test in `packages/api/src/search/languages/registry.spec.ts`: a disabled pack's `load` is never called (T150 measures memory); an unregistered ID makes the service and `/enable` report not ready with chat unaffected
- [ ] T158 [US4] After T113, T118 and T125, test in `packages/api/src/search/languages/reanalysis.spec.ts`, a name public CI's `integration` filter doesn't skip, with `MongoMemoryReplSet`: a new pack's tokens apply to new messages at once while older records match by exact form until reconcile rewrites them, and FR-043's attribution survives until then (US4 scenarios 1 to 3)

---

## Phase 8: Polish & Cross-Cutting

- [ ] T159 Run every scenario in [quickstart.md](quickstart.md) that does not need a live tenant and record the results in the final PR, including the checks that could not run
- [ ] T160 Run the DocumentDB specs on a clone with the feature merged and default configuration. Expect the same results as on the code before this feature

---

## Dependencies & Execution Order

### Phases

```text
Phase 1 Setup
  ├─► Phase 2 Operator prework
  │     T007, T009, T010 start now; T008 and T011 are closed
  │     T012 ─► T013; T014 ─► T015; both ─► T017
  │     T009 ─► T016 ─► T013
  │     T007, T017, T018, T019, T020 ─► T021 ─► T022
  └─► T010 ─► Phase 3 Foundational (T052 to T056 need T009's private copy; T055 needs T016)
        ├─► T017 ─► Phase 4 US1 ─► Phase 5 US2
        ├─► T156 US4 (after T046; its `is`-on case after T055)
        └─► T017 ─► Phase 6 US3 code, T100 to T141 (needs US1 and US2 for the detached run and its surfaces)
              ├─► T157 US4 (after T069 and T125), T158 US4
              └─► T142, T143, T144, T145, T147, T148 ─► T149 ─► T150 ─► T151 ─► T152 ─► T153 ─► T154
T022 ─► T151; T149's tenant on 8.0 first
T146 ─► T151
T007 ─► T149, T151
Phase 8 after the code tasks
```

### Why the stories are not fully independent

- US1 and US2 share reads, so US2 follows US1. Each is testable through its routes on a database loaded through T049's loader, with no sync.
- Real users only get US1 and US2 after US3's operator stages. So the **MVP to test** is US1, and the **MVP to ship** is through T153 on one tenant.
- T020, T021 and T022 only need the code as it ships today, so they can run while search code is being written.

### Within a story

Tests first, then data methods, then services, then routes, then client.

### Blocking gates

- **FR-031 engine**: T151 cannot start before T022, and T149 needs its tenant on 8.0. "The upgrade precedes search work on tenants."
- **FR-031 sandbox**: The owner lifted this gate for Phase 4's code on 2026-11-04, because that code stays off by default and reaches no tenant; sandbox results may force rework. Otherwise T017 precedes Phase 6 and T021, and T149 needs T148. It can stop all tenant work, or replace T111, T113 and T124 and their tests T100 and T101 through R-17.
- **FR-045**: No tenant image holds Icelandic data before T146, so T149 runs with `languages: [en]` until then, and T151 cannot start.
- **SC-001 to SC-004**: Must pass before T151, and again before a later tenant's cutover on any analyzer or ranking change.

## Parallel Example: Phase 5

```text
T077 paging tests, T078 cursor tests, T079 query tests, T080 error tests, T081 client tests
T094 signal pass-through and retry predicate
```

## Implementation Strategy

1. **Answers first**: T007 to T017 are an estimated two weeks, most of it T012 and T014's scripts and §10 step 3's budgeted 3 days, plus a small sandbox bill, and can change the plan.
2. **Merge dark**: Phases 3 to 7 ship with the default configuration, each with the Every PR checks.
3. **Prove quality early**: T055, T057 and T076 run before any tenant work, and a miss there stops the rollout cheaply.
4. **One tenant, then the fleet**: T151 to T153 on the shadow tenant; T154 tenant by tenant, each reversible by one setting until removal.
