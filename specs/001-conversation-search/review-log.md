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
