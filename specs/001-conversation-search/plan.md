# Implementation Plan: Icelandic and English Conversation Search Without a Separate Service

**Branch**: `search-b4-spec` | **Date**: 2026-11-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-conversation-search/spec.md`, and the design it names (`librechat-search-documentdb-design-final.md`, outside this public repository). § refers to the design. FR and SC refer to the spec.

## Summary

Replace Meilisearch per tenant with search collections in the tenant's existing database. Node computes tokens through language packs (`is`, `en`). One sync writer in the API process follows database change events. Reads go tier by tier and stop once the page can fill. Backend selection (`meilisearch`, `search`) and a separate search data setting let each tenant move on numeric gates, with one-setting rollback until Meilisearch is removed. Owner decision, 2026-11-10: no shadow backend, detached run, probes or review panel; tenants move on the quality tests (SC-001 to SC-004) and a live trial on the sandbox tenant. With default configuration, behaviour, data and API contracts stay as today.

Decisions and their reasons are in [research.md](research.md). Shapes are in [data-model.md](data-model.md) and [contracts/](contracts/). How to prove each outcome is in [quickstart.md](quickstart.md).

## Technical Context

**Language/Version**: TypeScript in `packages/api` and `packages/data-schemas`, thin CommonJS wiring in `api/`, React with TypeScript in `client`. Node version as the repository's images.

**Primary Dependencies**: Mongoose and the MongoDB driver (existing). New: `snowball-stemmers` for the `en` pack. `lemma-is` and its derived fold table for the `is` pack, delivered as data outside this repository under FR-045's gate ([R-02](research.md#r-02-language-data-delivery)).

**Storage**: Four new collections in each tenant's database: `msearch`, `csearch`, `search_vocab`, `search_state` ([data-model.md](data-model.md)). `messages` and `conversations` do not change. Target engine: DocumentDB 8.0, or 5.0 with planner v2 if §8's fallback fires.

**Testing**: Jest from the owning workspace, with `mongodb-memory-server` for queries and `MongoMemoryReplSet` for sync. Live DocumentDB specs in `packages/data-schemas/misc/documentdb/` (not in CI). The quality suite in `packages/api/misc/search-quality/` (not in public CI, [R-13](research.md#r-13-quality-suite-and-public-ci)). `npm run lighthouse`, `npx tsc --noEmit` in each changed workspace, and `npm run static-checks -- --against origin/aproorg/0.8.8`.

**Target Platform**: The existing API process on Fargate, one or more tasks per tenant, 2,048 MiB container.

**Project Type**: Web service and web app inside the existing monorepo.

**Performance Goals**: SC-006 (warm p50/p95 ≤ 150/500 ms, largest user p95 ≤ 1 s), SC-007 (first search after idle p95 ≤ 2 s), SC-008 (chat save p95 within 10%), SC-009 (sync lag p99 ≤ 60 s).

**Constraints**: No separate service. No chat-path work. No cursor held after a read. `is` pack costs at most §4's 153 MB and only when on. No tenant names, hosts or IPs in this repository (FR-047). No BÍN-derived data in this repository until FR-045 clears.

**Scale/Scope**: Every AWS tenant, one at a time. Reference volume 1.27M messages, users up to 100,000 messages. Two languages ship.

## Constitution Check

`.specify/memory/constitution.md` is the unfilled template, because the constitution was skipped by instruction. `AGENTS.md` serves as the gate.

| Gate (`AGENTS.md`) | Status | How |
|---|---|---|
| New backend behaviour in TypeScript under `packages/api`; `/api` is wiring only | Pass | `packages/api/src/search/`; route files gain a call into it |
| Database logic in `data-schemas`; no Mongoose types in exported signatures elsewhere | Pass | `methods/search.ts` takes and returns plain objects, including the stream, which yields plain events with opaque IDs |
| `data-schemas` cannot import `@librechat/api` | Pass | Search arrives as an injected port ([R-03](research.md#r-03-seams-into-existing-code)) |
| New levers on `configSchema` with defaults reproducing today | Pass | [contracts/config.md](contracts/config.md) |
| Dependencies passed in; no new singletons | Pass | `createSearchService(deps)` runs in the server entry points after config loads; the limiter and shared read live on that instance, reached through `app.locals.search` and a lazily bound port |
| Failure contracts: throw coded errors for operational failures, map at the HTTP boundary, never leak raw text | Pass | [contracts/http.md](contracts/http.md) |
| Avoid dynamic imports | Justified | See Complexity Tracking |
| Startup: no serial reads, `npm run lighthouse` | Pass, checked in the lane | Nothing added to startup config. `/enable` fires on every app load, so its new read is cached in-process ([R-15](research.md#r-15-client-data-needs)); packs load after the server listens |
| Client: new state in Jotai; `useLocalize`; English keys only; React Query with keys in `keys.ts`; semantic theme roles; keyboard and ARIA | Pass | `client` section below |
| Tenant isolation plugin on models with `tenantId` | Pass | `msearch`, `csearch`; one tenant per database ([R-04](research.md#r-04-one-tenant-per-database)) |
| Public fork | Pass | FR-047 grep in the PR checklist |

Re-checked after Phase 1: no new violation. The one exception stays in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/001-conversation-search/
├── spec.md, review-log.md, checklists/
├── plan.md            # this file
├── research.md        # decisions, with what the design leaves open
├── data-model.md      # records, state, lifecycle
├── quickstart.md      # validation scenarios per outcome
├── contracts/
│   ├── http.md            # routes, response additions, error codes
│   ├── language-pack.md   # pack interface and contract tests
│   ├── config.md          # the `search` config block
│   └── telemetry.md       # metric and alarm events
└── tasks.md           # /speckit-tasks
```

### Source Code

```text
packages/data-schemas/src/
├── schema/{messageSearch,conversationSearch,searchVocab,searchState}.ts   # new
├── models/{messageSearch,conversationSearch,searchVocab,searchState}.ts   # new
├── app/search.ts                    # new: loadSearchConfig; app/service.ts gains `search`
├── utils/searchError.ts             # new: SearchError
├── methods/search.ts                # new: all search reads and writes, plain types
├── methods/index.ts                 # add search methods and the injected port
├── methods/conversation.ts          # seam in getConvosByCursor
├── methods/share.ts                 # seam in getSharedLinks; createShareMethods gains deps
├── models/plugins/indexable.ts      # new: isIndexableSource, a pure predicate over plain fields
└── types/search.ts                  # new: SearchPort and record types
packages/data-schemas/misc/documentdb/search.documentdb.spec.ts            # new

packages/api/src/search/             # all new
├── index.ts, config.ts, metrics.ts, meili.ts, failure.ts
├── service.ts                       # createSearchService: backend routing, limiter, shared read
├── start.ts                         # startup path: service, port, packs, writer, runner
├── analyzer/{fold,words,analyze,query,version}.ts
├── languages/{pack,registry}.ts
├── languages/en/index.ts
├── languages/is/{index,foldTable,NOTICE.md}
├── read/{plan,tiers,typo,rank,proximity,cursor,frozen,page,window,titles,retry,limiter}.ts
├── sync/{lease,stream,apply,extract,record,vocab,writer,observed,tenant}.ts
├── jobs/{runner,control,check,backfill,reconcile,vocabRebuild,verify,drop,script}.ts
└── http/{context,messages,conversations,shares,status,errors}.ts
packages/api/misc/search-quality/    # new, outside public CI: runner only; queries, corpus and pack data come by path
e2e/playwright.config.lighthouse.ts  # LIGHTHOUSE_MONGO_URI option, for FR-031's clone run

packages/data-provider/src/          # config.ts (`search` block), types, keys.ts, api-endpoints.ts, data-service.ts

api/server/routes/{messages,convos,share,search}.js   # calls into packages/api only
api/models/index.js                                   # supplies getSearchPort to createMethods
api/server/index.js, experimental.js                  # start the sync writer; start indexSync only when Meilisearch is configured
api/server/index.js, experimental.js                  # create the service after config loads; bind the port; app.locals.search
config/search-job.js                                  # new operator command: status, backfill, pause, resume, reconcile, verify, drop

client/src/routes/Search.tsx                          # load-more, busy, stop-word
client/src/components/Nav/SettingsTabs/About/          # attribution
client/src/components/Search/                         # new: BusyState, FailedState, PartialState, StopWordHint, LoadMore, CursorRestart
client/src/components/UnifiedSidebar/ConversationsSection.tsx  # partial, stop-word, busy and failed states
client/src/components/Nav/SettingsTabs/General/ArchivedChatsTable.tsx # same states
client/src/data-provider/queries.ts, packages/data-provider/src/data-service.ts # pass React Query's signal
client/src/components/Nav/SettingsTabs/Data/SharedLinks.tsx # busy, failed and stop-word states
client/src/locales/en/translation.json

docs/search/                                         # new: the feature's documentation, with runbook.md (generic: no tenant data)
```

**Structure Decision**: Monorepo layout as `AGENTS.md` requires and §9 proposes. New code stays in its own directories, with four read seams and no write-path edits, to keep the fork carry small. Infrastructure work lives in the separate infrastructure repository and is listed in `tasks.md` as such.

## Delivery order

Mirrors §10, except where the owner decision of 2026-11-10 replaced the separate sandbox measurement and the shadow stage with a live trial on the sandbox tenant. Stage numbers are kept, because tasks name them. Code steps can merge dark because the default configuration leaves them unused.

| Stage | Work | Exit |
|---|---|---|
| 0. Operator prework | Message counts, Azure database, private data copy (FR-031, FR-045) | Counts recorded. No tenant image holds the data until T146, which gates stage 8 |
| 1. Sandbox | Cut as a separate stage (owner decision, 2026-11-10). Stage 7's trial answers §10 step 3 and [R-05](research.md#r-05-what-the-sandbox-must-also-answer) on the real code | See stage 7 |
| 2. Engine | Runbook's upgrade section first. Clone trial, compat specs, lighthouse, pre-upgrade snapshots, rollout in batches, with FR-031's halt rule | Every awake AWS tenant on one engine; a hibernating tenant upgrades on wake-up |
| 3. Analyzer and packs | US4 contract, `is`, `en`, parity | SC-016; FR-007 parity on the corpus |
| 4. Storage and reads | US1 and US2 on `/search`, sidebar, shared links | SC-001 to SC-004 through the real read path |
| 5. Sync, backfill, reconcile | Writer, lease, jobs; runbook's backfill section | Replica-set tests; live DocumentDB spec on the sandbox |
| 6. Client and status | Load-more, states, attribution, `/enable` | Component tests, lighthouse |
| 7. Sandbox trial and runbook | Metrics, alarms, remaining runbook sections. Then the trial: the sandbox tenant, on DocumentDB 8.0, with a backfill, the sync writer and the new search serving | Quickstart scenarios on the sandbox tenant; FR-031 stop rules and the trial gate (SC-005 to SC-012) read by the owner; defaults retuned in `contracts/config.md`; [R-17](research.md#r-17-if-the-sandbox-rules-out-change-streams) decided; after-removal rollback timed on a clone before stage 10 needs it |
| 8. First production backfill | Entry: the trial's verdict recorded; T146's image; scrape on and named queries working; alarms attached; two weeks of SC-008 and SC-012 baseline; FR-046's cost recorded; SC-001 to SC-004 passing. Then search data on, backfill, reconcile | Verification passed on the first production tenant |
| 9. Shadow | Cut (owner decision, 2026-11-10) | None |
| 10. Cutover and removal | Per-tenant entry: stage 8's checks, verified backfill, and SC-001 to SC-004 rerun if the analyzer or ranking changed (FR-034). Tenant by tenant, 30-day hold, removal | SC-015, SC-017 |

Stages 3 to 7 hold the application code. Stages 0, 2, 8 and 10, and stage 7's trial, are operator work. The runbook's release checklist (FR-031, FR-034, FR-040) applies to every release from stage 2 on. The trial's results can send stages 4 and 5 back for rework, and no production tenant starts before the owner has read them.

## Requirements map

| FRs | Where |
|---|---|
| FR-001 to FR-007, FR-046 | `analyzer/`, `languages/`; [contracts/language-pack.md](contracts/language-pack.md) |
| FR-008 to FR-013, FR-016 | `read/`, `methods/search.ts`; `read/titles.ts` for title and tag search |
| FR-014, FR-015, FR-017 | `http/messages.ts`, `read/window.ts`, `read/limiter.ts` |
| FR-018, FR-020 | `failure.ts`, `http/errors.ts`, `read/retry.ts`, `metrics.ts` |
| FR-019, FR-030 | `http/status.ts`, `service.ts`; config snapshot per [R-19](research.md#r-19-config-channel) |
| FR-021, FR-022, FR-029 | schemas, `sync/extract.ts`, `isIndexableSource`, `getSearchableMessages` |
| FR-023 to FR-025 | `sync/` |
| FR-026 to FR-028 | `analyzer/version.ts`, `jobs/` |
| FR-031, FR-038 to FR-040 | Operator: runbook, infrastructure repository, sandbox trial |
| FR-034 to FR-037 | Runbook, `http/status.ts`, `sync/observed.ts`. FR-032 and FR-033 are withdrawn |
| FR-041 | [contracts/config.md](contracts/config.md) |
| FR-042, FR-043 | `client`, `/api/search/meta` |
| FR-044, FR-045 | [R-02](research.md#r-02-language-data-delivery), `languages/is/NOTICE.md` |
| FR-047 | PR checklist grep |

## Main risks

1. **Unmeasured on the target database.** Latency, TTL events, `singleBatch` and hints. The sandbox trial settles them before any production tenant.
2. **Multi-word paging is untested** (§5). [R-07](research.md#r-07-multi-word-paging) relies on a negated filter that DocumentDB must plan acceptably; the trial checks it.
3. **Paging differs from the evidence.** The reference cursor loses same-date rows, and bulk imports make them likely. [R-06](research.md#r-06-paging-model)'s frozen plan, windows and tie reads are new, so tests start from the real first page.
4. **Shared read must give one first page.** The read is sized for the sidebar and the page for `/search`. [R-08](research.md#r-08-shared-read) derives the page by replaying the stop rule; a test pins it at both limits.
5. **CPU in the API process.** Analysis takes about 1.4 ms per message in the reference. Backfill yields between messages and is throttled, and SC-008 aborts it.
6. **Fork carry.** Upstream's own search direction is checked before stage 3 and before cutover.

## Complexity Tracking

| Exception | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Encrypted paging cursor | The frozen plan holds word list expansions that may name other users, and FR-029 allows no exposure but timing | Keeping expansions on the server would need shared storage of query-derived tokens, which FR-020 argues against |
| Dynamic import of the `is` pack's library | FR-045 keeps it out of the public repository, so it cannot be a static dependency, and FR-046 requires no load when search data is off | A static import breaks public builds and loads 153 MB for tenants that have it off |
| Dynamic import of the `en` pack's stemmer | FR-030 requires no pack loaded when search data is off, and a stemmer library is a pack | A static import loads it for every tenant, including the ones with search off |
| An `e` writer epoch on search records, which the design does not have | FR-024 requires that a paused writer that lost its turn does no harm; the design assumed one consumer | Lease checks alone leave a window between check and write |
