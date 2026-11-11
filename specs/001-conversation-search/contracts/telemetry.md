# Telemetry Contract

Structured `logger` events under `search.*`, per [R-14](../research.md#r-14-metrics-and-alarms). Allowed fields: numbers, durations, stable codes, surface names, record IDs. Never query text, document content, raw error text or a user's words (FR-020). A unit test feeds a sentinel string through every path and asserts it reaches no log.

| Event | Fields | Used by |
|---|---|---|
| `search.request` | `surface`, `backend`, `ms`, `reads`, `rows`, `words`, `tierReached`, `coldAfterIdle`, `isLargestUser`, `outcome` | SC-006, SC-007. Emitted on `backend: search` only; on `meilisearch` nothing is emitted (FR-041) |
| `search.cursor_error` | `surface`, `retries`, `final` | Search reads only. Other routes: [R-14](../research.md#r-14-metrics-and-alarms) |
| `search.sync_lag` | `lagMs`, `batch` | SC-009 |
| `search.sync_status` | `savedAgeMs`, `hasHolder`, `isHolder` | Each minute from every process with data on. Liveness for SC-009, FR-039; alarms on age and on missing data |
| `search.sync_gap` | `resumeFailed`, `restartedAt` | FR-039 |
| `search.sync_skip` | `id`, `attempts`, `code` | Poison event edge case |
| `search.sync_stop` | `code` | The writer stopped for good in this process: `tenant_mismatch` when a second non-null `tenantId` appears (R-04) |
| `search.lease` | `holder`, `epoch`, `event` | FR-024 |
| `search.partial` | `surface`, `code` | US2, scenario 8 |
| `search.reconcile` | `missing`, `orphans`, `stale`, `of` | SC-010 |
| `search.verify` | `status`, `mismatchedUsers`, `round` | FR-028 |
| `search.pack` | `id`, `state`, `ms`, `rssDelta` | FR-046, pack failure |
| `search.backfill` | `collection`, `rate`, `processed`, `status`, `pausedReason?` | FR-028, watching a first run |
| `search.realtext` | `tokensPerMessage`, `tierShare`, `prefixFanout`, `atCap`, `noLetterQueries`, `stopOnlyQueries`, `typoSkippedWordExists`, `vocabRowsTruncated` | §10's real text list, plus how often a budget cut a word list read |

`isLargestUser` compares the caller to `search.largestUserId`, so the log line holds no ID. `coldAfterIdle` is true for the first search in this process after 30 minutes with none. On a multi-task tenant one process can be cold while the cluster is not, so the runbook keeps only samples where capacity was at the floor.

## Source per measure

| Measure | Source |
|---|---|
| SC-005 leaks | SC-004's isolation checks in the quality suite on the release. In the trial and each hold, the log check is `search.reconcile` `orphans` and `search.verify`: a record whose source is absent or no longer indexable (temporary, subagent, unfinished) counts there. Owner decision, 2026-11-10: probes are cut |
| SC-006, SC-007 latency | `search.request` |
| SC-008 cursor errors, search | `search.cursor_error` |
| SC-008, FR-038 cursor errors, elsewhere | CloudWatch log filter on `Cannot open a new cursor` in existing error logs, excluding `search.*` lines. Any such line counts as a chat route: conservative, because existing lines name a method rather than a route |
| SC-008 chat save p95 | `mongoose_query_duration_seconds`, `Message` model, `operation="findOneAndUpdate"`, from `/metrics`, which `api/server/index.js` serves and `api/server/experimental.js` does not. Only queries are instrumented, and message saves use this operation |
| SC-009 lag | `search.sync_lag`, `search.sync_status` |
| SC-010 drift | `search.reconcile` |
| SC-011, SC-012, FR-038 capacity and cursors | CloudWatch `ServerlessDatabaseCapacity`, `DatabaseCursorsMax`, `DatabaseCursorsLimit` |
| §10's per-search list | `search.request` for reads, rows and timings; CloudWatch `BufferCacheHitRatio`, `IndexBufferCacheHitRatio`, `VolumeReadIOPs` |
| FR-040 p95 | `search.request` |

**Alarms** live in the infrastructure repository: metric filters for the `search.*` and log rows above, and CloudWatch alarms for the capacity rows. They cover the abort thresholds, SC-006's p95, SC-009's thresholds, a sync gap, partial results, a verification failure and a pack failure. The Prometheus figure needs whatever scrape the tenant runs, and the backfill entry check confirms it.
