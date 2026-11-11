# Research: Conversation Search

Phase 0 of the plan. The design (`librechat-search-documentdb-design-final.md`, outside this repository) holds the evidence for the architecture and is not repeated. This file records what the plan had to decide beyond it, and where the code differs from what the design assumed. Code references were checked against `aproorg/0.8.8`, the merge target.

No NEEDS CLARIFICATION remains. Unknowns only a live database can answer go to the sandbox ([R-05](#r-05-what-the-sandbox-must-also-answer)), with the fallback already chosen.

## R-01 Architecture adopted as designed

- **Decision**: Search collections in the tenant database, Node tokens, one sync writer following change events, tiered reads (§1, §5, §9).
- **Rationale**: The spec's source of truth; evidence in the design.
- **Alternatives**: Meilisearch with tokens is cheaper for the same quality. §1 rejects it because removing the service is the goal.

## R-02 Language data delivery

- **Decision**: The `is` pack loads its library and data from `search.languageDataDir` at run time. The stages follow FR-045:
  - **Before the image step (T146)**: the private copy exists only outside this repository, for out-of-tree test runs and the sandbox. No tenant image holds it. So the `is` pack cannot be on for any tenant, and stage 8 cannot start. A non-production tenant may run search data with `languages: [en]` for the operator path.
  - **After the image step**: a private build step in the infrastructure repository places it in the tenant image. Its manifest and notices are recorded (FR-044).
- **Layout of `languageDataDir`**: `lemma-is/` with its `node_modules/tokenize-is`, `fold-table.bin`, `lists/stop-lemma.json`, `lists/stop-extra.json` and `lists/function-verbs.json`, each list a JSON array of strings, and `manifest.json` with the sha512.
- The delivered copy includes `tokenize-is`, the library's one bare import. The library is ESM-only, so the pack imports it by file URL. The load checks a manifest sha512 over the delivered files against a constant in the pack's code, because upstream's checksum covers the package tarball and the delivered copy is trimmed. Upstream's value is kept as provenance. The check runs inside `load`, after the server listens, so it cannot delay startup. A missing or corrupt directory follows the spec's pack-failure edge case. `languageDataDir` has no default inside the repository, and `vendor/search-language/` joins `.gitignore`, so private data cannot be committed by accident. `snowball-stemmers` is an ordinary dependency of `packages/api`, and its licence is checked when added.
- **Rationale**: §9 says vendor now; FR-045 narrows that. A path keeps the code identical in every case.
- **Alternatives**: Private npm registry: adds a registry to the public build. Git submodule: leaks the private location.
- **Fold table**: Built once with the private copy, and copied rather than rebuilt by the same private step, so the manifest holds (§9: 96 MB, not in git). The loader is a port of the reference's sorted-buffer lookup, so it stays off-heap.

## R-03 Seams into existing code

**One flow per surface.** When `search` is present, a route builds a `SearchContext` (session user, `AbortSignal`, a timer) with `createSearchContext(req, res)` from `packages/api`, and maps failures with `searchErrorResponse(err)`. The signal fires on `res` close when `res.writableFinished` is false, as `abortOnDisconnect` in `packages/api/src/traces/handlers.ts` does, so a response that completes normally aborts nothing. Building it adds no read: config is a process snapshot ([R-19](#r-19-config-channel)). Search failures are `SearchError` with a stable code. That class lives in `data-schemas` (`utils/searchError.ts`), so its methods can recognise and rethrow it from their existing catch blocks.

| Surface | Flow |
|---|---|
| `/search` | `messages.js` `search` branch calls `searchMessagesRoute(ctx, query, cursor)` in `http/messages.ts`. A `null` return means Meilisearch serves, and today's branch runs unchanged. Hits hydrate through the new message-level method below |
| Sidebar | `convos.js` passes `searchContext: ctx` into `getConvosByCursor`, which calls `SearchPort.conversationMatches(ctx, query)`. `null` runs today's code. Otherwise it returns `{ conversationIds, partial, reason }`, and the existing `$in`, filter and cursor logic takes over. `partial` and `reason` join the return value |
| Shared links | Same shape: `share.js` passes `searchContext` into `getSharedLinks`, which calls `SearchPort.titleMatches`. The route's response adds `reason` |
| `SearchError` | Passes the search catch in `getConvosByCursor` and both the inner and outer catches in `getSharedLinks`, and `convos.js` and `share.js` map it. Any other error behaves as today |
| Archived Chats | `ArchivedChatsTable.tsx` and the sidebar's archived view reach the same `getConvosByCursor` seam, so they get the same states |

`SearchPort` is a getter bound after config loads, not at `createMethods`, which runs at require time in `api/models/index.js` before config exists. The server entry points create the service and set the port and `app.locals.search`, so no new singleton is needed. `createSearchContext` reads no config. `createShareMethods(mongoose)` takes no deps today and gains the port. Returning `null` keeps defaults byte-identical (FR-041).

**Code differences the plan absorbs:**

- **`isIndexableDocument` cannot move as is.** `hasExplicitTemporaryFlag` calls `doc.$isDefault('isTemporary')`, which only exists on hydrated documents, while change events and lean rows are plain. A new pure predicate over plain fields, `isIndexableSource(doc, excludePath)` in `models/plugins/indexable.ts`, treats "explicit" as the field being present and non-null in the stored document, and includes `unfinished`. The plugin keeps its own wrapper. A parity test compares the predicate on stored rows to `buildIndexableQuery`, which gets exported, plus `unfinished: { $ne: true }`, a clause the plugin's query does not have.
- **Hydration filters conversations only.** `getConvosQueried` checks conversations, and `getMessages` applies no filter. That was safe because Meilisearch hits come from a clean index, but a stale search record is not. A new `getSearchableMessages(user, messageIds)` applies the message-level indexable query, plus `unfinished: { $ne: true }`, with `CLIENT_MESSAGE_SELECT`. That select strips `_id`, so rows match hits by `messageId` under the user scope, as `messages.js` does, and hits with no source row drop. Each exclusion gets a test (temporary, subagent, unfinished, expired).
- `getConvosQueried(user, hits, cursor, pageSize)` slices to `limit` conversations and parses `cursor` as a date. The new path uses a new `getSearchHitConversations(user, ids)` with the same two visibility filters and no slice or shared-flag read, as the route only needs title and model. It starts in parallel with `getSearchableMessages`, per `AGENTS.md`. A new-search cursor reaching the Meilisearch branch after a rollback would parse as an invalid date and return an empty 200, so that branch rejects the `s1.` prefix with `search_cursor_invalid`. Today's client never sends a cursor there, because `nextCursor` is always null.
- `parseTextParts(content, false, { includeSteer: true })` includes thinking because `skipReasoning` is `false`. Sync must call it the same way as `mongoMeili.ts`.
- `MEILI_HOST` gates the plugin at model creation (`models/message.ts`), and with it unset `searchMessages` throws. `indexSync` is started unconditionally from both server entry points, and `/enable` builds a client from unset variables. For FR-036: start `indexSync` only when `MEILI_HOST` and `MEILI_MASTER_KEY` are set, not by `search.backend`, because Meilisearch must stay in sync during the hold. That check is a `packages/api` helper, so `/api` keeps only the call.
- **Config plumbing**: `AppService` enumerates fields (`packages/data-schemas/src/app/service.ts`), and the loader keeps raw config, so Zod defaults are not applied. A `loadSearchConfig` in `packages/data-schemas/src/app/search.ts` applies defaults and joins `AppService`, as `loadLangfuseConfig` does.
- **Meilisearch bookkeeping writes reach the stream.** See [R-09](#r-09-sync-writer).

## R-04 One tenant per database

- **Decision**: This feature assumes one tenant per database, as every stack in scope runs. One writer serves one database; `search_vocab` and `search_state` have no `tenantId`. `msearch` and `csearch` carry `tenantId` and the tenant plugin as §9 says, copied from the source, so `tenantIsolation.coverage.spec.ts` holds. The writer pins the first non-null `tenantId` it sees in `search_state`, and on a second non-null value it stops and alarms rather than mixing tenants. Rows with no `tenantId` are legal and copy as they are. Record writes use `tenantSafeBulkWrite` under `runAsSystem` with only `replaceOne` and `insertOne`, whose documents pass through with the source's `tenantId`. A `$set` would have it stripped, and the upserted record would be invisible to tenant-scoped reads. `search-job.js status` reports the distinct values before backfill.
- **Rationale**: Per-tenant state on a shared database would need a tenant-aware writer, lease, verification and `/enable`, for a shape nothing in scope runs.
- **Alternatives**: A tenant-aware word list alone: tried in the first draft, and it does not fix lease or readiness, so a shared database still breaks FR-030.

## R-05 What the sandbox must also answer

**Owner decision, 2026-11-10**: the sandbox trial answers §10 step 3 and the questions below on the real code: the sandbox tenant, on DocumentDB 8.0, with a backfill, the sync writer and the new search serving. No separate harness or scripts are written (T012 to T015 cut), and `packages/api/misc/search-live/` is not written (T136 cut). 5.0 with planner v2 is not measured, so §8's fallback engine has no result.

These additions come from this plan's choices, and each has a fallback. The trial's answers are recorded here without tenant data, and the live suite in `packages/data-schemas/misc/documentdb/` reruns the data methods against the engine.

| Question | Fallback if it fails |
|---|---|
| Is a `$nin` on the dropped word's tokens, beside `$in` on the job's, planned acceptably with the hint? ([R-07](#r-07-multi-word-paging)) | Walk date windows and filter earlier stages in memory. Pages may run short but nothing is lost; it costs reads, so the owner accepts the latency |
| Can the writer keep up during a full Meilisearch sync, whose `_meiliIndexAttempted` writes the skip rule doesn't catch? | Stop the writer during that sync and treat it as a gap |
| Does `hint` by index name hold on 8.0 and 5.0 v2 with `$in` and `$nin`? | Rely on the planner, alarm on p95 (FR-040) |
| Is a tie read (`createdAt` equal, sorted by `_id`) acceptable on a long run? ([R-06](#r-06-paging-model)) | Raise the memory bound and read the run in `_id` ranges |
| What does a load-more cost on a tier with common tokens, with `$nin` on earlier jobs' tokens? | Lower the walk's reads per page, by written decision on latency |
| Does a database-level `watch` work when `modifyChangeStreams` enabled only the two collections? AWS says each must be enabled, and shows `db.watch()` without stating this | Watch each collection on its own, which needs two cursors at the floor |
| Does the stream accept the `$project` for oversized events, and what happens on an event over 16 MB? | Treat it as a gap, as [R-09](#r-09-sync-writer) already does, and accept the reconcile |
| What is lag under a bulk import with batch writes? | Define import lag in the gate terms in the runbook, in writing |
| Is a conditional `replaceOne` with `upsert` on `{ _id, e: { $lte } }` safe under duplicate-key races? ([R-09](#r-09-sync-writer)) | Read then write, leaving the residual window to reconcile |
| Is `_meiliIndex: true` in `updateDescription` reliable? AWS documents `updateDescription` and omits an unchanged `$set` field, so this is a narrow check | Lose the skip; each such event costs one record read |
| Do change events carry a usable `postBatchResumeToken` through the driver's `watch` on a database? | Save the event resume token, accepting §9's resume cost |
| Does cancelling a read through `signal` or `maxTimeMS` free the cursor? | Bound by `maxTimeMS` only, with the slot held until it returns |
| What does the sidebar's title path cost, with prefix and typo reads outside the cap? §11 lists title search as untested | Lower `prefix.maxVocabRows` and `typo.maxVocabRows`, by written decision on results |
| Can a word list rebuild run beside chat at the floor? ([R-10](#r-10-vocabulary-upkeep-and-rebuild)) | The owner widens the rebuild's interval in writing, against the tenant's retention rules |

## R-06 Paging model

**Frozen plan.** Between pages, `df` flushes can change the driver, the rare and common split and the expansions, and a late exact match can remove the typo tier. So page 1 fixes the plan, and the cursor carries it: the driver's position, each word's exact, lemma and part tokens, the rare and common split, and whether a typo tier exists, decided on page 1's `df` as in the reference.

The prefix tier cannot be read eagerly, because a vocabulary read on every page 1 would break §5's cost for common words. So when the read plan or the walk first reaches it, the expansions are read once and frozen in the cursor from then on. A word matched by nothing also gets its typo corrections frozen at that point.

The paging test's oracle is independent of the plan: on a fixture with a static word list, it computes the expected set directly from the query's exact, lemma, part and budgeted prefix tokens.

**Cursor.** The prefix `s1.` plus base64url of deflated JSON, encrypted and authenticated with AES-256-GCM. The key is derived with a search-specific label, and the user ID is bound as associated data. Encryption is required because the plan holds prefix and typo expansions from the tenant-wide word list, which may contain other users' names: FR-029 allows only a timing side channel. It also means a forged or tampered cursor is detected, as the spec's edge case requires, and another user's cursor fails. Rotating the secret invalidates cursors, which the client restarts from. Contents: `{ cv, b, qh, anchor, plan, stage, tier, job, before, floor, tieDate, tieAfter, first, seen, carry, carryFloor, sequential }`. Implementation note, 2026-11-11: the plan sits in a slot of fixed size (1,900 bytes: the 1.5 KB prefix budget plus room for corrections frozen after it), so the cursor's length does not vary with what the word list held; a plan that cannot fit yields no cursor. `carry`, `carryFloor` and `sequential` hold the overflow state described under Windows. A word the word list holds is corrected only when it drives a search that found nothing, as the reference does; `typoSkippedWordExists` counts searches that ended empty with another such word left uncorrected. The key comes from `JWT_SECRET`, by HKDF.

| Field | Meaning |
|---|---|
| `cv`, `b`, `qh` | Cursor version, backend, hash of `query.normalize('NFC').slice(0, 256)`, the same rule the client uses on a request with a cursor. A mismatch or parse failure returns `search_cursor_invalid` (400) |
| `anchor` | Upper date; nothing newer enters the pagination |
| `plan` | The frozen plan above |
| `stage`, `tier`, `job` | Position in word sets, tiers and jobs, validated against `plan` |
| `before`, `floor` | Current window's date range |
| `tieDate`, `tieAfter` | Position inside a same-date run |
| `first` | 5-byte hashes of page 1's IDs, kept for the whole pagination |
| `seen` | 5-byte hashes of IDs served from the current window |

Scope is never in the cursor: `user` comes from the session. Every decoded field is type-checked before it reaches a filter. `client/nginx.conf` leaves nginx's default 8 KB request line, so `rankWindow` has a maximum of 200, its default. The worst case is the plan's fixed 1.9 KB slot, about 1.4 KB of `seen` (at most 1.25 × `rankWindow` rows plus a page) and 0.3 KB of the rest, or roughly 5 KB encoded. A test pins the full URL at 7.5 KB at that worst case, with the longest allowed query. So 1.5 KB of deflated plan is part of the prefix budget, applied once when expansions are frozen and before any row is served: most frequent words first, as the spec's budget edge case says. A word past it is outside the budget, not lost between pages, and `vocabRowsTruncated` counts it. A request carrying a cursor sends only the query's first 256 characters, about 1.5 KB percent-encoded, and the server hashes the same, because `/api/messages` has no search length limit today. The client maps a 414 from a proxy to the restart state. A 5-byte collision is negligible at this scale, and its only effect is one row not shown.

**Page 1** is the ranked result of the read plan (§5), so its quality matches the reference. It takes 25 rows and records them in `first`.

**Page 2 onward** is the paging reference's shape, starting again from the top of the plan, tier by tier and excluding `first`. So the read and the evidence match, and a row ranked low on page 1's candidate list simply arrives through this walk. Page 1's candidates beyond the 25 are not kept. 

**Jobs.** A tier's reads follow §5: tokens rarer than 300 documents share one `$in` job, bounded by their `df`, and each common token is its own job, so every read stays in index order. A single `$in` over common tokens would sort every match on each load-more, which §5 and §8 designed out. The walk finishes one job, then the next, and each job excludes earlier jobs' and higher tiers' tokens with `$nin`. So order across jobs is not newest first, which only affects load-more.

**Windows.** A first read in a window takes `rankWindow` rows below `before`. If the read is full, its last row's date `T` becomes `floor`, and rows at `T` leave the window, because a limit returns an arbitrary subset within one date. The window is then every row with `createdAt > T`, re-read by range rather than by `limit` on each page, with `seen` excluded, then ranked. A re-read holds at most `2 × rankWindow` rows, because only late records can add to it; on overflow it is handled like a first read: rows at the held set's oldest date leave it, the rest are served, and then the walk moves its upper bound to that date and resets `seen`, with the tie read taking that date's rows. So a burst of late rows is never stuck behind a limit. Implementation note, 2026-11-10: a re-read is bounded at 1.25 × `rankWindow` rather than 2 ×, because `seen` at 2 × does not fit the 7.5 KB URL with the longest query in three-byte letters. On overflow the job continues newest first by whole dates, which needs no `seen`; rows the window had already served are carried as hashes and skipped until the walk passes that window's floor, so nothing repeats.

**Row size.** A `singleBatch` read returns one batch of at most 16 MB and a short result looks like the end of a window. A row with `tokens` can reach about 45 KB, so window and tier reads never project `tokens`. Multi-word scoring fetches them separately by `_id`, in chunks of 50, only for the rows `/search` will rank, and keeps a per-row matched mask. That adds 4 reads per job at the default window, and hydration adds 2 parallel reads to any first page, so a common word goes from the design's 2 reads to 4. Both counts are measured in the sandbox trial. All of these run under `readConcurrency`.

**Same-date runs.** When a window ends, rows at `T` are read as their own window: `createdAt = T`, sorted by `_id`, after `tieAfter`, up to `rankWindow`, then the walk continues below `T`. A bulk import can make this run long, but `_id` paging bounds each read. A read whose rows all share one date goes straight here.

**Late records.** A record appearing or changing below the anchor mid-pagination joins a window not yet read or is excluded by `seen`. The one case hashes cannot cover is a served record edited so that it now matches a later tier. The client's list drops a repeated `messageId` as a backstop, and a test covers it.

**Rationale**: FR-013 and the between-pages edge case. The reference cursor's `$lt` on the last date loses same-date rows and its offset shifts on a late record.

## R-07 Multi-word paging

- **Decision**: Stages walk word sets: all words, then all words minus the last, and so on. Within a stage, tiers run as for one word with the frozen driver. Stage `k` excludes earlier stages' matches with `$nor: [{ $and: [<earlier stage's word filters>] }]`. "Every match" is the union of the frozen plan's stages, per FR-013.
- **Rationale**: Extends the design's tier exclusion to word sets, and the ordering of fuller matches first follows from stage order.
- **Alternatives**: An in-memory seen set across pages: unbounded for a word with thousands of matches.
- **Test**: Paging against a deep read on the padded corpus, starting from the real first page, with and without writes and a vocabulary flush between pages.
- Implementation note: stage k matches the stage's words and not the next word, so the exclusion is a `$nin` on that word's tokens, which is the same set as the `$nor` of earlier stages.

## R-08 Shared read

- **Decision**: `read/window.ts` holds a per-service-instance single-flight map keyed by tenant, user and normalized query, with a 30-second TTL and at most `sharedReadMaxBytes` of estimated size, evicting the oldest. An entry records rows in read order, each tagged with its tier, job and stage, with no `tokens`, plus the `df` snapshot and any prefix or typo expansions, which the title read shares rather than repeating. Masks are fetched lazily and memoized, only when `/search` derives a page; the sidebar needs only conversation IDs. The read is sized to `max(rankWindow, sidebarLimit)` per job. Each surface derives its answer by a pure function of that entry: the sidebar takes matching conversations, and `/search` replays the read plan's stop rule with `need = 25` and `window = rankWindow`, then ranks and builds the frozen plan. So the first page is the same whichever surface fired first, at any sidebar limit.
- **Waiters**: A read counts once against the cap and is refcounted. A waiter's disconnect removes it. The read aborts and the slot frees only when the last waiter leaves. One waiter leaving is not a failure for the other. Failures are not stored. Visibility checks always run on display. Load-more reads directly.
- **Rationale**: §5's window plus FR-015. The reference sizes the window by caller limit, which would make the first page depend on the sidebar limit.
- **Alternatives**: Separate reads per surface: doubles the cost of every search (§7's "5 users is nearer 2–3").

**Owner's decision, 2026-11-04**: the sidebar trusts `msearch` and doesn't check each message through `getSearchableMessages`. So a stale record can list a user's own visible conversation for a query it no longer matches, showing no message text, until sync or reconcile corrects it. Accepted, because edits are rare and the check would slow every sidebar search.

## R-09 Sync writer

**Lease.** `search_state` `_id: 'lease'`, with holder, epoch and `leaseUntil`. TTL 30 s, heartbeat 10 s (`search.syncTakeoverSeconds`). The epoch increments on each takeover. `LeaderElection` is not used: it is Redis-based, one key per deployment, and returns true without Redis, while a lease beside the data follows §9 and works in every deployment shape.

**Fencing.** A holder stops before writing if its local deadline passed, saves its position conditionally on its epoch, and writes records with `e`. A write applies only when the stored `e` is not higher: `replaceOne({ _id, e: { $lte: mine } }, doc, { upsert: true })`, where a duplicate-key error means a newer writer owns the record. After a takeover, until the stream passes the takeover time, replayed events raise `e` on a record even when `h` is unchanged, or a paused writer could still overwrite it. Normal events still write nothing on an unchanged `h`. A lease requires loaded packs: a process whose pack failed does not acquire it, and a holder releases it on a pack failure, so one bad task cannot stall the tenant. This adds `e` to §9's shape, because §9 assumed a single consumer while FR-024 covers a paused one.

**Post-write source check.** `e` cannot protect a record that no longer exists: a paused writer's upsert, or a backfill insert read before a delete or a turn to temporary, would bring it back (FR-022). So one rule covers all writers. After a backfill or repair batch, the job re-reads those source IDs (one read) and deletes any record whose source is now absent or non-indexable. Both orders are safe: an insert before the event is removed by the event, and an insert after it is removed by this check. The sync writer does the same after a batch only if a lease check shows it lost its turn, which is rare. A crash inside that window leaves an orphan, which reconcile removes and FR-014's source re-check keeps from showing.

**Stream.** A `data-schemas` method `watchSearchSources({ resumeToken, signal })` wraps `Connection.watch` on the database with `fullDocument: 'updateLookup'` and a filter to the two collections. It yields plain events, with `_id` as an opaque string, and saves `postBatchResumeToken` after each batch.

**Oversized events.** AWS documents a read failure when an event with its full document exceeds 16 MB, so a 9 MB message updated with a `$set` on `content` would stop the stream, and resuming would hit the same event. So a `$project` drops `updateDescription.updatedFields.content` and `.text`. If the stream still fails with this error, it counts as a gap: alarm, restart at the current position, reconcile. `replace` events have no `updateDescription` and are always treated as a full change. An invalidate event is a gap too.

**Per batch.** §9's event logic, using `isIndexableSource`, but each stream batch runs in one pass: keep the last event per `_id`, read `h`, `v` and `e` with one `_id: { $in }`, then write an unordered bulk of guarded upserts and deletes. §9's 25 messages per second unbatched would put a 90,000-message import past SC-009's one-hour abort, with every new message behind it. A null `fullDocument` on update is treated as a delete. `h` hashes the extracted text with `user`, `conversationId` and `createdAt`, so a change to any of them rewrites the record while a metadata-only update writes nothing.

**Meilisearch's own writes.** While Meilisearch runs, every save also does an `_meiliIndex` update, and `reset-meili-sync.js` updates every message. A server-side `$match` cannot drop updates that touch `_meiliIndex`, because `findOneAndUpdate` sets it alongside real edits (`mongoMeili.ts` pre hook). So the writer skips an event, with no record read, when `updatedFields` holds `_meiliIndex: true`, the mark of `mongoMeili.ts`'s raw bookkeeping write. It cannot use "only `_meili*` fields changed", because the `$project` above removes `content` and `text` from that list. The rollback rehearsal in FR-036 runs against a snapshot clone, so resetting flags cannot flood the live tenant's sync, and a real after-removal rollback sets `data: false` before the reset for the same reason. Turning data on again discards the saved token and reconciles, or the reset and sync writes would replay after the return. These events drop before the last-event rule, or a bookkeeping write would hide the edit it followed. Owner decision, 2026-11-10: FR-036 now names the snapshot clone of the trial tenant's data.

**Tenant context.** The writer runs inside `runAsSystem`, because no request context exists. At start it compares the analyzer version and queues reconcile on a mismatch (FR-026), but only after a backfill chain has finished, because reconcile before that would be an unrequested full backfill. A first start writes the baseline.

**Gap.** Resume failure alarms, restarts at the current position, then queues reconcile once a backfill chain has finished (spec edge case).

**Poison event.** Bounded retry with backoff, then skip with an IDs-only alarm; reconcile retries it.

**Liveness.** Alarms on lag events cannot fire if the writer stalls. So every process with data on emits `search.sync_status` each minute, with last-saved age and whether a lease holder exists, and the alarm covers both a high age and missing data.

**Rationale**: FR-023 to FR-025. The repository has no change-stream code today, so the reference `changestream.mjs` is the only prior logic.

## R-10 Vocabulary upkeep and rebuild

- **Decision**: Rows are §9's `{ _id: token, df }` plus `dfNext` and `r`. Only the writer counts, merging in memory and flushing with `$inc` in unordered bulk every `vocabFlushSeconds`.
- **Rebuild**: Reconcile starts a run number in `search_state.vocab.run`, then walks `msearch` and `csearch` by `_id`, merging counts in memory up to a bound and flushing `$inc dfNext` with `r` set to the run. The writer also stamps `r` on anything it flushes, so a new word survives. Finally a resumable pass copies `dfNext` to `df` in batches and deletes rows not stamped in this run. Counts are mixed during that pass, which FR-025 allows, and frozen plans protect paging. The cost of this rebuild is a question for the sandbox trial.
- **Budgets**: `maxVocabRows` truncates an alphabetical range read, so "most frequent first" holds only within the first rows by spelling. That is the bounded read the spec's edge case asks for; a long tail past the budget is not expanded.
- **Decreases**: `df` only increments between rebuilds, because the writer reads no old tokens. Reconcile corrects it.
- **Rationale**: FR-025, FR-027, and it keeps §9's shape. The list stays usable throughout, with no second source of truth for which rows count.
- **Alternatives**: `$unwind` + `$group` over 18 GB on a 0.5 DCU floor: not acceptable beside chat traffic. Generations with an `active` pointer: an extra cached read on each search, for a precision `df` does not need.

## R-11 Backfill, reconcile, verify

**Runner.** `jobs/runner.ts` polls `jobRequest:<id>`, and runs the chain backfill → indexes → word list → reconcile → verify and the `reconcileDays` timer. Turning data on starts sync; backfill starts only by request, so the operator chooses when load begins, unless the owner's `search.jobs.backfillOnStart` is on (see T120). All three are resumable jobs that only the lease holder runs, inside the API process, throttled by `search.jobs.batchSize` and `batchDelayMs`, and they yield to the event loop between messages. `config/search-job.js` requests them by writing to `search_state` and reports status. `pause` and `resume` are jobs too: backfill checks a pause flag between batches. Alarms notify the owner, who issues the pause (FR-028); nothing pauses on its own. The default delay gives about 22% of one core during backfill (1.4 ms × 200 per 1.28 s), measured against SC-008 on the first live backfill. `drop` runs in the script itself, because data is off and no lease holder exists.

**Collections.** Schemas set `autoCreate: false` and `autoIndex: false`, as model creation runs in every deployment and must leave nothing behind with search data off. Turning data on creates the collections. Backfill creates the record indexes after its load, per §9's measured order.

**Backfill and repair writes.** Backfill inserts with `ordered: false` and ignores duplicates, so a record sync wrote wins. Reconcile repair uses compare-and-set on the `h` and `v` it read, so a live edit between read and write wins, and is insert-only for a missing record. An older-analyzer rewrite therefore cannot overwrite newer text. Both then run the post-write source check ([R-09](#r-09-sync-writer)).

**Word list in the chain.** The chain's own word list step runs first, so reconcile skips its `vocab` phase there when it made no repairs. A reconcile outside the chain always runs it. **Reconcile phases.** `search_state.reconcile` holds `pass` (`count`, `repair`), `phase` (`messages→records`, `records→messages`, `conversations→records`, `records→conversations`, `vocab`) and one `lastId` per phase, so it resumes without losing or repeating the report. The counting pass writes and logs counts, which gives FR-027's report and SC-010, then the repair pass runs. It compares `h` and `v`. Triggers: after backfill and, once a chain has finished, after a gap or a token change at writer start, a runbook job after each deploy that changes tokens, monthly, and an operator job seven days into the trial (owner decision, 2026-11-10: the trial replaces shadow). The post-deploy job matters because during a rolling deploy an old task can retake the lease and write the older `v` behind a walk.

**Attribution.** The writer records each attributed pack's text and URL in `search_state.analyzer`. Shared code names no language, so `/api/search/meta` reads them there after a pack is disabled. When the writer finds at start that a pack with attribution left the analyzer, it sets `attributionUntilReanalyzed`. Reconcile clears it when no older `v` remains.

**Verification.** Compares by ID rather than by counts taken minutes apart. Walks both sides by `_id`. Age comes from the source `_id` timestamp, because `createdAt` is old for an import still within sync lag. Only sources older than 60 s at the snapshot count. Each mismatched ID is re-read against current source state, and it counts only if it is still wrong once sync has passed its time. Results store counts and IDs only.

**Verification before the writer exists.** The first backfill test on a live tenant runs with no sync writer, so nothing indexes a message created after backfill. Until T113 lands, backfill records `finishedAtId`, the source position it finished at, set back 60 s because IDs are made by app processes and a row saved just after the last read can sort below it. Verification checks only sources up to that position. A record whose source was deleted or stopped belonging after backfill stays until the writer exists, and FR-014's re-check at read time drops its hits, so it is reported as `orphans` and is not a failure. A source with no record that changed after backfill began, such as a message that finished streaming after backfill read it, is reported as `changedSinceBackfill` and is not a failure either. The writer's arrival removes these limits. **Mismatch loop.** A mismatch keeps the tenant not ready and alarms. The runner then runs reconcile and verifies again, up to three rounds, after which `verification.status` is `failed` and the owner is called (spec edge case).

**Readiness.** `verification.passedAt` must be later than `verification.invalidatedAt`. Config only changes by restart ([R-19](#r-19-config-channel)), so each process, in the background after it listens and with search data on or off, compares its `{ backend, data }` to `search_state.observed`. A read of an absent collection returns nothing, so a tenant that never turned search on stays as today. Moving to `meilisearch` from `search`, or `data` going off, sets `invalidatedAt`. With data on, after the collections exist, each process upserts `observed`, which writes the first value. So an old pass cannot serve after an abort (FR-037) or after sync was stopped. The runbook runs reconcile and verify before returning. A resume gap does not invalidate, since the spec keeps search serving through it.

**Rationale**: No new service; §9's load order; FR-027 and FR-028. `reset-meili-sync.js` is the precedent for an operator script.

## R-12 Concurrency, retry, cancellation

**Owner decision, 2026-11-10**: shadow is cut, so there is no second limiter and no detached run. One limiter serves every search.

- **Decision**: A per-instance limiter admits `maxConcurrentSearches` and fails immediately at the cap with `search_busy`. Each search runs up to `readConcurrency` reads, with title and message reads sharing them. A search joining a read another one started runs its own reads under its own limit, since `/search` and the sidebar are two requests; so one query from both surfaces can run `readConcurrency` per surface. Its read stops on the timeout or when its last waiter leaves ([R-08](#r-08-shared-read)). Reads pass `maxTimeMS`, `singleBatch` and a `batchSize` equal to the limit. `read/retry.ts` retries code 2 "Cannot open a new cursor" twice with jitter, then raises `search_busy`. Title reads bypass the limiter, per FR-017. A client disconnect before the response finishes aborts the search's remaining reads (FR-017). A process whose pack failed returns `search_failed`.
- **Superseded requests**: `useMessagesInfiniteQuery` and `listMessages` pass no `signal` today, and `SearchBar.tsx` debounces at 500 ms, so a typing user could hold several slots on different queries. React Query's `signal` is passed through `listMessages` and `listConversations`, so a superseded request closes and its slot frees.
- **Rationale**: FR-017, FR-018. No queue is a spec decision.

## R-13 Quality suite and public CI

- **Decision**: `packages/api/misc/search-quality/` holds the runner, mirroring `data-schemas/misc/documentdb/`, not in public CI. It takes the corpus and pack data by environment path. Only the runner is committed, reading `SEARCH_QUALITY_CORPUS`, `SEARCH_QUALITY_DIR`, `SEARCH_QUALITY_VOCAB`, `SEARCH_QUALITY_MONGO_URI` and `SEARCH_LANGUAGE_DATA_DIR`. The word list comes from the whole corpus, as in the reference, since `df` decides the rare and common split and the tiers. It imports the search service, so SC-001 to SC-003 measure the production path, including the shared read at limits 200 and 1,000. "First page" is `/search`'s page. "Top 200" and "top 1,000" are the ranked shared read at `sidebarLimit` 200 and 1,000: the same function the sidebar uses, and the reference's `limit` semantics. Concatenated load-more pages are a different order, recorded as a guard, not a gate. Any difference from the reference at stage 4 is recorded, and a re-baseline needs FR-034's written decision. Token parity (FR-007) compares against reference output generated out of tree. The golden queries, conditions and precision judge stay in `search-experiments`, because the judge uses the same BÍN-derived data, so nothing derived is committed before FR-045. Public CI runs the pack contract tests with a small fake dictionary pack and the real `en` pack, so CI still covers routing, reading and ranking.
- **Recorded difference, 2026-11-10**: On condition H the two readings of "top 200" differ. The first 200 of the read at limit 1,000, which is how the reference produced SC-003's 47, gives 47. The read at `sidebarLimit` 200 gives 41, because each job then sees only its newest 200 rows before ranking. Condition P gives 77 either way. The suite gates on the reference's reading and writes both. Choosing between them is a written decision under FR-034.
- **Rationale**: Spec assumptions, FR-045.
- **Alternatives**: Committing the 1.3 GB corpus: too large and needless, since a seed regenerates it.

## R-14 Metrics and alarms

**Owner decision, 2026-11-10**: probes are cut with shadow. SC-005 rests on SC-004's tests on the release and on log checks in the trial and each hold.

- **Decision**: Structured log events through `logger`, with counts, durations and stable codes only, under one `search.*` namespace ([contracts/telemetry.md](contracts/telemetry.md)). Alarms are metric filters on those events, in the infrastructure repository.
- **What search cannot measure itself**: One source per measure is in [contracts/telemetry.md](contracts/telemetry.md). No chat-path edit is needed: `packages/api/src/app/metrics.ts` already has `mongoose_query_duration_seconds` by model and operation, behind `METRICS_SECRET`, which is the only figure that isolates a save inside a long streaming route. Abort thresholds apply from backfill on every tenant (FR-028, FR-035), so a working scrape, named queries, alarms and two weeks of baseline are a per-tenant entry check for backfill and cutover. The runbook has them.
- **Probes**: Withdrawn. They existed because a leak in shadow was invisible, with new-search results discarded. In the trial and the hold the new search serves, so its results are what users see, FR-014's re-check runs on every hit, and reconcile counts any record whose source is absent or not indexable ([contracts/telemetry.md](contracts/telemetry.md)).
- **Rationale**: §10 expects log-derived figures, alarms are simple to attach to logs in every deployment whether or not it scrapes `/metrics`, and FR-020 forbids content.
- **Alternatives**: Search histograms in the existing `prom-client` registry: reasonable once scraping is confirmed everywhere, and additive later, so not needed for the gate.

## R-15 Client data needs

- **Decision**: `/api/search/enable` stays a bare boolean. `useSearchEnabled` calls it on every app load, so its status read is cached in-process for `statusCacheSeconds` (15), and the sync-progress check under `meiliResyncPending` for 60 s; the lighthouse lane measures it. A new `GET /api/search/meta`, called only by the About tab in Settings, returns the attribution and nothing else (owner decision, 2026-11-10: the panel is cut).
- **Load-more**: Keeps `useMessagesInfiniteQuery`, which already follows `nextCursor`. A page short after filtering auto-fetches up to 3 times (a UI constant, not a server lever), then shows a real load-more button, because `Search.tsx` pages only on scroll and an empty page has nothing to scroll. The button is also the keyboard path, and it shows a retry state when a later page fails, keeping what is on screen. `search_cursor_invalid` offers a restart. The default backend keeps today's toast at `Search.tsx:267`, per FR-041.
- **Pagination exposes query defaults**: Nothing overrides React Query's three retries or focus refetch, and today's null `nextCursor` hides both. So `search_busy` and `search_cursor_invalid` do not retry, as that adds load at the cap and delays the state by seconds. A search with more than one page does not refetch on focus, as that would re-read every page under a new anchor and reorder the list.
- **Failure states**: `search_failed` needs a state on `/search`, and `search_busy` and `search_failed` both need one on the sidebar, Archived Chats and shared links, so an outage never reads as no results.
- **Rationale**: Startup path rule in `AGENTS.md`; FR-042, FR-043.

## R-16 Planning defaults

Spec assumption: these get defaults at planning, from the reference where it has one, retuned from the sandbox by updating [contracts/config.md](contracts/config.md).

| Setting | Default | Source |
|---|---|---|
| `maxConcurrentSearches` | 4 | A cluster serving traffic sits at 1 DCU or above (§7), 12 cursors, against `4 × readConcurrency (2) = 8` short reads per task. A first search from idle meets the floor's limit, which the retry covers. The sandbox retunes this from `searches × reads × tasks`; a cap of 2 would reject one user typing through a cold read |
| `queryWordLimit` | 10 | Judgment; longest golden query is well below after stop words |
| `searchTimeoutMs` | 10,000 | Five times SC-007's 2 s |
| `syncTakeoverSeconds` | 30 | Same order as `LeaderElection`'s 25 s |
| `jobs.vocabCopyBatchSize` | 5,000 | A word list row is a token and two counts. At `jobs.batchSize` the copy pass spent its time in the per-batch wait: about 140 rows a second on the sandbox tenant |
| `jobs.batchSize` / `batchDelayMs` | 200 / 1,000 | §9's page size; the delay holds backfill near 22% of a core, tuned against SC-008 |
| `sharedReadMaxBytes` | 64 MiB | About 3% of the task's memory |
| `statusCacheSeconds` | 15 | Judgment; bounds staleness of `/enable` |
| `analysisCacheWords` | 100,000 | LRU; the reference's 2 million suits a batch tool, not a 2 GiB task. Affects speed only |
| `prefix.maxCommonReads` / `maxRareTokens` | 4 / 200 | Reference |
| `prefix.maxVocabRows` / `typo.maxVocabRows` | 50,000 | Above the reference's largest read (39,253), so results match on the corpus |
| `typo.maxCorrections` | 8 | Reference |
| `vocabFlushSeconds` | 300 | §9, "every few minutes" |
| `reconcileDays` | 30 | §9, monthly |

Constants tied to token format or the quality evidence stay in code with a comment: token cap 48, message cap 3,000, page 25, proximity 50, rare threshold 300, tier weights, typo length bands. Changing one changes SC-001 to SC-003, so it is a written decision rather than a tuning lever; FR-041 does not list them. The length bucket is the exception: FR-011 keeps `rank.lengthBucket` (default true) as a lever, changed only by a written decision that re-baselines SC-001 to SC-003 (owner decision, 2026-11-10: no panel re-run). The `shadow.*` settings are removed, and `largestUserId` is a top-level setting. The heartbeat is a third of the takeover time, derived rather than set.

## R-17 If the sandbox rules out change streams

FR-023's branch. §9's fallback replaces `sync/stream.ts` and `sync/writer.ts`: hooks at `save` and `findOneAndUpdate`, explicit calls in `bulkSaveMessages`, `bulkSaveConvos`, and the tag and temporary paths, plus a nightly two-way reconcile. It contradicts this plan's "no write-path edits", which is why FR-023 replaces that clause and adds SC-008's chat-save check before any tenant's cutover. Analyzer, reads, jobs and client carry over. If the sandbox trial fires this, the sync tasks are re-planned before any production tenant starts (T017).

## R-18 FR-011's panel re-run

**Withdrawn, owner decision 2026-11-10**: the panel is cut, so there is no re-run, no `panelRound` and no panel record. The length bucket stays on by the quality evidence (FR-011). The text below is kept for the record only.

Query text is not stored (FR-033), so the server cannot name "the failed queries". An opted-in panellist's browser keeps the queries they rated worse in a local Jotai atom, cleared on opt-out and at logout, and never sent except as that person's own search. If the panel fails, the owner sets `rank.lengthBucket: false` and `shadow.panelRound: 2` by rolling restart, and panellists re-judge those queries. Records store under `panel:<round>:<uuid>`, so rounds never mix in SC-013's and SC-014's tallies, and each record still holds only FR-033's two facts, with no date. Latency samples from that period are excluded from SC-006 and SC-007.

## R-19 Config channel

- **Decision**: `search` joins `BASE_ONLY_CONFIG_SECTIONS` (`packages/data-provider/src/config.ts`), so no config document can change it. It is read from the YAML base config once at process start, and `createSearchService` holds that snapshot for the process's life. So "one setting change" is a `librechat.yaml` change plus a rolling restart, which the runbook times (SC-017). `search` is not read through per-principal merging, so no role or user override can give one user a different backend, and the writer and requests always agree.
- **Rationale**: `AppConfigService` caches the base config indefinitely (`packages/api/src/app/service.ts`), so polling would see nothing, while DB overrides merge per principal on a 60-second cache and the writer has no principal. Request paths need no new read, which keeps the load path clean.
- **Alternatives**: Polling with `getAppConfig({ refresh: true })`: flips one process at a time with no order, for little gain given abort thresholds act in hours. A `search_state` flag flipped by script: a faster flip, but it adds a read to every search and a second source of truth.

## R-20 Upstream search check

- **Checked 2026-11-04** (T010, §9). Upstream has shipped no replacement for Meilisearch. Its `main` holds proof-of-concept infrastructure in `search/` (Postgres, FerretDB, ClickHouse), with no application code, and `aproorg/0.8.8` has the same directory. Unmerged `claude/chat-search-*` and `claude/search-track*` branches were last touched on 2026-08-11. They need those separate services, which this feature's spec rules out.
- **Owner's decision, 2026-11-04**: continue with this design and keep the directory name.
- **Risk accepted**: one of those branches adds 41 files under `packages/api/src/search`, the directory this plan uses, so a fork sync would conflict if it merges. The check repeats before cutover.

