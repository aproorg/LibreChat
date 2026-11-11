# Data Model: Conversation Search

All records are new and derived. `messages` and `conversations` keep their shape, fields and indexes (FR-021). Dropping all four collections affects nothing else. All four schemas set `autoCreate: false` and `autoIndex: false`, so nothing appears while search data is off ([R-11](research.md#r-11-backfill-reconcile-verify)). One tenant per database ([R-04](research.md#r-04-one-tenant-per-database)).

## Message search record (`msearch`)

| Field | Type | Notes |
|---|---|---|
| `_id` | source `_id` | A delete event carries only this |
| `user` | string | Required on every read |
| `conversationId` | string | |
| `messageId` | string | Unique only per user and tenant |
| `createdAt` | Date | Source value; sort key |
| `n` | number | Token count, for the length bucket |
| `h` | string | Hash of extracted text, `user`, `conversationId`, `createdAt`; same value writes nothing |
| `v` | string | Analyzer version |
| `e` | number | Writer epoch; 0 from backfill ([R-09](research.md#r-09-sync-writer)) |
| `tokens` | string[] | At most 3,000; compound parts carry `~` |
| `tenantId` | string, optional | Tenant plugin |

**Index**: `{ user: 1, tokens: 1, createdAt: -1 }`, named `user_tokens_created`, created after backfill's load.

**Never stored**: message text, `contextMeta`, `summary`, tool output. `aproorg/0.8.8` keeps no unredacted private copy of a message; FR-022 binds any added later. Text comes from `parseTextParts(content, false, { includeSteer: true })` when `content` is an array, else `text`.

**Validation**: A record exists only when `isIndexableSource` holds for the source: indexable by the stored temporary flag and expiry, not `unfinished`, and `subagentTask` unset. `subagentTask` is `select: false`, so every source read must project it.

## Conversation search record (`csearch`)

| Field | Type | Notes |
|---|---|---|
| `_id` | source `_id` | |
| `user`, `conversationId` | string | |
| `h`, `v`, `e` | | As above; `h` covers title, tags, `user`, `conversationId` |
| `tokens` | string[] | From title and tags |
| `tenantId` | string, optional | |

**Index**: `{ user: 1, tokens: 1 }`. **Validation**: `isIndexableSource` holds, `subagentThread` unset.

## Word list (`search_vocab`)

| Field | Type | Notes |
|---|---|---|
| `_id` | string | The token, including `~` forms |
| `df` | number | Approximate; only orders expansions and rarity |
| `dfNext`, `r` | number, optional | Rebuild in progress ([R-10](research.md#r-10-vocabulary-upkeep-and-rebuild)) |

`_id` serves prefix ranges, so no other index. May contain names, so each tenant's retention rules name it (FR-029). Only the active writer writes it.

## Sync state (`search_state`)

One collection with one document per key, so `_id` is a string. Fields hold IDs, counts, timestamps and statuses, never content.

| `_id` | Fields | Purpose |
|---|---|---|
| `lease` | `holder`, `epoch`, `leaseUntil` | One writer per database |
| `stream` | `resumeToken`, `epoch`, `savedAt`, `syncedTo?`, `lastEventAt?`, `gapAt?` | Where sync resumes. `syncedTo` is the time every earlier change is known applied, which verification waits on. `lastEventAt` is when the last delivered change happened |
| `backfill:messages`, `backfill:conversations` | `lastId`, `status`, `pause`, `pausedReason?`, `startedAt`, `processed`, `total`, `skipped`, `analysisFailures`, `rate`, `rateAt`, `finishedAt?` | Crash resume, pause flag, progress |
| `reconcile` | `pass`, `phase`, `lastIds` (one per phase), `status`, `startedAt`, `missing`, `orphans`, `stale`, `of`, `repaired`, `analysisFailures`, `inChain`, `failures?`, `lastFailureAt?`, `lastFailureCode?`, `finishedAt?` | Reports before repair. The runner compares a request's time with `startedAt` to tell whether this run answers it |
| `verification` | `status` (`pending`, `passed`, `failed`), `reason?`, `snapshotAt`, `passedAt`, `invalidatedAt`, `invalidatedBy?` (`config`, `tenant_mismatch`), `mismatchedUsers`, `rounds`, `checked`, `missing`, `missingIds` (a sample), `orphans`, `expired`, `analysisFailures`, `otherVersion`, `running`, `gaveUp`, `failures?`, `lastFailureAt?`, `lastFailureCode?`, `finishedAt` | Readiness (FR-019, FR-037) |
| `analyzer` | `version`, `packs` with attribution text and URL, `attributionUntilReanalyzed`, `tenantId` | Token changes (FR-026), FR-043 after a disable, tenant pin |
| `chain` | `requestId`, `step`, `startedAt`, `finishedAt?`, `failures?`, `lastFailureAt?`, `lastFailureCode?` | Backfill chain position, resumed by each new lease holder. Automatic reconcile waits for `finishedAt` |
| `observed` | `backend`, `data`, `observedAt` | Last config seen, compared at each process start (R-11) |
| `vocab` | `run`, `phase`, `lastId`, `walked`, `walkedAt`, `status`, `startedAt`, `finishedAt?` | Rebuild run number and resume position |
| `jobRequest:<id>` | `job`, `requestedAt`, `verifyRound?`, `reconciledAt?` | Written by `config/search-job.js`, and by the writer and runner for a gap, a token change and the mismatch loop, which keeps its round here |
## Language pack

In code, not storage: [contracts/language-pack.md](contracts/language-pack.md).

## State transitions

**Record lifecycle**

```text
source written ─► not indexable or unfinished ─► record removed, if any
              └► indexable ─► same h at the current analyzer ─► no write (raises e during replay after takeover)
                           └► otherwise ─► replace record (guarded by e)
source deleted ─► record removed
backfill or repair batch ─► post-write source check removes anything now absent or non-indexable
older v ─► rewritten by reconcile (compare-and-set on h, v)
```

**Tenant lifecycle** (operator-driven, one tenant at a time)

```text
search data off ──on──► syncing ──backfill requested──► backfilling ──load, indexes, word list, reconcile──► verifying
verifying ──mismatch──► alarm, reconcile, verify again; after 3 rounds status failed, owner called
verifying ──passed──► ready (Meilisearch still serving)
ready ──entry checks pass──► backend: search (30-day hold, Meilisearch in sync)
hold ──30 days──► Meilisearch and its volume removed
any stage before removal ──abort threshold──► backend: meilisearch + written cause; next process start invalidates verification
after removal ──rollback──► reset sync state, full sync, search hidden until finished
back to search after abort ──► reconcile + verification pass, later than invalidatedAt (FR-037)
search data turned off ──► sync stops, verification invalidated; runbook drops records, word list and state by the retention deadline
```

## Relationships

`msearch._id` → `messages._id`. `csearch._id` → `conversations._id`. Neither is enforced in the database. Reconcile checks both directions, and reads re-check message and conversation visibility before display (FR-014).
