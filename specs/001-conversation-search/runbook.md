# Runbook: Conversation Search

Operator steps, one tenant at a time. This file is public, so it holds no tenant names, hosts, IPs or figures from a tenant.

## Public repository check

Run before every PR and push (FR-045, FR-047). `SEARCH_TENANT_LIST` points at the list of tenant names and hosts held outside this repository, one per line. `BASE` is the target branch.

```bash
test -n "$BASE" || { echo "set BASE to the PR's target branch: check not run"; exit 1; }
test -s "$SEARCH_TENANT_LIST" || { echo "tenant list missing: check not run"; exit 1; }

# Tenant names and hosts, in the diff and in commit messages
git diff "$BASE"...HEAD | grep -Fif "$SEARCH_TENANT_LIST"
git log "$BASE"..HEAD --format='%an %ae%n%B' | grep -Fif "$SEARCH_TENANT_LIST"

# IP addresses, cloud hosts and home directories on added lines
git diff "$BASE"...HEAD | grep -E '^\+' \
  | grep -E '\b[0-9]{1,3}(\.[0-9]{1,3}){3}\b|amazonaws\.com|/Users/|/home/'

# BÍN-derived files must not be tracked
git ls-files | grep -E '(^|/)(vendor/search-language/|fold-table\.bin$|lemma-is/|stop-lemma\.json$|stop-extra\.json$|function-verbs\.json$)'
```

Each `grep` must print nothing. Any line printed stops the PR until a person has read it, because a version number can match the IP pattern.

## Upgrade

Every tenant moves to DocumentDB 8.0 before search work reaches it (FR-031). Meilisearch keeps serving throughout.

**Before starting**
1. Confirm `MaxCapacity` is at least 3.
2. Take a manual snapshot and record its identifier in the private tenant record.
3. Upgrade a clone of the tenant first. Time the downtime, and check that the `$type` partial indexes in `codeEnvironment.ts` survive.
4. On the clone, run `packages/data-schemas/misc/documentdb/*.documentdb.spec.ts` and the lighthouse lane with `LIGHTHOUSE_MONGO_URI`. Only point that option at clones, because the lane seeds a conversation.
5. Announce a window as long as the clone's downtime, plus the data-loss window below.

**During the upgrade**
- The cluster is unavailable and reboots several times.
- An index metadata refresh then runs for minutes up to two hours, with degraded performance. Don't reboot, fail over or scale the writer during it.

**Way back**: there is no downgrade. Restore the pre-upgrade snapshot to a new cluster and point the tenant at it.

**Data-loss window**: writes accepted after the snapshot are lost on that path. Take the snapshot with the app stopped or in its maintenance state, so the window is zero. If that isn't possible, record the gap between the snapshot and the upgrade's start before going ahead.

**Hibernating tenants**: AWS rejects changes to a stopped cluster, so a hibernating tenant upgrades on wake-up. Keep it on the list until that happens.

**Halt rule**: a blocker in a batch halts the rollout. Healthy upgraded tenants stay on 8.0, the blocked tenant restores from its snapshot, and the design reopens. If the sandbox passed it, the fallback is 5.0 with `plannerVersion` 2.0 and no major upgrade.

## Backfill

Fills one tenant's search collections while Meilisearch keeps serving (FR-028, FR-039). Users see no change. Every command below runs from the repository root in a one-off task with the tenant's environment.

**Cluster setup, once per tenant**
1. Enable change streams on the two source collections, each by itself, on the tenant's cluster:

   ```javascript
   db.adminCommand({ modifyChangeStreams: 1, database: '<database>', collection: 'messages', enable: true });
   db.adminCommand({ modifyChangeStreams: 1, database: '<database>', collection: 'conversations', enable: true });
   ```

2. Raise change stream retention to 7 days: set `change_stream_log_retention_duration` to `604800` in the cluster parameter group.
3. Record both in the private tenant record: the date streams were enabled and the retention value in force. A gap longer than the retention forces a restart of sync at the current position and a reconcile.

**Entry checks**
1. The tenant is on engine 8.0 (Upgrade).
2. Streams are enabled on both collections and the retention value is recorded.
3. The `/metrics` scrape is on and the chat save p95 query returns data ([contracts/telemetry.md](contracts/telemetry.md)). A tenant on `api/server/experimental.js` has no `/metrics`, so this check fails there.
4. Alarms are attached and have fired in a test: chat save p95, cursor errors, capacity pinned at maximum, sync lag and liveness, sync gap, verification failure, pack failure.
5. Two weeks of chat save baseline exist (SC-008), and the same two weeks of capacity hours (SC-012).
6. If `is` is in `search.languages`, the language data is in the image and `search.languageDataDir` points at it. Without it the pack fails to load and nothing below starts.
7. Run the status command before turning anything on. It only reads and works with search data off:

   ```bash
   node config/search-job.js status
   ```

   Read the `distinct tenantId values` line. More than one value means the database holds more than one tenant: stop, because one writer serves one database.

**Steps**
1. Set `search.data: true`, leave `search.backend: meilisearch`, and do a rolling restart. Each process loads the language packs after it listens. One process takes the lease, creates the four search collections and starts following changes.
2. Run `node config/search-job.js status` and expect `lease held: true`. If it stays `false`, look for `[search] Language pack failed` in the server logs.
3. Request the backfill, at a time when its load is acceptable:

   ```bash
   node config/search-job.js backfill
   ```

   Or set `search.jobs.backfillOnStart: true` in step 1. The lease holder then requests it by itself after startup, once, if no chain exists.
4. Watch it with `node config/search-job.js status`. The lease holder runs the chain in order: backfill, indexes, word list, reconcile, verify. The `chain step` line shows the step, each collection's line shows rows processed, rate and estimated finish, and the `next:` line names the one thing to do.
5. It is done when status shows `chain step: finished` and `verify: passed`. Meilisearch still serves, and `/api/search/enable` still answers from Meilisearch.

A crash or deploy mid-way needs no action: the next lease holder resumes the chain from its saved position, and a record sync wrote is never overwritten. Requesting `backfill` while a chain runs writes nothing.

**Thresholds that pause it**

From the start of the backfill, the abort thresholds of SC-008 and SC-011 apply (FR-028):

| Measure | Threshold |
|---|---|
| Cursor errors | Any on a chat route, or above 0.1% of searches |
| Chat save p95 | 25% worse than the baseline for 1 hour |
| Capacity | Pinned at maximum for 1 hour |

Nothing pauses by itself. The alarm calls the owner, and the action is to pause:

```bash
node config/search-job.js pause
```

Status then shows `paused: true`. Sync keeps running while the chain waits. Fix the cause first, for example a longer `search.jobs.batchDelayMs` by rolling restart, and then:

```bash
node config/search-job.js resume
```

**A failed verification**

1. The tenant stays not ready and an alarm fires. Nothing is lost: Meilisearch is still serving.
2. The lease holder reconciles and verifies again by itself, up to three rounds. Status shows the `round`.
3. After the third failed round it stops and the owner is called. Read the sample of source IDs in status, fix the cause, then run `node config/search-job.js reconcile` and `node config/search-job.js verify`
4. If status says a language pack threw on some rows, fix the pack and request `backfill` again, which re-reads every row.

## Cutover

**Basis** (FR-034). There is no side-by-side comparison with Meilisearch. A tenant moves on two things: the quality tests SC-001 to SC-004 passing on the release, and the sandbox trial, in which the sandbox tenant ran this code on DocumentDB 8.0 with a backfill, the sync writer and the new search serving. The owner read the trial against the trial gate (SC-005 to SC-012) and recorded a verdict. Each tenant then runs its own 30-day hold.

**Gate terms**, fixed before the trial is read and before any hold starts:

| Term | Meaning |
|---|---|
| Warm | A search with `coldAfterIdle` false: not the first in its process after 30 minutes with none |
| First search after idle | `coldAfterIdle` true, kept only where capacity was at the floor |
| Working hours, normal load | Set per tenant in the private tenant record, before its numbers are read |
| Chat save baseline | The tenant's two weeks before search data was turned on |
| Sample minimum | 20 per latency measure, the largest user's included. Fewer counts as not measured |

**Entry checks, per tenant**
1. SC-001 to SC-004 pass on the release being deployed (Release checklist).
2. The sandbox trial's verdict is recorded, and no later analyzer or ranking change is waiting on a rerun.
3. The backfill is verified: status shows `verify: passed`, with `last passed` later than the last restart that moved the tenant off the new search or turned search data off. `/api/search/enable` reports ready on `backend: search` only after verification passes.
4. Alarms work: the Backfill list, plus search p95 (SC-006) and partial results.
5. Meilisearch is healthy and in sync, so the way back is open.

**Steps**
1. Set `search.backend: search` and do a rolling restart. Record how long it takes to reach all processes.
2. Confirm `/api/search/enable` answers `true` and a search for a known word returns it.
3. Hold for 30 days. Meilisearch stays running and in sync: leave `MEILI_HOST` and `MEILI_MASTER_KEY` set, and do not remove or resize its volume (FR-036).
4. During the hold these thresholds apply (FR-035). Crossing an abort threshold means Rollback (a), with a written cause.

   | Measure | Abort |
   |---|---|
   | SC-005: another user's content, a temporary or subagent result, tool output or private text | Any |
   | SC-008: cursor errors; chat save p95 | Any on a chat route, or above 0.1% of searches; 25% worse for 1 hour |
   | SC-009: sync lag | Above 1 hour |
   | SC-011: capacity pinned at maximum | For 1 hour |
   | SC-006: warm p95 above 500 ms, or the largest user's above 1 s | No abort. The alarm goes to the owner, who decides |

5. On the sandbox trial only: seven days in, run `node config/search-job.js reconcile` and read its `missing`, `orphans`, `stale` and `of` counts in status for SC-010. They are counted before anything is repaired.
6. At cutover plus 30 days with no abort, remove Meilisearch and its volume together, in the infrastructure repository, and roll out with `MEILI_HOST` and `MEILI_MASTER_KEY` unset. The app runs cleanly without them (SC-015). Before the first removal anywhere, Rollback (b) must have been timed once on a snapshot clone of the trial tenant's data.

**Capacity floor** (FR-038). From the first backfill on, check each tenant weekly from metrics, in working hours. The floor stays at 0.5 DCU unless one of these fires over 7 days:

- any cursor error on any route;
- peak cursors above 80% of the limit in 3 or more 5-minute periods;
- first-search-after-idle p95 above 2 s with 20 or more samples.

Then raise the floor to 1.5 DCU, and to 2 if it still fires. If it still fires at 2, stop and reopen the design. Come back down after 30 days with no trigger. Record each weekly decision in the private tenant record.

## Rollback

**(a) Before cutover and during the hold: one setting**

1. Before cutover, Meilisearch is already serving, so there is nothing to switch. To stop the new search's load, pause the backfill (Backfill), or set `search.data: false`, after which the Retention drop deadline applies.
2. During the hold, set `search.backend: meilisearch` and do a rolling restart.
3. Record how long the restart takes to reach all processes (SC-017), and the written cause of the abort.
4. Leave `search.data: true` unless the cause is the sync writer's own load. Sync then keeps the records current for a return.

Each process notes the change at its next start and invalidates the old verification, so an earlier pass can't serve again (FR-037).

**(b) After Meilisearch has been removed**

Do these in exactly this order. Rehearse it once on a snapshot clone of the trial tenant's data with a parallel Meilisearch, and record the duration (FR-036).

1. Roll out `search.data: false`, `search.backend: meilisearch` and `search.meiliResyncPending: true`, with the Meilisearch variables still unset. `indexSync` stays off and `/api/search/enable` answers `false`, so search is hidden.
2. Reset Meilisearch's sync flags:

   ```bash
   node config/reset-meili-sync.js --yes
   ```

   This updates every message and conversation. It comes after step 1 because, with search data on, those updates would flood the sync writer.
3. Redeploy Meilisearch on an empty volume. Then roll out with `MEILI_HOST` and `MEILI_MASTER_KEY` set. The rollout is what starts the full sync, because `indexSync` runs only at process start.
4. Wait. Search stays hidden until the full sync passes the gate: per model, nothing pending indexing or cleanup, and unprocessed documents within `MEILI_SYNC_THRESHOLD`.
5. Roll out `search.meiliResyncPending: false`.
6. Search data is now off, so the Retention drop deadline runs from step 1.

**Return after an abort** (FR-037)

1. After (a) with search data left on: run `node config/search-job.js reconcile`, then `node config/search-job.js verify`
2. After search data was off: set `search.data: true` with `search.backend: meilisearch` and do a rolling restart. Turning data on discards the saved stream position, because the writes made while it was off are no longer in the stream. The writer starts at the current position and queues a reconcile by itself. Then run `node config/search-job.js verify`
3. If `drop` ran in between, the records are gone: run the Backfill section from its steps instead.
4. Only when status shows `verify: passed`, with `last passed` later than the rollback, set `search.backend: search` and do a rolling restart.

## Retention

The search data is derived from messages and conversations, and it falls under the same retention duties (FR-029).

1. **Name the word list.** The tenant's retention rules must name the word list (`search_vocab`) beside the message and conversation records. It is tenant-wide, it may hold names, and a word stays in it after its last message is deleted, until the next reconcile rebuilds the list.
2. **The bound is the reconcile interval.** `search.reconcileDays` (default 30) is the longest a deleted word can stay in the list. If the tenant's rules need less, lower it by rolling restart, or run `node config/search-job.js reconcile` after a deletion that must take effect sooner.
3. **TTL deletes.** Message and conversation records follow a delete through the change stream within the sync lag (SC-009). If the sandbox trial shows that TTL deletes emit no change event, reconcile is what removes those records, and the reconcile interval becomes their bound too. The owner accepts that interval in writing against the tenant's retention duties before the tenant's backfill.
4. **Search data turned off.** After `search.data: false`, including after a permanent abort, drop the search data by the deadline in the tenant's retention rules:

   ```bash
   node config/search-job.js drop --yes
   ```

   `--yes` confirms it, since a one-off task has no terminal to ask in. It refuses while search data is on, while a process still holds the sync lease, and when the configuration it loads has no `search` block (set `search.data: false` rather than deleting the block, and check `CONFIG_PATH`). And it removes only the four search collections: `msearch`, `csearch`, `search_vocab` and `search_state`. Messages and conversations are untouched. Record the date in the private tenant record. Turning search data on again after a drop needs a new backfill.

## Release checklist

For every release that reaches a tenant with search data on (FR-031, FR-034, FR-040).

1. **Query plan.** On the release, run `explain` on the message window read against a clone or the sandbox tenant. It must use the `user_tokens_created` index, in index order, with no sort stage. A change here stops the release: the latency targets rest on this plan.
2. **Engine compatibility.** On a clone, run `packages/data-schemas/misc/documentdb/*.documentdb.spec.ts` and the lighthouse lane with `LIGHTHOUSE_MONGO_URI` set to the clone. Only point that option at clones, because the lane seeds a conversation.
3. **Quality, on an analyzer or ranking change.** Before any later tenant's cutover, rerun SC-001 to SC-004 with the private data:

   ```bash
   cd packages/api && npm run test:search-quality
   ```

   A miss stops cutovers until it is fixed, or the owner re-baselines in writing.
4. **Token changes.** After a deploy that changes tokens (a pack, a stop list, folding, splitting or a cap) has reached every process, run `node config/search-job.js reconcile` on each tenant with search data on. During a rolling deploy an old process can retake the lease and write older tokens behind the walk, so the writer's own reconcile at start is not enough.
5. **Meilisearch index settings.** If the release changes Meilisearch index settings, write a plan first. `indexSync` then resets every sync flag at process start, which updates every message and conversation while the sync writer is on. Schedule it outside working hours, watch sync lag against SC-009, and expect the lag alarm.
6. **Upstream.** Before each cutover, check upstream's own search direction again and record it ([R-20](research.md#r-20-upstream-search-check)).
7. **Public repository.** Run the public repository check at the top of this file.
