# Quickstart: Validating Conversation Search

Each scenario proves an outcome; shapes are in [data-model.md](data-model.md) and [contracts/](contracts/). Commands that need the private language data or the synthetic corpus run outside public CI.

## Prerequisites

- `npm ci`, `npm run build:data-provider`.
- For Icelandic and quality: `search.languageDataDir` set to the private copy ([R-02](research.md#r-02-language-data-delivery)); `SEARCH_QUALITY_CORPUS` set to the generated corpus, `SEARCH_QUALITY_DIR` to T016's output, `SEARCH_QUALITY_VOCAB` to T016's `vocab.ndjson.gz` in that output (each condition's word list is read from the same folder), `SEARCH_QUALITY_MONGO_URI` to a local MongoDB 8.0, and `SEARCH_LANGUAGE_DATA_DIR` to the private copy.
- For live checks: `DOCUMENTDB_URI` and `DOCUMENTDB_TLS_CA_FILE`, as `packages/data-schemas/misc/documentdb/` expects.
- `librechat.yaml` with `search: { data: true, backend: search }`, and `SEARCH=true`.

## 1. Default configuration changes nothing (FR-041)

```bash
(cd packages/api && npx jest src/search/http)
(cd packages/data-schemas && npx jest src/methods/conversation.spec.ts src/methods/share.test.ts src/models/plugins/mongoMeili.spec.ts)
npm run lighthouse
```

Expect: existing Meilisearch tests pass unmodified; responses carry no new fields; no pack loads; a test asserts no search collection exists after model creation with data off. Run the app with `MEILI_HOST` unset and confirm it starts cleanly.

The upgrade's clone run uses `LIGHTHOUSE_MONGO_URI` to point the lane at the clone, as the lane otherwise uses an in-memory database.

## 2. Pack contract and cost (US4, SC-016, FR-046)

```bash
cd packages/api && npx jest src/search/languages
```

Expect: `en` and the fake dictionary pack pass the same suite, in public CI; a new pack gives new messages its tokens at once while older records still match by exact form until reconcile; disabling a pack loads nothing.

With the private data, outside public CI: the `is` pack passes the same suite, and `search.pack` records memory and load time against §4's cost, with startup time compared with the pack on and off.

## 3. Token parity and quality (FR-007, SC-001 to SC-004, US1)

```bash
cd packages/api && npm run test:search-quality
```

Expect:

- Tokens equal the reference on the corpus.
- At limits 200 and 1,000: at least 63 of 84 first page; at least 76 of 84 top 200; at least 92 of 113 expected messages; precision at 25 at least 0.98 on the flood-prone 20; no category below B4's §6 row; condition H at least 32, 47 and 0.90; isolation holds in every query.
- Accepted-gap queries behave as the spec records them: `hvad kostadi radgjafinn` and `for`.

## 4. Reads, paging, failures (US2)

```bash
(cd packages/api && npx jest src/search/read src/search/http)
(cd client && npx jest src/routes/__tests__/Search)
```

Expect:

- Typo, prefix, multi-word and natural-language scenarios pass, on messages and on titles and tags, including title tiers and multi-word titles (FR-009). Shared-link search matches titles and tags with word forms (US2 scenario 9).
- Paging from the real first page matches an independent oracle ([R-06](research.md#r-06-paging-model)), for single and multi-word queries, with no duplicates and nothing lost. Cases: a run of same-date rows across a window, a run longer than a window, a write between pages above and below the anchor, a late record pushing a served row, a vocabulary flush that would change the driver, an exact match arriving after a typo-only page 1, reaching the prefix tier from a common word, rows of 3,000 tokens in a window, a tier with several common tokens, and more late rows than a window holds.
- A decoded cursor is not readable: no token from another user's message appears. A tampered cursor, or one from another user, returns `search_cursor_invalid`. A new-search cursor on the Meilisearch branch returns the same code, not an empty 200.
- A word newer than the word list is still found.
- A stale record for a temporary, subagent, unfinished or expired message in a visible conversation does not reach the client.
- The FR-018 table holds, row by row, with a coded body and no raw text, through both catch blocks and both routes.
- One disconnecting surface does not fail the other sharing its read; the slot frees when the last waiter leaves. The worst-case URL stays within 7.5 KB, with the longest allowed query.
- The client shows busy, partial and stop-word states, announced to assistive technology. Load-more works by keyboard. A failed later page keeps results and retries from the same place. An invalid cursor offers a restart. A repeated `messageId` shows once. `search_busy` is not retried by the query layer, a multi-page search does not refetch on focus, and a superseded query closes its request. `search_failed` shows a state on `/search`, the sidebar, Archived Chats and shared links. A proxy 414 offers a restart.

## 5. Sync (FR-023 to FR-026, edge cases)

```bash
cd packages/api && npx jest src/search/sync src/search/jobs
```

Uses `MongoMemoryReplSet`. Expect:

- §9's checks: insert, edit, metadata-only writes nothing, `bulkWrite` import, `updateMany` to temporary, tag rename, subagent and unfinished exclusions, finishing a message, external `deleteMany`, resume after restart, TTL delete.
- Plain change-event documents pass `isIndexableSource`, and it agrees with `buildIndexableQuery`, plus `unfinished: { $ne: true }`, on stored rows.
- Takeover within the configured time. A paused writer cannot overwrite a newer record, including one whose `h` the new writer replayed unchanged, and a write it completes after losing its turn is corrected by the source check. A backfill batch read before a delete, or before a chat turned temporary, leaves no record. A process with a failed pack does not take the lease. A batch applies only the last event per `_id`. An oversized event's failure counts as a gap and does not stall sync. An update setting `_meiliIndex: true` does no record read.
- Reconcile repair loses to a live edit. It reports counts before repairing and resumes from any phase. A rebuild keeps a word arriving mid-walk, resumes after a crash in any pass, and leaves no unstamped row. A pack removed from the analyzer keeps its attribution until reconcile finishes (FR-043, US4 scenario 3).
- A poison event skips with an alarm. A pack load failure stops sync with no partial record. A sentinel in `contextMeta` never reaches tokens.
- Rolling analyzer change: records and queries at different versions still match by exact form, and reconcile rewrites them.
- Verification ignores a chat deleted between walks, an import inside the lag window, and fails on a real gap. A pass older than `invalidatedAt` makes `/enable` false, including after a restart from `search` to `meilisearch`, and after `data` went off then on. A verification mismatch alarms, reconciles and verifies again, and fails to the owner after three rounds. A stalled writer trips the `search.sync_status` alarm.
- If the sandbox trial shows TTL deletes emit no event, reconcile removes the records at the accepted interval.

## 6. Live engine (FR-031, FR-040, §10 step 3)

Owner decision, 2026-11-10: no separate measurement runs before the code. The sandbox trial in §7 answers §10 step 3 and [R-05](research.md#r-05-what-the-sandbox-must-also-answer) on the real code, on DocumentDB 8.0. Any FR-031 stop rule ends tenant work.

Before the trial, run the data methods against the engine:

```bash
cd packages/data-schemas && DOCUMENTDB_STRICT=true npx jest --config misc/documentdb/jest.documentdb.config.mjs
```

It needs `DOCUMENTDB_URI` pointing at a database of its own with change streams enabled, as [runbook.md](../../docs/search/runbook.md#engine-compatibility-run) describes. Without strict mode a rejected query only prints, and without the URI every suite skips.

## 7. The sandbox trial: operator path on the sandbox tenant (US3, SC-017)

Runs with `languages: [en]` until T146's image is ready ([R-02](research.md#r-02-language-data-delivery)), with the `is` checks deferred to stage 8. Follow [runbook.md](../../docs/search/runbook.md):

1. Turn search data on and request `node config/search-job.js backfill`. `status` shows progress; kill a process mid-way and confirm it resumes; pause and resume it.
2. Confirm `/api/search/enable` stays Meilisearch-driven until `backend: search` and verification has passed.
3. Set `backend: search`. The sandbox tenant now serves the new search from a verified backfill, with the sync writer on. Confirm `search.request` events hold no text and that the edge cases in §5 hold on live writes: an edit, a delete, a chat turned temporary, a bulk import and a TTL delete.
4. Confirm chat save p95 and cursor errors by route have a working query ([R-14](research.md#r-14-metrics-and-alarms)).
5. Roll back to `backend: meilisearch` and return, as the runbook does it before cutover and during the hold. Record each duration, including the rolling restart. Confirm a return after abort needs a fresh verification.

Expect: one setting for both rollbacks.

After-removal rollback is timed once on a snapshot clone of the trial tenant's data, before the first removal anywhere (FR-036): with a parallel Meilisearch, the runbook rolls out data off and `meiliResyncPending` with the Meilisearch variables unset, resets sync state, then rolls out with the variables set, which starts the full sync. Search stays hidden until it finishes.

## 8. Trial gate (SC-005 to SC-012)

On the sandbox tenant, per the runbook: confirm SC-001 to SC-004 passed, fix the gate's terms before the trial is read, run reconcile seven days in, compute each measure from [contracts/telemetry.md](contracts/telemetry.md) and CloudWatch, and let the owner decide (FR-034). Each latency measure needs at least 20 samples or counts as not measured. SC-013 and SC-014 are withdrawn with the panel. The same abort thresholds then apply during each tenant's 30-day hold (FR-035).

## 9. Each release (FR-031, FR-040, FR-034)

The runbook's release checklist: `explain` confirms the fast plan on the release, DocumentDB compatibility specs and `npm run lighthouse` run, and SC-001 to SC-004 rerun on any analyzer or ranking change before a later tenant's cutover.

## 10. Public repository check (FR-047)

Run the runbook's grep for the tenant list held outside this repository, over the diff, before every PR.
