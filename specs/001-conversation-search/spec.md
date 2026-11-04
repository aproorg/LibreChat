# Feature Specification: Icelandic and English Conversation Search Without a Separate Service

**Feature Branch**: `search-b4-spec`

**Created**: 2026-11-04

**Status**: Draft

**Input**: User description: the Icelandic and English conversation search feature (design B4), replacing Meilisearch.

**Source of truth**: `librechat-search-documentdb-design-final.md` ("the design"), with its scripts in `search-experiments/`. Both live outside this public repository. Section references (§) point there; evidence stays there. Technology choices stay in the design for `/speckit-plan`. Where this spec decides something the design leaves open, it says "Spec decision"; `search-experiments/final/` is the reference where the design's prose and scripts differ.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Find a word in any form (Priority: P1)

A chat user searches one word in any form and sees true matches near the top, in `/search` and in the sidebar. Inflections, compounds and words typed without Icelandic letters all reach the message.

**Why this priority**: This is the main gain. Today `hestur` does not reach `hestinum` at all.

**Independent Test**: Load the padded test corpus (see Success Criteria) and run the inflection, compound and no-accent queries as the test user.

**Acceptance Scenarios** (Scenarios 1-3 use the padded test corpus, where crowding is limited):

1. **Given** a message containing `hestinum`, **When** the user searches `hestur`, **Then** that message is on the first page.
2. **Given** a message containing `tekjuskattur`, **When** the user searches `skattur`, **Then** that message is on the first page.
3. **Given** a message containing `börnum`, **When** the user searches `bornum`, **Then** that message is on the first page.
4. **Given** messages containing `þjónustuver` and others containing only `ver`, **When** the user searches `þjónustuver`, **Then** the `ver`-only messages do not match, because a query word is never split into parts.
5. **Given** a message containing the compound `fyrirtæki` and no form of `taka`, **When** the user searches `taka`, **Then** that message does not match, because a compound's parts count only as nouns and function-verb homographs are excluded.
6. **Given** a message containing the word itself and another containing it only as a compound part, **When** the user searches that word, **Then** the compound-only message ranks lower.
7. **Given** a matching message and a matching conversation title, **When** the user searches in the sidebar, **Then** it shows the union of title and message matches, sorted by the conversation's last update as today.

---

### User Story 2 - Harder queries, older matches, clear states (Priority: P2)

A chat user can misspell a word, type the start of the last word, use several words or a natural-language question, load older matches, and search shared links. The UI says why when search is busy or a query holds only very common words.

**Why this priority**: These keep parity with Meilisearch and make the known losses understandable instead of silent.

**Independent Test**: Run the typo, prefix, multi-word and natural-language queries; page through a word with thousands of matches; force a busy error and a stop-word-only query.

**Acceptance Scenarios**:

1. **Given** a non-word misspelling such as `kubernets`, **When** that word matches nothing, **Then** corrected matches are returned.
2. **Given** a query `hjúkr`, **When** the user searches, **Then** words starting with it match, up to the prefix budget, and only the last query word expands this way.
3. **Given** a multi-word query, **When** the messages holding all words fill the page, **Then** only those are shown; **When** they do not, **Then** trailing words are dropped until the page can fill or one word remains, and fuller matches rank first.
4. **Given** the natural-language query `hvað kostaði ráðgjafinn` in the padded test corpus, **When** the user searches, **Then** common words are ignored and the expected message is on the first page.
5. **Given** more matches than one page, **When** the user loads more repeatedly, **Then** every match is reached with no duplicates and none lost, for single-word and multi-word queries.
6. **Given** the query `vera`, **When** the user searches, **Then** no results are returned and a localized hint asks them to add a word.
7. **Given** a search is rejected at the per-process cap or exhausts its cursor retries, **When** it fails on `/search`, **Then** a localized busy state appears, distinct from "no results", with no raw error text.
8. **Given** message search fails while title search succeeds, **When** the sidebar shows results, **Then** it shows they are partial and an alarm fires.
9. **Given** shared links, **When** the user searches them, **Then** links whose conversation title or tag matches are returned, with the same word-form behaviour.

---

### User Story 3 - Operator migrates tenants on numeric gates (Priority: P3)

An operator moves one tenant at a time through the engine upgrade trial, measurement, backfill, shadow comparison with Meilisearch, cutover and rollback, and decides from numbers fixed in advance.

**Why this priority**: Users only get P1 and P2 safely if each step after the engine upgrade is reversible, the upgrade has a tested way back, and the go/no-go is objective. Removing the service is a goal in itself.

**Independent Test**: On a non-production tenant, run backfill, shadow and cutover, then roll back at each of the three stages: before cutover, during the 30-day hold, and after service removal, following the runbook.

**Acceptance Scenarios**:

1. **Given** the sandbox measurement on the target engine misses the shadow latency targets, or another FR-031 stop rule fires, **When** the result is read, **Then** tenant work stops and the design is reopened.
2. **Given** a backfill crashes midway, **When** it restarts, **Then** it resumes from its saved position and overwrites no newer record.
3. **Given** a tenant's per-user verification has not passed, **When** the availability check runs on the new backend, **Then** search is reported not ready.
4. **Given** shadow mode, **When** a user searches, **Then** Meilisearch serves the results and the new search runs detached and capped, and its failure or slowness never affects what the user gets.
5. **Given** any abort threshold is crossed, before removal, **When** the owner acts, **Then** the tenant returns to Meilisearch by one setting change and a written cause is recorded.
6. **Given** Meilisearch has been removed, **When** rollback is required, **Then** the runbook redeploys it, resets its sync state, runs a full sync, and keeps search hidden until that sync finishes.

---

### User Story 4 - Maintainer adds a language later (Priority: P4)

A maintainer adds a language by writing one language pack and enabling it for a tenant, with no change to storage, reading or ranking.

**Why this priority**: It protects future languages but delivers nothing to users today. Only Icelandic and English ship.

**Independent Test**: Run a throwaway stemmer pack through the same pack contract tests as the Icelandic and English packs and enable it in a test tenant; confirm no storage, read or ranking code changed.

**Acceptance Scenarios**:

1. **Given** a new pack enabled on a tenant, **When** a new message arrives, **Then** it gets the new pack's tokens at once.
2. **Given** a new pack enabled on a tenant, **When** older records are not yet rewritten, **Then** they still match by exact form, and a re-analysis rewrites them.
3. **Given** a tenant with the Icelandic pack disabled, **When** it runs, **Then** it does not carry that pack's memory cost, and the BÍN attribution follows FR-043.

---

### Edge Cases

Sync and records:

- **Bulk imports, forks, duplicates**: their messages become searchable with no chat-path change, even though they bypass write hooks.
- **Chat turned temporary**: its search records are removed, including by a bulk update that leaves timestamps unchanged, and by a single-message update flipping the temporary flag.
- **Tag rename or deletion, title edit**: conversation records follow, including a bulk tag rename.
- **External and retention deletes**: deletes made outside the application, including TTL deletes, remove the search records within the SC-009 lag. If the sandbox shows TTL deletes emit no event, reconcile must catch them, at an interval the owner accepts in writing against the tenant's retention duties.
- **Edited message**: its record is replaced; a metadata-only update writes nothing.
- **Unfinished message**: not searchable until finished, then searchable without further action.
- **Word newer than the word list**: still findable before the next word list update.
- **Sync gap or hibernating tenant**: when resume fails because the gap outlived the change log, the system alarms, then (Spec decision) restarts sync at the current position, then reconciles. Search keeps serving meanwhile, and missing records appear as reconcile progresses. A tenant that hibernates takes its engine upgrade on wake-up.
- **Sync writer dies**: another process takes over within the configured time and resumes from the saved position; no event is lost if the gap is within the change log.
- **Backfill verification mismatch**: the tenant stays not ready, an alarm fires, and reconcile runs before verifying again. After three failed rounds the owner is called. Spec decision, as is verifying after the post-backfill reconcile.
- **Rolling deploy across an analyzer change**: records and queries at different versions still match by exact form, and reconcile runs after the deploy finishes.
- **Search data turned off after being on** (Spec decision): sync stops, and the runbook drops the records, word list and sync state by a deadline set in the tenant's retention rules, including after a permanent abort. Turning it back on before the drop needs a reconcile and per-user verification before the new search can serve, and after the drop a new backfill.
- **Analysis or write fails repeatedly on one message** (Spec decision): bounded retry, then skip with an alarm using IDs only, so sync does not stall; reconcile retries it later.
- **A pack or its data fails to load** (Spec decision): sync and backfill stop, the new backend reports not ready, an alarm fires, and chat keeps working. No record is written claiming tokens it lacks.
- **Very long message**: tokens stop at the cap and the message stays searchable by the tokens kept. A word over 48 characters, counted before folding, is neither indexed nor used in a query.

Queries and paging:

- **Message written between pages**: stays out of the running pagination, with no duplicates or shifts. The same holds for any record that appears or changes below the anchor mid-pagination (a message finished late, a record within sync lag, an edit that now matches, a reconcile write): no duplicate, and no other match lost, whether or not it shows.
- **Message edited or deleted between pages**: a deleted or hidden message never shows; the rest of the pagination continues.
- **Busy or failure during load-more**: results already shown stay, and a retry continues from the same position.
- **Page short after filtering**: when visibility filtering leaves a page short or empty while more matches exist, load-more stays available and continues.
- **Malformed, forged or stale cursor**: including one from before a backend switch or for a different query. It returns a safe non-success with a stable code, which the client can offer to restart from, and it can never widen scope beyond the user.
- **Stale search record for a hidden or deleted conversation**: never shown, because hits are re-checked against current visibility before display.
- **Pasted decomposed (NFD) text**: matches its composed form.
- **Code words**: `constructor` and similar words must not crash indexing or search; `node_modules` and `.NET` stay findable.
- **Stop-word false friends**: `fór` and `ís` stay searchable, because stop words are judged on the unfolded word, while `hvernig`, `þegar` and `how` are ignored.
- **No usable words**: a query such as `???` returns the ordinary empty state, not the stop-word hint. The word limit applies after stop words are removed, and a query over it uses its first words.
- **Short prefix, trailing stop word**: a stop word is removed before the "last word" is chosen. Prefix expansion stays inside its budget, most frequent words first, and the budget also bounds the word list rows a short prefix may read.
- **Database cursor limit**: retried twice with jitter, then the busy state.
- **Heavy user, crowded word**: correct older matches may be off the first page; load-more reaches them. With the sidebar limit lowered, older conversations leave the sidebar but `/search` load-more still reaches them.

Accepted gaps, not bugs (each is counted or judged in shadow where §10 says so):

- Folding merges `lán`/`LAN` and `bíll`/`bill`.
- A misspelling that is itself a word gets no correction. Neither does a word under 5 letters or one with a wrong first letter, the same budget as Meilisearch.
- `Jóni` reaches `jóna`, not `jón`; last-word prefix still finds it. `C#` indexes as `c`.
- Only trailing words drop, so in `xyzzy kerfi`, an unmatched first word returns nothing even though `kerfi` has matches.
- A stop word typed without letters (`hvad`) is not recognized as a stop word, so `hvad kostadi radgjafinn` can lose results; and `for` gets the stop-word hint when `fór` was meant. The plan tests these; shadow counts queries typed without Icelandic letters.
- A message just sent may not be searchable for up to the SC-009 lag, plus 30 seconds from the shared read.

## Requirements *(mandatory)*

### Functional Requirements

**Matching**

- **FR-001**: Search MUST match a word through its folded surface form, the lemmas of every enabled dictionary pack that knows it (including all of BÍN's forms on the indexing side), and marked noun compound parts. A word outside the dictionary's core forms also gets the stem from every enabled stemmer pack, so `used`, `using` and `use` meet, unless the Icelandic pack is enabled and the word has Icelandic letters: that test belongs to the Icelandic pack, not to shared routing (§4). Lemmas too common to search on their own, such as `vera` and `hann`, are not added. Where this text and the reference analyzer differ, the reference wins.
- **FR-002**: Compound parts MUST be added on the indexing side only, including for unknown words without Icelandic letters (`uppsetning` finds `kerfisuppsetning`). A query word MUST NOT be split. Function-verb homographs are excluded as parts (`search-experiments/final/analyze.mjs`).
- **FR-003**: Matching MUST ignore case and Icelandic letters per the design's fold rule (þ→th, ð→d, æ→ae, ö→o, accents stripped), and normalize decomposed text before splitting. Query-side lemma expansion through folded forms MUST apply only to words typed without Icelandic letters, so `mál` does not expand through `mal`.
- **FR-004**: Lemma guessing for unknown words MUST apply only to words with Icelandic letters, so `ran` does not gain the guessed lemma `ra`.
- **FR-005**: Stop words MUST be dropped per word on the unfolded surface, using the combined stop lists of enabled packs.
- **FR-006**: Routing MUST be per word with no language detection, so a mixed-language message works (§4).
- **FR-007**: Words over 48 characters MUST NOT be indexed, and each message MUST be capped at 3,000 tokens. For the first analyzer version with Icelandic and English enabled, tokens on the design's corpus MUST equal those of the reference analyzer (`search-experiments/final/analyze.mjs`), which ties the build to the quality evidence (§10 step 5). Later versions update the reference by written decision.
- **FR-008**: Fields by surface. `/search`: message text, thinking and steer text, as message hits. Sidebar: those plus conversation titles and tags. Shared links: titles and tags (Spec decision: tags stay matched, as today's shared-link search does). Nothing MUST match sender, user or ID fields, or mid-word apart from compounds.

**Reading and ranking**

- **FR-009**: Message search MUST try tiers in order (exact form, lemma or stem, compound part, last-word prefix, then typo correction for a word that matches nothing) and stop once the page can fill (§5). Spec decision: title and tag search has no page, so it takes all tiers and requires all words, up to today's hit limit (1,000). §11 lists it as untested, so the plan tests tiers and multi-word queries on titles.
- **FR-010**: Multi-word queries MUST require all words, and drop trailing words if the page cannot fill.
- **FR-011**: Ranking MUST use, in order: words matched; tier weighted by word rarity; proximity for multi-word queries, among the top 50 candidates by those first two and then recency; a coarse length bucket, shorter first; then newest first. The panel judges the bucket: a panel pass keeps it, and if the panel fails, the failed queries re-run with it disabled before the owner decides. Removing it by written decision re-baselines SC-001 to SC-003 in the same decision.
- **FR-012**: A query of only stop words MUST return no results plus a stable reason, on every search surface, which the UI turns into a localized hint.
- **FR-013**: Load-more MUST work on `/search` with a page of 25, for single-word and multi-word queries, with no duplicates, no lost matches against a deep read, and messages written after the first page staying out. For multi-word queries (Spec decision) paging runs through all-word matches, then each dropped-word set, and "every match" means that union. Multi-word paging is untested in the design and is a plan risk (§5).
- **FR-014**: `/search` hits MUST pass through the same conversation visibility and private-field filtering as other message reads, so stale records cannot show hidden or deleted conversations and private fields never reach the client.
- **FR-015**: The sidebar MUST show the union of title hits and the ranked message window, sorted by last update. The sidebar limit caps the message window only. The two surfaces fired by one search in one process MUST share one read, scoped per user and tenant, sized for the larger surface and counted once against the cap, with staleness of at most 30 seconds in the ranked window (§5). Visibility checks still apply on display, load-more keeps the first page's anchor, and failed reads are never shared. The first page MUST be the same whichever surface fired first, and the quality suite runs through the shared read at limits of both 200 and 1,000.
- **FR-016**: Shared-link search MUST cover titles and tags with the same word-form behaviour and today's hit limit (1,000), and keep its existing paging and filtering of the links shown.
- **FR-017**: Each process MUST enforce the concurrent-search cap, and a search at the cap fails as busy at once (Spec decision: no queue). Each search MUST run at most the configured number of reads at once, hold no database cursor open after a read completes (§5), and stop within a configured timeout. Spec decision: a client disconnect stops remaining reads and frees the slot, and the same applies to shadow reads. Title reads are exempt from the cap.

**Failures**

- **FR-018**: Failure behaviour by surface:

  | Failure | `/search` | Sidebar | Shared links |
  |---|---|---|---|
  | Message read: cursor limit after two jittered retries, per-process cap, or timeout | Stable busy code, HTTP 503, localized busy state replacing today's hard-coded toast | Title matches with partial flag, alarm | n/a |
  | Message read fails for other reasons | HTTP 500 with a stable code, no raw text | Title matches with partial flag, alarm | n/a |
  | Title read: cursor limit after two retries, or timeout | n/a | Stable busy code, HTTP 503, message hits discarded | Stable busy code, HTTP 503 |
| Title read fails for other reasons | n/a | HTTP 500 with a stable code, message hits discarded | HTTP 500 with a stable code, replacing today's empty 200 on the new backend, so an outage never reads as no results |

- **FR-019**: The availability check MUST report ready as follows. Meilisearch and shadow: today's health check, plus "sync complete" after a rollback, so search stays hidden during a post-removal full sync. New search: per-user verification has passed. The `SEARCH` switch off: not ready, as today. Spec decision on a misconfigured search data setting (off): the new search is not ready, shadow serves Meilisearch with no detached run, a configuration error is logged in both cases, and chat keeps working.
- **FR-020**: Raw errors, query text and document content MUST NOT reach logs, and error responses carry only a stable code. Shadow logs carry counts and timings only. Sync never logs a whole document.

**Data and sync**

- **FR-021**: Search data MUST live in new derived records for messages and conversations, a per-tenant word list and sync state, in each tenant's existing database and with tenant scoping. Existing messages and conversations MUST NOT change in shape, or gain fields or indexes.
- **FR-022**: The unredacted private copy of a message, tool output, temporary chats, subagent messages and threads MUST NEVER enter search records. Canonical redacted text is what gets indexed, so searching a redacted value finds nothing (§2). Unfinished messages wait until finished.
- **FR-023**: Sync MUST add no work to the chat save path, and MUST catch every write path §9 names, including those outside the application. If the sandbox rules out the primary mechanism, the §9 fallback applies; it replaces this requirement's chat-path clause, FR-024, the reconcile interval (nightly) and, for external deletes, the SC-009 lag (up to a night). It also replaces FR-025's and FR-039's sync assumptions and FR-028's "start sync first". It then needs SC-008's chat-save check before shadow.
- **FR-024**: At most one sync writer MUST be active per tenant, inside the existing API process and with no new service, including a paused writer that lost its turn. Another process takes over within a configured time. Changes MUST apply in order and resume after restart, and unchanged text MUST write nothing.
- **FR-025**: Word list upkeep MUST add no per-message write and only the active writer maintains it. Counts may drift, since they only order expansions and rarity.
- **FR-026**: The system MUST identify records from an older analyzer. Any change that alters tokens (a pack, a stop list, shared folding or splitting, a cap) MUST trigger a re-analysis of them, through reconcile. A language needing new shared folding is therefore a token change as well as a new pack.
- **FR-027**: A throttled two-way reconcile MUST check that every indexable message and conversation has a current record and every record has a source, and MUST rebuild the word list from scratch. It MUST report missing and orphan counts before repairing them, and run after backfill, after a stream gap, after a token-changing change, seven days into shadow (for SC-010), and monthly, as one resumable run per tenant that never overwrites a newer record. Spec decision: conversation records are covered as well as messages.
- **FR-028**: Backfill MUST be throttled, start sync first, resume after a crash, never overwrite a record sync wrote, follow the load order in §9, rebuild the word list, and verify per user, before reporting ready, that record counts exactly equal indexable messages and conversations older than 60 seconds at the snapshot (Spec decision: conversations, and the 60-second window from SC-009). Spec decision: from backfill start on every tenant, the abort thresholds of SC-008 and SC-011 apply, and the action is to pause the backfill.
- **FR-029**: Reads MUST always scope by user, so the tenant-wide word list cannot return another user's message. Its only exposure is a timing side channel, an accepted risk. Each tenant's retention rules MUST name the word list, which keeps names until the next reconcile.

**Operating and migrating**

- **FR-030**: Per tenant, a search data setting MUST turn sync, backfill and the language packs on (Spec decision: separate from backend selection, because they run while Meilisearch serves). Off is the default and is identical to today: no pack loaded, no attribution, no new records. Backend selection MUST offer Meilisearch (default), shadow and the new search; the last two need the search data setting on. Meilisearch keeps serving until the tenant passes its gate.
- **FR-031**: Before tenant work, the operator MUST gather per-user message counts per tenant, identify the Azure deployments' database, and run the sandbox measurement (§10 step 3). Latency that misses the shadow targets on the target engine stops work. Spec decision on the other answers: sync is ruled out if it misses SC-009 or any change type other than TTL deletes; a read leaving a cursor open fails FR-017; and each remaining answer gets a written verdict from the owner before tenant work. The upgrade to engine 8.0 follows §8 for every AWS tenant, in batches: one engine for the fleet. First, a trial upgrades a clone of the largest tenant, times the downtime, and runs LibreChat's database compatibility specs and `npm run lighthouse` on it. Those also rerun on later releases. A blocker found on the clone moves to the §8 fallback, if that engine passed the sandbox; otherwise the design reopens. Each tenant keeps a pre-upgrade snapshot, and the runbook states the restore-to-new-cluster path and its data-loss window. Spec decision: a blocker found in rollout halts it, keeps healthy upgraded tenants on 8.0, and reopens the design. The upgrade precedes search work on tenants.
- **FR-032**: Shadow MUST run on the tenant holding the largest user that also has daily Icelandic-speaking users, chosen from the message counts, and start after that tenant's first live backfill. It MUST run at least two weeks and record both §10 lists: per-search metrics and measures on real text.
- **FR-033**: In shadow, the new search MUST run detached from the user's request under its own cap, on the same queries from `/search`, the sidebar and shared links, and count what the cap drops. Spec decision: load-more stays out, as Meilisearch serving has none, and tests cover it; the runbook sets a maximum drop share before shadow, and above it the latency results are invalid. At least 3 Icelandic speakers opt in to a localized side-by-side view limited to their own searches. It shows their query to them, says when the new search was dropped or failed, and stores only two facts without query text: better, equal or worse; and whether a known message was missed.
- **FR-034**: Spec decision: SC-001 to SC-004 MUST pass before shadow starts, and again on any analyzer or ranking change before a later tenant's cutover. The migration owner MUST decide against SC-005 to SC-014. All pass: cut over. A measure short of its sample minimum counts as not measured. An abort threshold crossed: return to Meilisearch with a written cause. A target missed with no abort threshold, or a measure not measured (Spec decision): the tenant stays on Meilisearch while the owner extends shadow or fixes and re-runs it. Targets change only by decision in writing. The rule for accepting the targets is in Assumptions.
- **FR-035**: Cutover MUST go tenant by tenant. Spec decision: after the shadow tenant passes, each later tenant needs a verified backfill before cutover. Also a Spec decision: during every tenant's 30-day hold, the shadow tenant's included, the abort thresholds of SC-005, SC-008, SC-009 and SC-011 apply, and SC-006 alarms for the owner to decide. The panel and the shadow itself do not repeat.
- **FR-036**: Spec decision: during the 30-day hold, Meilisearch MUST stay running and in sync, so returning takes one setting. Only at cutover plus 30 days may it and its volume be removed from a tenant (Spec decision: together; rollback after that rebuilds from an empty volume). The app MUST run cleanly with Meilisearch unset. Rollback after removal MUST reset Meilisearch's sync state before the full sync, keep search hidden until it finishes, and be timed once on the shadow tenant, using a parallel Meilisearch against that tenant's data while the new search keeps serving (Spec decision). The new search data can be dropped with no effect on anything else; the engine upgrade stays.
- **FR-037**: Spec decision: returning to the new search after an abort MUST require reconcile and per-user verification to pass again. Sync keeps running while the search data setting stays on.
- **FR-038**: The capacity floor MUST stay at its default (0.5 DCU) unless, checked weekly from metrics in working hours, a tenant fires the rule over 7 days: any cursor error on any route; peak cursors above 80% of the limit in 3 or more 5-minute periods; or first-search-after-idle p95 above 2 s with 20 or more samples. Then go to 1.5 DCU, then 2 if it still fires. If it still fires at 2, stop and reopen the design. Come back down after 30 days with no trigger. These thresholds are defaults, tunable from sandbox and shadow data by written decision, and applied from metrics, never from a list in the public repository.
- **FR-039**: Setup MUST include per-cluster sync enablement and longer change-log retention (§9), targeting 7 days and recording each tenant's value, with an alarm when sync lag crosses the SC-009 thresholds or a resume fails.
- **FR-040**: The release checklist MUST verify that the fast query plan the design relies on still holds, and alarm when p95 crosses SC-006 (§8).

**Configuration, UI and licence**

- **FR-041**: These MUST be configurable through the existing app configuration, with defaults: search data (off), backend (Meilisearch), languages (Icelandic and English), sidebar limit (1,000, today's value), rank window (200), concurrent reads per search (2), maximum concurrent searches per process, query word limit, shadow cap, search timeout and sync takeover time (Spec decision: these four added to §9's list), prefix and typo budgets, word list flush interval, reconcile interval. With the defaults, results, data and API contracts MUST stay as today, and the new UI states in FR-042 appear only with shadow or the new search.
- **FR-042**: All new UI text MUST be localized through the existing mechanism, with English keys only, with busy, partial and stop-word states announced to assistive technology and load-more and panel controls working by keyboard. It covers loading, empty, success, failure, partial, busy, stop-word and shadow-panel states.
- **FR-043**: While the search data setting is on and the Icelandic pack is enabled, including in backfill and shadow, and after that pack is disabled until re-analysis finishes (Spec decision), the `/search` view (Spec decision on location, to confirm against the FR-045 answers) MUST show the attribution, verbatim in every locale, as "The Database of Icelandic Morphology. The Árni Magnússon Institute for Icelandic Studies. Author and editor Kristín Bjarnadóttir." with `https://bin.arnastofnun.is`. Its surrounding label is localized. The repository MUST carry a notice stating all changes to the data, under CC BY-SA 4.0 (§9).
- **FR-044**: Third-party language data that could vanish MUST have a vendored copy with its upstream checksum recorded and the licence duties in §9, including the derived table's own notice.
- **FR-045**: Spec decision: the §11 licence answers (BÍN terms, CC BY-SA "Share", the lemmatizer package's licence) MUST be in hand before that data enters this public repository or the first tenant image. Until then the vendored copy stays private: tests that need it run outside public CI, and public CI skips only those. A negative answer stops tenant rollout and reopens the choice of language data in the design.
- **FR-046**: All language knowledge MUST sit behind one pack interface (§4), selected by configuration. Adding a language MUST NOT change storage, reading or ranking. The Icelandic pack MUST load only when search data is on, within §4's memory cost, with no startup-time regression, checked before shadow. A new pack MUST add golden queries, pass the shared contract tests, and measure tokens per message and stop-word collisions on real text in that language.
- **FR-047**: Specs, code, tests, logs and PR text in this public repository MUST NOT carry tenant names, hosts or IPs.

### Key Entities

Fields and shapes are in §4 and §9.

- **Message search record**: derived from one indexable message.
- **Conversation search record**: derived from one conversation's title and tags.
- **Word list**: per tenant, with approximate document counts. Orders expansions and rarity, and serves prefix and typo lookup. Tenant-wide; may contain names.
- **Sync state**: per tenant; who writes, where sync resumes, where backfill resumes.
- **Language pack**: all knowledge of one language, including its optional attribution.

## Success Criteria *(mandatory)*

### Measurable Outcomes

**Quality, on the design's padded test** (condition P, §6): 84 queries as a 2,000-message user, with dates spread evenly and each expected sentence inside a noise message. A pass needs every expected message on the first page of 25, no forbidden message, and the right first result where one is named (Appendix A).

- **SC-001**: At least 63 of 84 queries pass (Meilisearch today: 43).
- **SC-002**: At least 76 of 84 have all expected messages in the top 200, and at least 92 of 113 expected messages are on the first page.
- **SC-003**: Precision at 25 is at least 0.98 on the 20 flood-prone queries. No category in the §6 table scores below B4's row, including inflection on the first page 9 of 12, compounds in the top 200, 7 of 7, and no Icelandic letters on the first page, 11 of 11. On the 100,000-message condition H: at least 32 on the first page, 47 in the top 200, and precision at 25 of 0.90.
- **SC-004**: At every test and throughout shadow, no result shows another user's content, a temporary chat, a subagent message, tool output or private text.

**Shadow gate** (§10), measured on the shadow tenant, app-side. The runbook fixes these terms before shadow starts, not after: "warm" (not the first search after idle), "normal load", "working hours", and the chat save baseline (the tenant's preceding two weeks unless the runbook says otherwise). Spec decision: each latency measure, the largest user's included, needs at least 20 samples.

| ID | Measure | Pass | Abort immediately |
|---|---|---|---|
| SC-005 | Other users' content, temporary or subagent results, tool output or private text, from synthetic probes and log checks | 0 | Any |
| SC-006 | Warm search p50 / p95, all users; largest user p95 | ≤ 150 / 500 ms; ≤ 1 s | |
| SC-007 | First search after 30+ idle minutes, p95 | ≤ 2 s | |
| SC-008 | Cursor errors; chat save p95 | 0 at normal load; within 10% of baseline | Any on a chat route, or above 0.1% of searches; 25% worse for 1 hour |
| SC-009 | Sync lag | p99 ≤ 60 s | Above 1 hour |
| SC-010 | Completeness after a week, from reconcile | Drift ≤ 0.01% of messages | |
| SC-011 | Time pinned at maximum capacity | ≤ 5% of working hours | Pinned for 1 hour |
| SC-012 | Database capacity hours against pre-shadow baseline, extrapolated from like periods in shadow | Within 300 DCU-hours per 30 days, or accepted in writing | |
| SC-013 | Panel on at least 100 real queries | Better or equal on ≥ 80% | |
| SC-014 | Same panel: a known message Meilisearch found and the new search did not | ≤ 10% of queries | |

**Goal and maintainability**

- **SC-015**: After cutover and the 30-day hold, a migrated tenant runs no separate search service or search volume.
- **SC-016**: A throwaway language pack whose words include letters from the Icelandic set passes the contract tests, with the Icelandic pack on and off, and zero changes to storage, read or ranking code.
- **SC-017**: Rollback before cutover and during the hold takes one setting change, and the runbook records how long it takes to reach all processes; rollback after removal completes from the runbook and its duration is recorded once.

## Assumptions

- `/search` and sidebar searches are always scoped to the signed-in user; admin or cross-user search does not exist and is not added.
- Accepted losses against Meilisearch (§1): higher latency within the targets, stop-word-only queries returning nothing, one fewer prefix and one fewer English first-page result in the test, no matching on sender, user or ID fields.
- Removal gains no relevance over Meilisearch with the same tokens, and is roughly cost-neutral; the service's removal is the reason to proceed (§1, §7).
- Scope: AWS-hosted tenants. Out of scope: languages beyond Icelandic and English, languages without spaces, semantic search, mid-word substring matching, searching tool output, a read replica, the two Azure deployments, which keep Meilisearch for now (§2).
- The padded test scripts are outside the repository. The plan brings the corpus and queries in, or runs them from there, without tenant data.
- The evidence has limits: B4 has no database latency figures, sync has never run on the target database, ranking was tuned against these scores, and §11 lists what is untested (pack interface, end-to-end path, title and tag search, mixed load, the shared window, the per-process cap). The sandbox and shadow exist to settle them.
- The gate targets are adopted from §10 as the feature's success definition. The migration owner still confirms them before shadow starts (§11 question 5).
- Later tenants inherit the shadow tenant's relevance and speed verdict, as the design runs one shadow and then cuts over tenant by tenant (§10 steps 11 and 12).
- Maximum concurrent searches, query word limit, shadow cap, search timeout, takeover time, prefix and typo budgets, and flush interval get defaults during planning, from the reference scripts where they have one and otherwise from the sandbox.

### Dependencies

- Answers to the design's open questions (§11): BÍN terms, the legal reading of CC BY-SA 4.0, the licence of the third-party lemmatizer package (gated by FR-045), and which database the Azure deployments run. Infrastructure-module changes for the engine upgrade live in the separate infrastructure repository (§8).
- Upstream's own search direction is checked before implementation and before cutover (§9).
