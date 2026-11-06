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

## Shadow

## Cutover

## Rollback

## Retention

## Release checklist
