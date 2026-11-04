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
