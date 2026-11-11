# Review log: conversation search spec

Three fresh-context reviews, run one after another. Each reviewer received only the spec path and the design path. "The design" is `librechat-search-documentdb-design-final.md`. FR and SC numbers are those of the spec at the time of the fix, and later rounds may renumber them.

## Round 1

44 numbered findings, plus one note about the checklist. Applied 39, partly applied 4, rejected 1 and the note. The reviewer's own summary line said 38; the report numbers to 44, and this log counts those.

I checked the code claims behind findings 2, 17, 20 and 21 against `search-experiments/final/analyze.mjs` and `search.mjs`, and finding 6 against `conversation.ts`. They hold. Findings 19 and 21 are reasoned from those scripts, not run.

| # | Finding | Outcome | Why, or what changed |
|---|---|---|---|
| 1 | "reads per search (2)" misstates a concurrency limit | Applied | Now "concurrent reads per search" |
| 2 | `vera` scenario passes vacuously, because `vera` is a stop word | Applied | Scenario uses `taka` and `fyrirtæki`; `taka` confirmed not a stop word. FR-002 names the part exclusion |
| 3 | "Default behaves as today" collides with sync running under Meilisearch; attribution on by default | Applied | New search data setting, off by default (FR-030). Spec decision |
| 4 | Availability check narrowed; rollback can't hide search | Applied | Readiness defined per backend (FR-019) |
| 5 | 30-day hold undefined | Applied | Meilisearch stays live and synced during the hold (FR-036, SC-017) |
| 6 | Sidebar busy behaviour undecided; other failures uncovered | Applied | Failure table by surface (FR-018). Fallback trigger read from `conversation.ts` |
| 7 | Per-process cap and no-open-cursor dropped | Applied | FR-017; at the cap a search fails busy, no queue. Spec decision |
| 8 | FR-020 literally forbids showing results | Applied | Limited to logs and error responses |
| 9 | Fields not assigned to surfaces; tags on shared links | Applied | FR-008. Tag matches accepted, as today's shared-link search reads the same index |
| 10 | Tag rename, title edit, single-message flip missing | Applied | Edge cases; FR-023 now covers every §9 write path |
| 11 | Reconcile and verification ignore conversation records | Applied | FR-027, FR-028 |
| 12 | Panel judgment of length bucket has no consequence | Applied | FR-011: removal by written decision re-baselines the floors |
| 13 | Azure and gate targets stated as settled | Partly applied | Azure database stays a dependency and step 1 task, while Azure remains out of scope because the feature description says so. Gate targets stay adopted, because the feature description sets them; owner still confirms before shadow |
| 14 | Licence answers block nothing; public-repo redistribution unresolved | Applied | FR-045. Spec decision, flagged to the user because it narrows the design's "vendor it now" |
| 15 | Upgrade details dropped; which engine the sandbox gate applies to | Applied | FR-031 names 8.0, cites §8, adds batches and per-release runs; US3 scenario 1 names the target engine |
| 16 | No re-analysis trigger; pack measurement dropped; attribution end; FR-001 assumes Icelandic pack | Applied | FR-001, FR-026, FR-027, FR-046, US4 scenario 3 |
| 17 | Token parity test, unknown-compound rule dropped; "capped" ambiguous | Applied | FR-002, FR-007. `analyze.mjs` drops over-long words, confirmed |
| 18 | Queries with no usable words; length; surfaces for the stop-word reason | Applied | Edge case, FR-012, query word limit in FR-017 and FR-041 |
| 19 | Unfolded stop words miss `hvad` | Partly applied | Listed as an accepted gap with a plan test. Rejected adding query-side folded stop words: the design chose unfolded because folding made `fór` and `ís` vanish, and shadow already counts these queries |
| 20 | Prefix absolute vs budget; short prefix; trailing stop word | Applied | US2 scenario 2 and an edge case |
| 21 | Typo rule per word or query; first-word miss | Applied | Per word, per `search.mjs`; `xyzzy kerfi` listed as an accepted gap, matching the design's `last` strategy |
| 22 | Short pages, between-page edits, forged cursors; page size | Applied | Edge cases, FR-013 |
| 23 | "Exactly one leader" untestable; takeover; stream restart | Applied | FR-024, FR-025, edge cases |
| 24 | Verification failure has no outcome | Applied | Edge case |
| 25 | Gate terms undefined | Partly applied | Runbook fixes them before shadow starts, and SC-007 gets 20 samples, the floor rule's number. Kept "about 300" as the design states it, since the column also allows acceptance in writing |
| 26 | Missed target with no abort threshold | Applied | FR-034, FR-035 |
| 27 | Shadow cap, detachment and panel data source unspecified | Applied | FR-033; verdicts stored without query text |
| 28 | Fallback conflicts with FR-023, FR-024, reconcile interval | Applied | FR-023 |
| 29 | App with Meilisearch unset; re-cutover after abort | Applied | FR-036, FR-037 |
| 30 | Floor rule is a proposal in the design | Applied | FR-038: tunable by written decision |
| 31 | "SHOULD share one read" untestable | Applied | FR-015: one process, 30-second staleness |
| 32 | Only latency and sync listed as unproven; floors with zero margin | Partly applied | Limits line added and multi-word paging marked as risk. Floors keep zero margin, because the feature description sets 63 |
| 33 | Timing side channel dropped | Applied | FR-029 |
| 34 | "Within seconds" has no number | Applied | References SC-009 |
| 35 | First-page scenarios conflict with crowded users; sidebar has no pages | Applied | Scoped to the padded corpus |
| 36 | `Jóni` and `C#` limits missing | Applied | Accepted gaps |
| 37 | "Exactly" vs localized; location untested | Applied | FR-043: verbatim credit, localized label, on the `/search` view |
| 38 | Key Entities omit `messageId`, pack `kind` | Rejected | Conflicts with finding 39, which holds. Entities now point to §4 and §9 for fields |
| 39 | Entity fields leak implementation | Applied | Purpose and section references only |
| 40 | "Take fields by name" | Applied | FR-020 |
| 41 | "Build indexes after the load" | Applied | FR-028 cites §9 |
| 42 | "Built at image build, not in git" | Applied | FR-044 cites §9 |
| 43 | "Per-user cache" | Applied | FR-015 states the behaviour |
| 44 | Cursor-limit explanation is evidence | Applied | Removed |
| Note | `review-log.md` missing; checklist boxes disputed | Rejected | This file is that log, written after the review. Boxes are re-checked at the end |

## Round 2

38 findings: 31 numbered and 7 implementation-leak items. Applied 34, partly applied 2, rejected 2.

I confirmed the claims in findings 2, 4, 10 and 31 against `analyze.mjs`, `search.mjs`, `share.ts`, `routes/search.js` and `routes/messages.js`.

| # | Finding | Outcome | Why, or what changed |
|---|---|---|---|
| 1 | "Redacted private text" inverts the rule: canonical `text` is the redacted form, and it is indexed | Applied | FR-022 names the unredacted copy; searching a redacted value finds nothing |
| 2 | FR-001 and token parity can't both pass; stop lemmas missing | Applied | FR-001 follows the reference analyzer, which adds a stem to words outside core. The design's prose says "words BÍN doesn't know", so the header names the reference as tie-break |
| 3 | Fallback widened to rollout, breaking one engine | Applied | FR-031: rollout blocker halts and reopens the design |
| 4 | Failure table contradicts FR-020; shared links hide outages as empty 200 | Applied | FR-018 gives statuses and codes. Empty 200 confirmed in `share.ts` |
| 5 | Verification tolerance undefined; retry can loop | Applied | FR-028 uses a 60-second window; three failed rounds call the owner. Spec decision |
| 6 | "Every match" undefined for multi-word | Applied | FR-013 |
| 7 | SC-001 to SC-004 gate nothing | Applied | FR-034 |
| 8 | Later tenants have no latency watch; shadow tenant's hold uncovered | Applied | FR-035 |
| 9 | Volume clause meaningless at removal | Applied | FR-036: both go at cutover plus 30 days. Spec decision |
| 10 | "No backend set" impossible; `SEARCH` switch; invalid combination | Applied | FR-019. `SEARCH` check confirmed in `routes/search.js` |
| 11 | Attribution timing untestable | Applied | FR-043, US4 scenario 3 |
| 12 | Re-analysis triggers too narrow | Applied | FR-026 covers any token change |
| 13 | "Exactly as today" conflicts with new UI states | Applied | FR-041 scoped to results, data and contracts |
| 14 | Fallback and no-event TTL leave deletes unbounded | Applied | FR-023 and the edge case; delay accepted in writing against retention duties |
| 15 | Parity test unpinned | Applied | FR-007 pins the first analyzer version |
| 16 | Too few samples has no outcome | Applied | 20 samples per latency measure; below it counts as not measured |
| 17 | Cap drops can flatter latency | Applied | FR-033: runbook sets a maximum drop share |
| 18 | Which searches shadow covers | Applied | FR-033: all three surfaces; load-more stays out because the current route returns no next cursor |
| 19 | Verdict needs two facts | Applied | FR-033 |
| 20 | "Alarm on p95" has no threshold | Applied | FR-040 ties to SC-006 |
| 21 | "About 300", "about two weeks", switch time | Partly applied | FR-032 now "at least two weeks", matching §10's 2 weeks elapsed. SC-017 records the switch time. Kept "about 300" this round; round 3 finding 17 later changed it to a stated 300 |
| 22 | SC-003 omits categories and condition H | Applied | SC-003 points to §6's B4 row and adds H floors |
| 23 | "Measure on real text" dropped | Applied | FR-032 |
| 24 | Unlabelled spec decisions | Applied | Labelled |
| 25 | Shared read scope, size, cap, anchor | Applied | FR-015 |
| 26 | Paused writer; reconcile races | Applied | FR-024, FR-027 |
| 27 | Search data turned off after on | Applied | Edge case. Spec decision |
| 28 | Failure during load-more | Applied | Edge case |
| 29 | Shared-link limit and stale links | Applied | FR-016 |
| 30 | Mixed analyzer versions in a rolling deploy; ranking drift between pages | Partly applied | Rolling-deploy edge case added. No separate rule for rank drift: FR-013's no-duplicates requirement already fails such a build, and how to hold order is the plan's choice |
| 31 | Typo limits, 48 before folding, query side, tag deletion | Applied | Accepted gaps and edge cases, confirmed in `search.mjs` |
| L1 | FR-016 names records | Applied | Outcome stated |
| L2 | FR-025 mechanism | Applied | Outcome stated |
| L3 | FR-024 "leader", "lease" | Applied | One writer, configured takeover time |
| L4 | FR-026 "carry an analyzer version" | Applied | Outcome stated |
| L5 | Entity keying | Applied | Removed; §9 holds it |
| L6 | FR-017 "no open cursor" | Rejected | Capacity requirement that the cursor budget depends on, and the reviewer also allowed keeping it |
| L7 | FR-031 `npm run lighthouse` | Rejected | Project rule in `AGENTS.md` and the design's named trial check, so it is the requirement itself |

## Round 3

30 findings. Applied 28, partly applied 2, rejected 0. The reviewer reported no implementation leaks.

I confirmed findings 13 and 21 against `search.mjs`, and read the conversation schema for the reviewer's unverified tags question. Findings 5, 15 and 22 are reasoned from the reference code, not run.

| # | Finding | Outcome | Why, or what changed |
|---|---|---|---|
| 1 | Search data off leaves deleted tokens and names indefinitely | Applied | Edge case: runbook drops data by a retention deadline. Spec decision |
| 2 | Tool output or private text leak has no abort | Applied | SC-005 |
| 3 | Snapshot and restore dropped; "each step is reversible" overstates | Applied | FR-031, US3 rationale |
| 4 | Letter test is Icelandic knowledge in shared routing | Applied | FR-001, SC-016 |
| 5 | Records appearing below the anchor mid-pagination | Applied | Edge case |
| 6 | No timeout or cancellation; false busy | Applied | FR-017, FR-018, FR-041 |
| 7 | Failure table gaps for the title read | Applied | Rows split by read; title reads exempt from the cap. Spec decision |
| 8 | Backfill on later tenants has no chat guard | Applied | FR-028 |
| 9 | Poison message; pack load failure | Applied | Edge cases. Spec decision |
| 10 | SC-010 has no reconcile run producing it | Applied | FR-027 |
| 11 | Two cursor outcomes; not bound to query | Applied | Edge case |
| 12 | Panel can't attribute results to the bucket; direction unstated | Applied | FR-011 |
| 13 | "Newest 50" differs from the reference | Applied | FR-011 |
| 14 | Title reads have no page; sidebar limit scope | Applied | FR-009, FR-015. Spec decision |
| 15 | Shared read size vs first page and quality evidence | Applied | FR-015 |
| 16 | No criterion for ruling out sync; incomplete replacement list; fallback untied to the sandbox | Applied | FR-023, FR-031, US3 scenario 1 |
| 17 | "About 300" untestable; extrapolation unstated | Applied | SC-012. Round 2 kept the wording; the written-acceptance route covers any margin the design's "about" allowed |
| 18 | "Not measured" has no branch | Applied | FR-034 |
| 19 | Attribution location narrows the design | Partly applied | Labelled a Spec decision and tied to the licence answers. Rejected adding a credit to the sidebar and shared links until the legal answer says it is needed; flagged to the user |
| 20 | Unlabelled spec decisions | Applied | Labelled |
| 21 | Word limit's source and order; takeover default | Applied | Edge case, Assumptions. The reference has no word limit, confirmed |
| 22 | Word list read unbounded on short prefixes | Applied | Budget bounds rows too. No new minimum-length setting, since the budget covers the cost and short prefixes keep working |
| 23 | Memory cost dropped | Applied | FR-046 points to §4 |
| 24 | Failed reads could be shared | Applied | FR-015 |
| 25 | "Longer" retention unverifiable | Applied | FR-039: 7 days, value recorded per tenant |
| 26 | "Accessible" has no pass condition | Applied | FR-042 |
| 27 | Shadow misconfiguration hides search | Applied | FR-019: shadow keeps serving Meilisearch |
| 28 | Tests need private data; no owner for the answers | Partly applied | FR-045 says where the tests run. No owner named in the spec: the design leaves it to whoever contacts the institute, so it is flagged to the user |
| 29 | Rollback timing would hide search on production | Applied | FR-036: parallel Meilisearch. Spec decision |
| 30 | Sync lag on just-sent messages not listed | Applied | Accepted gap |

# Plan reviews

Three rounds, each a fresh reviewer given only file paths, no earlier findings.

## Plan round 1

37 findings. All verified against the code before applying, where the code decides.

| # | Finding | Outcome | Where |
|---|---|---|---|
| 1 | `isIndexableDocument` needs hydrated documents; moving it unchanged throws on change events | Applied | R-03: pure `isIndexableSource`, parity test |
| 2 | Read plan recomputed per page from drifting `df` | Applied | R-06: frozen plan in the cursor |
| 3 | Clearing `seen` at a window change duplicates | Applied | R-06: floor pinned, range re-reads |
| 4 | `tieAfter` assumes `_id` order within a date | Applied | R-06: rows at the boundary date become their own `_id`-sorted window |
| 5 | First page to cursor undefined; evidence covers a different read | Applied | R-06: page 1 from the read plan, then the paging reference's walk excluding page 1 |
| 6 | `e` cannot stop a deleted record coming back | Applied | R-09: 24-hour tombstones. Rejected re-reading the source per write as more reads for the same guard |
| 7 | Hydration checks conversations only | Applied | R-03: `getSearchableMessages` |
| 8 | Reconcile cannot meet "never overwrite newer" | Applied | R-11: compare-and-set, insert-only |
| 9 | Nothing invalidates a verification pass | Applied | R-11: `passedAt` later than `invalidatedAt`, set by the writer's config poll |
| 10 | R-02 ships data in tenant images before the answers | Applied | R-02, plan stages 0 and 8 |
| 11 | Single-flight conflicts with per-request cancel | Applied | R-08: refcounted waiters |
| 12 | Exact verification not computable | Applied | R-11: by ID, age from source `_id`, recheck mismatches |
| 13 | Models create collections with data off | Applied | `autoCreate: false`; quickstart asserts it |
| 14 | Error codes lost; seams overlap | Applied | R-03: one flow per surface, `SearchError` passes both catches |
| 15 | Meilisearch bookkeeping floods the stream | Partly applied | R-09: in-writer skip. Rejected a server-side `$match`: `findOneAndUpdate` sets `_meiliIndex` beside real edits, so it would drop them. Rehearsal on a snapshot clone |
| 16 | Word list rebuild not implementable | Applied | R-10: generations, atomic flip |
| 17 | SC-008 and FR-038 have no source | Applied | R-14: APM and log filters, stage 7 exit |
| 18 | Backfill pause has no actor | Applied | R-11: `pause`, `resume` jobs, owner issues them |
| 19 | FR-011 re-run has no lever | Applied | `rank.lengthBucket`, R-18 |
| 20 | Synthetic probes have no home | Applied | R-14, `shadow/probe.ts` |
| 21 | FR-023's fallback absent | Applied | R-17 |
| 22 | `/enable` omits pack failure | Applied | contracts/http.md |
| 23 | Spec-assigned tests missing | Applied | quickstart |
| 24 | Config plumbing missing; writer never re-reads | Applied | R-03, R-09, contracts/config.md |
| 25 | `isLargestUser` has no field | Applied | `shadow.largestUserId`; plain ID in tenant config, simpler than a hash |
| 26 | Language enum contradicts SC-016 | Applied | String array, validated in the service |
| 27 | http.md header conflicts with FR-043 | Applied | Each section scoped |
| 28 | Shadow telemetry cannot produce its fields | Applied | `search.request` from both paths; `meiliMs` dropped |
| 29 | Tenant model inconsistent on a shared database | Applied | R-04: one tenant per database, writer pins it |
| 30 | `indexSync` wording contradicts the hold | Applied | R-03: keyed on Meilisearch being configured |
| 31 | Reconcile and drop state underspecified | Applied | R-11 |
| 32 | New levers without config fields | Applied | contracts/config.md |
| 33 | Stream bypasses the database boundary | Applied | `watchSearchSources` in `data-schemas` |
| 34 | Startup claim partly false | Applied | R-15: cached status; plan table corrected |
| 35 | Default cap exceeds the cursor floor | Applied | Default 2, shadow 1, formula in R-16 |
| 36 | Smaller details (budget, cursor size, forged cursors, stage order, vocabulary index, pack interface, stop list, wording) | Applied | R-06, R-10, R-16, plan, language-pack.md, data-model.md |
| 37 | "Our tenants set 200" describes fleet settings | Applied | Removed from config.md. No names found |

## Plan round 2

33 findings.

| # | Finding | Outcome | Where |
|---|---|---|---|
| 1 | Cursor exposes the tenant word list; forgery undetectable | Applied | R-06: AES-GCM, key by HKDF, user as associated data |
| 2 | Invalidation misses shadow aborts and restart flips | Applied | R-11: `observed` compared at each process start |
| 3 | Polling cannot see YAML changes | Applied | R-19: process snapshot, rolling restart. Verified at `app/service.ts` |
| 4 | `req` close aborts shadow on normal responses | Applied | R-03: `res` close with `writableFinished` false |
| 5 | Temporary-chat records can still be written in a race | Applied | R-09: tombstone on the transition. Rejected tombstoning every non-indexable write: volume, and it adds nothing for sources that were never indexable |
| 6 | Frozen plan conflicts with the stop rule | Applied | R-06: prefix read once when first reached, then frozen; independent oracle |
| 7 | 8 KB cursor bound false; nginx limit | Applied | `rankWindow` max 200, 5-byte hashes, 7.5 KB URL test. Verified nginx default is unset |
| 8 | React Query retries and focus refetch | Applied | R-15 |
| 9 | Pre-rollback cursor returns an empty 200 | Applied | `s1.` prefix rejected on the Meilisearch branch |
| 10 | No place for failure states | Applied | plan.md tree, R-15 |
| 11 | `singleBatch` can truncate silently | Applied | R-06: reads never project `tokens`; chunked fetch for scoring |
| 12 | Generation delete races the cache | Applied | R-10: delayed delete |
| 13 | False claim of no metrics | Applied | R-14: `metrics.ts` used for chat save and route figures. Search keeps log events, as `/metrics` may not be scraped everywhere |
| 14 | Unchanged `h` leaves `e` low | Applied | R-09: replay raises `e` |
| 15 | Tombstone shape, volume, repair blocked | Applied | R-09, R-11, data-model.md |
| 16 | Stalled writer raises no alarm | Applied | `search.sync_status` |
| 17 | Re-run contaminates the gate; extra field | Applied | Separate `panel-rerun:` key, no date, cleared at logout |
| 18 | Runbook arrives too late | Applied | Sections before stages 2 and 5 |
| 19 | Verification loop drops reconcile | Applied | R-11 |
| 20 | Title path reads outside the cap, unmeasured | Applied | Shared expansions, R-05 row |
| 21 | Shared read bounded by count, not memory | Applied | `sharedReadMaxBytes`, no `tokens` kept |
| 22 | Rebuild cost unmeasured | Applied | R-05 row, bounded merge |
| 23 | Abort checks only on the shadow tenant | Applied | Per-tenant entry check |
| 24 | Failed pack holder stalls sync | Applied | R-09: lease needs loaded packs |
| 25 | Tenant pin undefined for tenantless rows | Applied | R-04 |
| 26 | Rollback timing not scheduled | Applied | Stage 7 exit, quickstart |
| 27 | `is` contract run unnamed | Applied | quickstart §2 |
| 28 | `$nor` fallback can lose matches | Applied | R-05: walk windows, costs reads, not matches |
| 29 | Context adds a read on the load path | Applied | R-19: none is added |
| 30 | Hibernating tenants block stage 2's exit | Applied | Stage 2 |
| 31 | Hard-coded levers | Partly applied | Config fields added. Rejected for the auto-fetch count, a UI constant with no operator use, and the heartbeat, derived from takeover time |
| 32 | Backfill duty cycle | Applied | Delay 1,000 ms, about 22% of a core, measured on the first backfill. Rejected a worker thread until that measurement says it is needed |
| 33 | Truncation and cold state unobservable | Applied | `vocabRowsTruncated`, `coldAfterIdle` defined |

## Plan round 3

22 findings and 3 simplifications.

| # | Finding | Outcome | Where |
|---|---|---|---|
| 1 | Oversized change event stalls sync | Applied | R-09: `$project`, treated as a gap. The `_meili*` skip now keys on `_meiliIndex: true` |
| 2 | Paging undefined for several common tokens | Applied | R-06: jobs walked one at a time, so reads stay in index order |
| 3 | Cap of 2 rejects one typing user; shadow hides it | Applied | Default 4, shadow 4, `signal` passed from the client. Rejected adding a gate measure: FR-033's drop share already shows it |
| 4 | "Top 200" has no defined path | Applied | R-13: the ranked shared read at `sidebarLimit` 200, the reference's semantics |
| 5 | Backfill could precede its alarms and baseline | Applied | New stage 8 |
| 6 | Unbatched stream writes | Applied | R-09: one pass per batch |
| 7 | Archived Chats is a search surface | Applied | Verified `ArchivedChatsTable.tsx`. plan, R-03, R-15 |
| 8 | Read cost understated | Applied | R-06, R-08: lazy masks, parallel hydration, no shared flags |
| 9 | Worst-case URL ignores query text | Applied | R-06: 256 characters on a cursor request; 414 maps to restart |
| 10 | Window overflow gets stuck | Applied | R-06 |
| 11 | FR-034, FR-040, FR-031 reruns have no place | Applied | Release checklist, stage 10 entry |
| 12 | Alarm contract overpromises; sources disagree | Applied | telemetry.md: one source per measure |
| 13 | Analyzer check timing contradicts itself | Applied | Removed poll; runbook reconcile after deploy. Rejected refusing the lease by version order: hashes have no order, and reconcile already heals it |
| 14 | Shadow title reads uncapped | Applied | R-12 |
| 15 | `attributionUntilReanalyzed` has no owner | Applied | R-11 |
| 16 | Code claim corrections | Applied | `messageId` keying, sidebar path, catch wording, export |
| 17 | Code locations conflict | Applied | `utils/searchError.ts`, `app/search.ts` |
| 18 | `updateDescription` fallback incomplete | Applied | R-05, R-09 |
| 19 | Sandbox question on database-level watch | Applied | R-05 |
| 20 | Crash windows in job state | Applied | `pass` field; the generation one went with S2 |
| 21 | FR-036 clone differs from the spec's wording | Partly applied | Kept the clone. The spec is not changed here: flagged to the user |
| 22 | Implementer guesses | Partly applied | Secret, replay horizon, data directory default, sha512 at load, new-word scenario. The TTL index item went with S1. R-18's text stays, with logout clearing kept as a requirement |
| S1 | Replace tombstones with a post-write source check | Applied | R-09. It removes a TTL index, optional fields and skip rules. Residual: a crash in a rare window leaves an orphan that cannot show and reconcile removes |
| S2 | Replace word list generations | Applied | R-10: keeps §9's `_id: token` and removes a cached read per search |
| S3 | Simplify the panel re-run | Partly applied | R-18: config flip and `panelRound` replace the `variant` parameter. Kept the local list of rated queries, as a session-only list would not survive the restart |

# Tasks reviews

Three rounds, each a fresh reviewer given only file paths, no earlier findings.

## Tasks round 1

33 findings, with 4 low items in the last.

| # | Finding | Outcome | Where |
|---|---|---|---|
| 1 | Lighthouse cannot run against the clone | Applied | T012: `LIGHTHOUSE_MONGO_URI`. Verified the lane hard-sets memory Mongo |
| 2 | Pack helpers under `__tests__/` fail Jest | Applied | `__tests__/helpers/` |
| 3 | Private suite would run in public CI | Applied | T004. Verified `packages/api/jest.config.mjs` |
| 4 | Service cannot be built where T052 said | Applied | T030 lazy port, T064 in server entry points |
| 5 | `search` still overridable | Applied | T015, T017. Verified `BASE_ONLY_CONFIG_SECTIONS` |
| 6 | Index and record builder missing before Phase 6 | Applied | T028, T031, T032 |
| 7 | Nothing runs the jobs | Applied | T106. Decision: backfill starts by request |
| 8 | Engine gate skippable | Applied | Graph, gates |
| 9 | Licence gate on the wrong task | Applied | T123 with `languages: [en]` until answers |
| 10 | Sandbox timing contradicts the plan | Applied | T010 before Phases 4 and 6 |
| 11 | Telemetry events have no emitter | Applied | Named in each owning task |
| 12 | Reads and ranking have no public test | Applied | T050, T068 |
| 13 | Title search depends on later tasks | Applied | T056, T074 |
| 14 | `readConcurrency` never named | Applied | T048, T052, T058 |
| 15 | `is` pack spec missing methods | Applied | T044, query parity in T045 |
| 16 | Attribution has no source after a disable | Applied | T097, T110, R-11 |
| 17 | Panel and attribution gaps | Applied | T092, T108, T113 to T115 |
| 18 | Post-deploy reconcile not written down | Applied | T121 |
| 19 | Probes have no schedule | Applied | T107 before T108, T119, T122 |
| 20 | Public repository check never written | Applied | T006 |
| 21 | Other surfaces still retry | Applied | T080 predicate, T083 to T085 |
| 22 | Archived Chats omits partial | Applied | T084 |
| 23 | Pack failure mapping unassigned | Applied | T059, T069 |
| 24 | Edge cases with no test | Applied | T040, T049, T066, T078, T080, T086, T087 |
| 25 | Early upstream check missing | Applied | T008 |
| 26 | Wrong dependencies for US4 | Applied | T129 to T131 |
| 27 | A test contradicts the design | Applied | T101 states the one read and no write; startup check moved to T100 and quickstart |
| 28 | Live spec in the wrong package | Applied | T116 split |
| 29 | Wrong `[P]` markers and order | Applied | Markers dropped; `version` before packs; rebuild before backfill |
| 30 | Checks too late; wrong branch name | Applied | Every PR rule. Named `dev` or the maintainer's branch |
| 31 | Quality suite inputs unspecified | Applied | T045, R-13: all by path, runner only committed |
| 32 | Guesswork | Applied | `IS_DATA_SHA512`, T051, T075 |
| 33 | Tasks too large | Partly applied | Split T046, T072, T080, T082, T087, T096, T101. Kept T108 and T122 whole: both are thin lists of one kind of thing |
| Low | Unrequested files, secret reached for, duplicate codes, tree drift | Applied | Dropped `en/NOTICE.md` and README; T076 takes the secret; T019 imports codes; plan tree aligned |

## Tasks round 2

Task IDs below are as of this round; earlier rounds' IDs predate its renumbering.

| # | Finding | Outcome | Where |
|---|---|---|---|
| 1 | Phase 2 gate named a code task instead of the first live backfill | Applied | Phase 2, T135 |
| 2 | Search data could run on an un-upgraded engine; T133 waited on the private image step | Applied: T133's tenant must be on 8.0, image step split out | T133, T132 |
| 3 | FR-039's stream setup was documented but no task performed it | Applied, with entry checks | T131, T133, T135, T138 |
| 4 | A test could not pass in the phase owning it (`nextCursor` before paging) | Applied: moved, and Phase 4 returns `null` | T054, T066, T072 |
| 5 | Phase 4 and 5 checkpoints were false: no packs loaded, `/enable` still on Meilisearch health | Applied | T069, T070, T116 |
| 6 | T036 had no named extensions and could not assert much in Phase 3 | Applied | T036 and its six extenders; Every PR |
| 7 | T022 used T015's output with nothing ordering them | Applied: T015 updates merged code | T015 |
| 8 | No script covered R-05, and T012 was oversized | Applied: confirmed by grep, split | T012, T013, T014 |
| 9 | Upstream's checksum cannot match a trimmed copy; no task built the fold table | Applied: manifest hash, upstream's kept as provenance | T009, T049, R-02 |
| 10 | Quality runner would change the word list and left sources and database unnamed | Applied | T046, T050, R-13, quickstart |
| 11 | Shadow wiring had no paths or default-backend rule | Applied: no event on `meilisearch` | T099, T118, telemetry |
| 12 | `panel/compare` needed hydration held in CJS | Applied: extraction | T120, plan |
| 13 | `search.request` and `search.realtext` fields had no owners; three CloudWatch rows missing | Applied | T026, T068, T086, telemetry |
| 14 | Inner share catch swallows errors into an empty result; only the outer was named | Applied | T075, T085 |
| 15 | Parity test would fail on an unfinished row, since `buildIndexableQuery` has no such clause | Applied | T034, T056, R-03, quickstart |
| 16 | No tenant context named for jobs; bulk path unnamed | Applied. Checking this also showed `tenantSafeBulkWrite` strips `tenantId` from update documents under `runAsSystem`, so upserted records would lose it: writes now run in the source's tenant scope | T101, T113, T114, T095, R-04 |
| 17 | T008 was four units of work; FR-043's location unowned | Applied: split | T008, T009, T010, T011 |
| 18 | T002 used a later file, no version pin, dynamic import unjustified | Applied | T002, T042, plan |
| 19 | Record building preceded the analyzer | Applied: moved | T045, T046 |
| 20 | Prework graph lacked edges | Applied | Dependencies |
| 21 | Later-dependency and wrong `[P]` cases | Applied | T040, T106, T105, T119, T139, T140 |
| 22 | Writer start split across three tasks | Applied: one startup path | T115, T108, T113 |
| 23 | Token change at start not queued; job dispatch list missing | Applied | T106, T113 |
| 24 | Destructive `drop` had no test | Applied | T096 |
| 25 | R-18's second panel round had no UI | Applied | T123 |
| 26 | Behaviours with no test: proximity, FR-008 fields, FR-019, sync gap, R-09 events, FR-041 client, retry wiring | Applied | T045, T055, T062, T074, T075, T076, T090 to T092, T093, T094, T099 |
| 27 | Plan documents contradicted each other (6 items) | 5 applied. FR-036 versus the clone timing stays flagged to the owner rather than decided here | R-02, R-11, plan, gates |
| 28 | T004's path did not match the pattern; `misc` suites were never typechecked | Applied | T004, T125, Rules |
| 29 | Oversized or uncheckable tasks | Applied: split and given criteria | T043, T085, T124, T140 |

## Tasks round 3

Task IDs below are as of this round; earlier rounds' IDs predate its renumbering.

| # | Finding | Outcome | Where |
|---|---|---|---|
| H1 | Private suites would still run in CI: the command-line ignore list replaces the config's, and the workflow filter omits `misc/` | Applied. Rests on Jest's documented behaviour and the file contents; T004's `--listTests` proves it when run | T004 |
| H2 | A test added in round 2 said thinking text never reaches the output, contradicting FR-008 and the code | Applied: that test was the author's error | T048 |
| H3 | No script runs B4 on DocumentDB, so §10 step 3 could not run as written | Applied: harness task, estimate raised | T012, T013, Strategy |
| H4 | The `is` library imports `tokenize-is`, which the trim omitted, and is ESM-only while `packages/api` builds CJS | Applied | T008, T009, T052, T055, R-02 |
| M1 | No task wrote the first `observed`, so an old verification pass could serve after an abort | Applied, with a no-seed test | T115, T124, R-11 |
| M2 | SC-008's source named a series that does not exist: `Document.save` is not instrumented, and message saves use `findOneAndUpdate` | Applied | telemetry, T144 |
| M3 | Retry and timeout covered only some reads, so a cursor error elsewhere became a 500 | Applied: one wrapper | T067, T080 |
| M4 | `final/relevance.mjs` exports nothing, `final/oracle.mjs` is ESM and needs the full binary, and the inputs had no generator | Applied: files plus a grader run as a child process, because precision grades what the candidate returned | T016, T055, T076 |
| M5 | SC-006 and SC-009 alarms were missing | Applied | telemetry, T143 |
| M6 | The partial state had no component or accessibility test | Applied | T095, T097, T098, plan |
| M7 | After-removal rehearsal departs from FR-036 with no decision task | Partly: task added; the decision is the owner's | T147 |
| M8 | Stream setup "as it upgrades" contradicted the graph | Applied: before each backfill | T145 |
| M9 | Query truncation was in the wrong file, and an NFD query could fail on page 2 | Applied: one rule | T087, T094, T078, T096 |
| M10 | Panel compare was underspecified and untested | Applied | T107, T130 |
| M11 | Word list upkeep had no test, and `df` decreases were left to guess | Applied: increments only | T112 |
| M12 | Nobody ran the live suites before tenant work | Applied | T148 |
| M13 | Seams left to guess though the code has answers | Applied | T038, T074, T093, T125, T133 |
| M14 | `search.pack` success had no owner | Applied | T074 |
| L1 to L7, L9 to L11 | Fold table checksum, deferred `is` checks, later-tenant entry, R-03's catch, quickstart's `_meili*`, live suite naming, limiter's place, ordering wording, lighthouse delay, TTL monitor | Applied | T009, T149, T151, T154, R-03, R-05, quickstart, plan, T019, T100 |
| L8 | Round 2's reason was too broad: the wrapper leaves `replaceOne` and `insertOne` documents alone | Applied, and simplified: writes stay in `runAsSystem`, using only those two operations, and the tenant grouping is gone | T108, R-04 |
| Tests | `search-job.js` `status` and `panel`, FR-008's no match on sender, user or ID | Applied | T123, T122, T048 |
| Simplify | The chain rebuilt the word list twice | Applied: reconcile skips its `vocab` phase in the chain when it made no repairs. FR-027 and FR-028 still hold | T121, R-11 |
| Size | T021, T052, T088, T120, T122, T130, T133, T142 too large; T010, T154, T160 had no finish | Applied: split, and given criteria | Those tasks, T155 |

# Base change to `aproorg/0.8.8`

The merge target changed after the task reviews. One fresh-context audit read every claim about existing code against `aproorg/0.8.8`, which lacks 710 commits the docs were written against. No tests ran.

| Finding | Outcome | Where |
|---|---|---|
| PR base and static-check ref named `dev` | Applied | Every PR line, plan |
| `privateText` does not exist on this base, so its test and sentinel proved nothing | Applied: `contextMeta` and tool output. Spec unchanged, FR-022 stays as the rule for any private copy added later | T048, T128, R-14, data-model, quickstart |
| `/metrics` is absent from `experimental.js` | Applied | T144, telemetry |
| Lighthouse database option was incomplete | Applied | T019 |
| Dead references | Applied | R-02, R-03, R-15, R-19, research intro |

# PR review loops

Fresh-context review of the open PR. Each loop reviews the pushed head.

## Loop 1

| # | Finding | Outcome | Where |
|---|---|---|---|
| H1 | `subagentTask` is `select: false`, so jobs could index subagent messages | Applied: shared projection, test, direct probe | T108, T102, T128, data-model |
| H2 | Last-event rule could keep a bookkeeping event and lose the edit | Applied: drop those events first, test | T110, T101, R-09 |
| M3 | Live after-removal rollback floods sync | Applied: `data: false` before the reset | T140, R-09, quickstart |
| M4 | SC-005's log checks had no task | Applied | T143, T139, telemetry |
| M5 | A crash between chain steps had no resume | Applied: `chain` key, request deleted late, test | T120, T121, T104, data-model |
| M6 | T158's file name was skipped by public CI | Applied: renamed | T158 |
| L7 | FR-035 listed as open though the spec decides it | Applied: removed from the PR body | PR body |
| L8 | Fleet details in the public diff | Partly: the sidebar clause went from the spec; container size and volume stay, as they name no tenant | `spec.md` |
| L9 | Personal email in commit metadata | Left for the owner | none |
| L10 | Scaffolding in this PR | Partly: the brief asks for it, so it stays; env var note added | `tasks.md` |
| Extra | Licence status of stop lists and cursor overflow were undefined | Applied | T008, T053, T054, T078, R-06 |

## Loop 2

| # | Finding | Outcome | Where |
|---|---|---|---|
| H1 | Loop 1's reorder of after-removal rollback stalled or showed a nearly empty index, as `indexSync` only runs at process start. My error in loop 1 | Applied: explicit order | T140, T149, quickstart |
| H2 | Possibly BÍN-derived lists could reach the public repository before the answers | Applied: private by default | T009, T053, T054, language-pack |
| H3 | Reconcile could run as an unrequested full backfill | Applied: automatic triggers wait for `chain.finishedAt`, test | T104, T111, T113, T121, R-09, data-model |
| M1 | Startup order contradicted itself | Applied: `bindSearch()` before listen, `startSearchBackground()` after | T074, T124 |
| M2 | Loop 1's cursor overflow rule relaxed "none lost" | Applied: a byte limit in the prefix budget, applied at freeze and shared with the oracle | T077, T078, R-06 |
| M3 | A Jest config can't set Node flags | Applied: script, not run | T052, T055, quickstart |
| L1, L2, L3 | T052 had no runner, quickstart's quality directory, T149's missing dependency | Applied | T052, quickstart, graph |
| L4 | Removed clause stays in earlier commits | Left: squash-merge recommended to the owner | none |

## Loop 3

These fixes have had no further review.

| # | Finding | Outcome | Where |
|---|---|---|---|
| H1 | `isComplete` can stay false after an aborted message, hiding search for good after rollback | Applied: gate by pending counts and threshold, step to clear the flag, test under traffic | T125, T140, T105, T149, http |
| M1 | `reset-meili-sync.js` hangs without a TTY | Applied: `--yes` flag. Hang simulated by the reviewer on a copy of the prompt logic, flag not built | T114, T140 |
| M2 | "After the server listens" invited a call that can exit the process | Applied: un-awaited, own catch, test | T074, T124 |
| M3 | No behaviour while packs load or with data off | Applied: `packState` | T069, http |
| M4 | `data: false` only postpones the flood | Applied: off to on discards the token, new R-05 question, release check. Lag unmeasured | T111, T141, R-05, R-09 |
| L1 to L3, L5 to L8 | R-11 triggers, live suite flag, missing env var, `JWT_SECRET` owner, private data layout, T016 before T013 (inferred), T020's module name | Applied | R-11, T136, quickstart, T074, R-02, graph, T020 |
| L4 | The scenario's order differed from T140 | Applied in the spec: reset, then redeploy | `spec.md` |

## Code review of the uncommitted implementation

### Code loop 1

No High, 1 Medium, 7 Low. All fixed except where noted.

- **M1:** hydration lost hits past one 16 MB batch. Reads that hold whole messages now read again for what is missing.
- **L1:** a pack throwing on a word gave the sidebar a raw log and a non-contract body. It is now `search_failed` on every surface.
- **L2:** a sidebar search ran `readConcurrency` + 1 reads. Reads now share one gate per search (FR-017). A read another search started still runs on that search's gate.
- **L3:** served reads counted as database reads, and sidebar events carried no figures. Both fixed. Not changed: `tierShare` still counts `/search` only, so a query from both surfaces counts once.
- **L4:** the comment and test title claimed an invalid block never fails startup. `configSchema` rejects it first, so both are corrected.
- **L5:** expired shared-read entries waited for byte pressure. They now drop when another read finishes. With no later search they stay until the next one.
- **L6:** the block-list test could pass with no split at all. It now requires at least one split on the real data. Rejected: moving the stub case to public CI, because the stub needs `--experimental-vm-modules`.
- **L7:** `test:lighthouse-database` ran in no workflow. It now runs in `lighthouse.yml`. Rejected: asserting on the built Playwright config, because that config only spreads the tested helper's result.
- **Unresolved:** `messages-get.spec.js` "does not hydrate branch files for an inert file policy" returned 401 once in a parallel run and passed on reruns. It is not known whether it also flakes on the base commit.

### Code loop 2

No High, 2 Medium, 8 Low. All fixed except where noted.

- **M1:** a word of marks alone, such as an emoji's variation selector, became an empty token on both sides, so `❤️` could find a message holding only `☀️`. Marks alone are no longer a word. The reference corpus holds no such token in 1,273,607 messages and 708,172 query words, so this does not change FR-007 parity on it. The reference code was not changed.
- **M2:** a client leaving during the sidebar's message read raised the `search.partial` alarm. It now ends as `aborted`.
- **L1, rejected:** `/search` and a sidebar joining its read can run `readConcurrency` per surface. They are two requests, so this is recorded under R-12 rather than changed.
- **L2:** the plan's concurrency test could not fail. It now uses two common tokens in one tier, with a limit of 2, and asserts both the single-token reads and the high-water mark.
- **L3:** added a test that one user ID in two tenants never shares a read.
- **L4:** the test loader counted rows that failed validation. It now throws, with a test.
- **L5:** quality suites skipped silently without their inputs. A missing input now fails the run.
- **L6:** the stub-data `is` pack and scoring suites now run in public CI, shard 1. This reverses loop 1's rejection: the flag can be set in that one step.
- **L7:** shared-read entries outlived their time on an idle process. An unreferenced sweep timer now removes them, and the config text now says the budget is a per-process total.
- **L8:** the runbook hard-coded its base branch. `BASE` must now be set, or the check stops.

### Code loop 3

No High, no Medium, 5 Low. Four fixed, one rejected.

- **L1:** tests of hidden conversations could pass on a failed search. They now assert the status, and a visible conversation is the control.
- **L2:** the reason a pack failed was never logged. It now logs the pack ID and a stable code.
- **L3:** the invented-data suite could be skipped when a push touched only its files, because selection drops `misc/`. It now has its own job.
- **L4:** a conversation list read failing after a good search left the coded contract and the outcome metrics. Any failure with a search context is now `search_failed`, with a sanitized log.
- **L5, rejected:** a stub word that is a real dictionary word. Checked against the private lists: none of the stub entries appear there.

## Code review of the full change

Three rounds on the whole change against its base (271 files), each with three reviewers that had a clean context and saw only a brief and the code. Round 1 split the change by area, round 2 by invariant, round 3 by way of reading. Findings are blocker, major, minor or nit.

### Full loop 1: by area

No blocker, 5 major, 15 minor, 9 nits. 27 fixed, 2 left with reasons.

Read side:

- **Major:** a multi-word first page analysed whole message texts in one synchronous pass. Proximity now scans the first 50,000 characters of a message, yields between messages and stops at the search's deadline.
- **Minor:** prefix and typo expansions were shared across users, so a skipped read told one user that another had just searched the word. They are keyed per user.
- **Minor:** chunked reads kept running after the search's deadline. All chunks share one time budget.
- **Minor, left:** an aborted in-flight read closes its pooled connection. Its cost on DocumentDB is a measurement for the trial (R-05).
- **Minor:** a failed read logged nothing that identified it. The log carries the driver's code and code name, never its message.
- **Nits:** empty expansions now count against the cache budget; `http.md` no longer promises a cursor the code may withhold; the status read behind `/api/search/enable` is single-flight; `rankWindow` has a minimum of 25.

Write side:

- **Major:** under steady traffic a stream batch waited for a quiet second or 500 events. A batch closes 500 ms after its first event, and carries the time of its last change so the writer can prove it has caught up.
- **Major:** the writer analysed every event before knowing whether a write was needed, and never yielded. It compares the stored hash first, analyses only rows that need a write, and yields between rows.
- **Minor:** a source row whose `_id` is not an ObjectId stalled sync and every job. Walks skip such rows and the stream ignores their changes.
- **Minor:** the writer's failure backoff never reset while it held the lease. It resets after each applied batch.
- **Minor:** a token change during the chain's reconcile or verify step queued no reconcile. It does now.
- **Minor:** a failed background start was never tried again. It retries from 5 s up to 5 min.
- **Minor:** after a pack is removed, a failed attribution count could make reconcile loop. The count failing no longer fails reconcile.
- **Minor:** the runbook never checked that the stream delivers. `status` prints `last change`, and the runbook has a step for it.
- **Minor, left:** a stream batch is bounded by count and time, not bytes. A pipeline change is untested on DocumentDB, and the time bound limits what a replay reads.
- **Nits:** the operator script prints an error's class and code only; takeover timing is stated in the config contract; `data-model.md` lists the stored fields.

Client, CI and spec against code:

- **Major:** the runbook's engine compatibility step passed whatever the engine answered. It now runs with `DOCUMENTDB_STRICT=true` and names what a failure looks like.
- **Major:** a first search after idle logged its sidebar request as warm, which inflated SC-006. The cold mark is taken at request start and covers 5 s.
- **Minor:** the quality gate enforced three of SC-003's categories. It gates every category at the reference row.
- **Minor:** returning to `/search` refetched every loaded page. Focus, mount and reconnect refetch one page.
- **Minor:** load-more failed for good when the 256-unit cut split a surrogate pair. The cut half is replaced with U+FFFD.
- **Minor:** `/api/search/enable` answered false while packs loaded, and the client kept that for the session. It answers true once verification has passed.
- **Nits:** two documents still described the cut throwaway pack; the failed-page Retry shows a busy state.

### Full loop 2: by invariant

No blocker, 7 major, 14 minor, 8 nits. 25 fixed, 1 answered by stating its bound, 2 left for the owner, 1 nit left.

Exposure and cost:

- **Major, left for the owner:** result order and the typo rule use word counts from the whole tenant's word list, so a user could infer how common a word is among other users. FR-029 covers timing only.
- **Major:** the search cap ended before a multi-word page's costly reads. Ranking several words holds a slot, and identical requests in flight share one ranking.
- **Major:** the writer's in-memory word counter had no size bound. It flushes at 50,000 tokens and writes in chunks.
- **Major:** sidebar and shared-link title reads had no bound. They sit behind a gate of four times the cap, and typo expansion applies to at most three title words.
- **Minor:** one user could hold every search slot. A user holds at most half the cap.
- **Minor, left for the owner:** one user's made-up words can push the word list past the typo tier's row limit, which turns typo correction off for the tenant.
- **Minor:** a second tenant in a database was stopped only by the writer. Backfill makes the same check, and the stop withdraws the verification pass.
- **Minor:** every word of a query was analysed before the word limit applied. Only the words used are analysed.
- **Nits:** cursor decoding requires the full GCM tag; a search failure on the sidebar path is logged by code.

Stored state:

- **Major:** verification passed in a relaxed mode exactly when the sync writer was broken. The mode is gone: with no saved stream position, verification fails as `sync_not_started`.
- **Major:** an expired source that TTL had not yet deleted counted as an orphan and failed verification. Such rows are tallied as `expired`.
- **Minor:** a failed observed-config check was dropped and then overwritten, so an abort might never invalidate the old pass. A process whose check failed does not record its settings, and checks again before starting sync.
- **Minor:** a backfill request during a running verify made that verify fail. The runner holds the request while a job is active after a finished chain.
- **Minor, bound stated:** word counts held in memory are lost when the holder is killed. R-10 now states the bound: at most `vocabFlushSeconds` of new words, missing from prefix and typo expansion until the next rebuild.
- **Minor:** a skipped event queued a full reconcile each time. Skips share one request, and an analysis failure queues none.
- **Minor:** `drop` could run in the gap after a lease release. It refuses for the takeover time after a writer last saved.
- **Nits:** the `backfillOnStart` comment and `data-model.md` match the code. Left: request and run times come from different hosts' clocks.

Default behaviour and surfaces:

- **Major:** a `search` block with keys removed since an earlier build stops the process at startup, and no step said so. The release checklist has the step and lists the keys.
- **Minor:** `status` showed `verify: passed` after an invalidation. It shows `invalidated` and the next action.
- **Minor:** every conversation list passed its abort signal, not only searches. Only a search passes it.
- **Minor:** load-more dropped keyboard focus. The button stays mounted, marked `aria-disabled`, while its page loads.
- **Minor:** three tests asserted wall-clock bounds. Loosened to what each proves.
- **Nits:** a test depending on another, four runbook gaps, one wrong comment.

### Full loop 3: by way of reading

No blocker, no major, 21 minor, 9 nits. All three verdicts were ready, one of them after fixes. 17 fixed, 5 fixed in part, 1 answered in the documents, 7 left with reasons. These fixes were made after the last review round, so no reviewer has read them.

Examples traced through the code:

- **Minor, left:** a misspelt word in a multi-word query. The first read uses the typo tier only while the whole search has found nothing, and load-more uses a word's frozen corrections in every stage, so what a user can reach depends on whether the all-word matches fill a page. Recorded under R-07: either fix changes the first page's results or the cursor's contents, and needs a quality run behind it.
- **Minor, left:** the 3,000-token cap keeps the first tokens seen, and thinking parts come before the answer's text. A trial question under R-05 (`atCap` in `search.realtext`).
- **Minor:** message search corrected every unknown word, while title search stopped at three. One constant now caps both.
- **Minor:** the per-search read gate could run one read more than `readConcurrency`, when a read arrived as another finished. The finishing read now hands its slot to the waiter.
- **Minor, left:** title matches past 1,000 are cut in index order, not by recency. A trial question under R-05, because the fix is a sort whose plan is unmeasured on the engine.
- **Nit:** R-06 said the prefix expansion is not read up front, while almost every search reads it. Corrected.

The uncommitted part, line by line:

- **Minor:** plain conversation and message lists were still cancelled when their view left, because reading the query's `signal` at all tells React Query to cancel. A plain list no longer reads it, with tests that a page landing after its view left is still cached.
- **Minor:** a second skipped event during a running reconcile lost its request, because skips share one request ID. The request stays when it was written again after the run began.
- **Minor:** after the writer stopped on a second tenant, the next action `status` named brought search back. Reconcile now holds the tenant pin as backfill does, the stop records its reason, and `status` names all three cases.
- **Minor:** the comparison with the stored settings was retried only with search data on. It is retried on every path, so a rollback by `data: false` cannot be missed when the database is away at start.
- **Minor:** Load more still unmounted when its last page was short. It stays through the automatic fetches that follow a press.
- **Minor:** the `sync_not_started` advice said to run verify at once, while the writer may be five minutes from its next attempt. It says to wait for `sync: last saved`.
- **Minor:** the title gate, the per-user share as wired in the service, the path where a search joins a ranking whose starter leaves, and two `status` lines had no test. Each has one.
- **Minor (a question):** the writer's backoff reset on an empty batch, so record writes that kept failing never backed off. It resets only after changes were applied.
- **Nits:** the runbook lists the new `drop` refusal, and the tenant line in `status` no longer outlives its failure. Left: `drop`'s wait assumes a takeover time above the idle save; shared-link search passes no abort signal; the attribution cleanup logs nothing when its count fails; two near-identical yield helpers.

As the maintainer who owns it after the merge:

- **Minor:** 18 of 21 search failure logs said only `Error`. One helper adds the error's class, driver code and code name, by pattern and never the message, at every `[search]` log site.
- **Minor:** a pack throwing on a message after backfill made the next verification run three reconcile rounds and give up. Reconcile's repair pass counts such rows, and verification then reports `analysis_failed` after one round.
- **Minor, in part:** rules that must stay equal lived in two packages. The token cap, the page size, the cursor's query length and the request key are now shared, and a test holds that a job's projected read builds the same record as the whole document. Left: state keys named in both packages, the exclusion paths, and `MEILI_SYNC_THRESHOLD` parsed in two places.
- **Minor:** the one-tenant check was written twice and missing from reconcile. One function serves the writer, backfill and reconcile.
- **Minor:** the writer recognised an unusable source row by matching error text. It is a class now.
- **Minor, answered in the documents:** pack loading starts before the process reports ready. Kept on purpose: started after readiness, the same synchronous work would stall live requests. R-02 and T074 now say what it can cost, and T150 measures it.
- **Minor, in part:** repeated reads. The heartbeat lists requests once less. Left for the trial: chunked token reads run one after another inside a slot, and a sidebar search reads the same word list rows twice.
- **Minor, in part:** dead code. Batch analysis, a registry helper, an identity parameter and an unreachable branch are gone, and the metrics flush stops and flushes at shutdown. Left: `AnalyzedQuery.dropped`, metric values never emitted, and the width of `index.ts`.
- **Nits:** document drift corrected in `plan.md`, `tasks.md`, `data-model.md` and `research.md`. Left: `http/conversations.ts` and `http/shares.ts` are near copies, and two type and naming rough edges.

After the round 3 fixes: the build, type checks in all four workspaces and the quality tooling, and the static checks pass. Tests pass: 829 under `packages/api/src/search`, 230 in `packages/data-schemas`, 37 in `packages/data-provider`, 66 in `api` and 120 in `client`. Under full parallel load a test with real waits timed out in two of six runs of the search suite, a different one each time, and each passes alone; one of them waited a fixed 20 ms and now waits for the event instead. The private quality measure is unchanged from before the review, for both conditions, with no isolation violation and token parity with the reference.
