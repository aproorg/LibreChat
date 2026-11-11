# Search jobs and the operator script

Back to the [overview](README.md). For step-by-step procedures, see the [runbook](runbook.md).

## `config/search-job.js`

The operator's command line. It runs as a one-off task with the tenant's environment, connects
to the tenant's database, and then either reads state or leaves a request for the server. It
builds nothing when it connects, and on a crash it prints the error's class and code only.

```bash
node config/search-job.js status
```

| Command           | What the script does                               | Who does the work |
| ----------------- | -------------------------------------------------- | ----------------- |
| `status`          | Reads `search_state` and prints it. Writes nothing | The script        |
| `backfill`        | Writes one request                                 | The lease holder  |
| `pause`, `resume` | Writes one request                                 | The lease holder  |
| `reconcile`       | Writes one request                                 | The lease holder  |
| `verify`          | Writes one request                                 | The lease holder  |
| `drop --yes`      | Deletes the four search collections                | The script        |

Exit codes: `0` done, `1` refused or failed, `2` an unknown command or a missing `--yes`.

### How a request works

A request is one document in `search_state` named `jobRequest:<id>`, holding the job and the
time. The API process that holds the sync lease looks for requests on every heartbeat (every 10
seconds by default), runs the job, and removes the request when the job is done.

The job runs in the server and not in the script so that it survives a restart: the next lease
holder finds the request and the saved position, and carries on.

Before it writes a request, the script checks three things:

- **The search collections exist.** If not, it writes nothing and says to turn `search.data`
  on, so it cannot create a collection on a tenant with search off.
- **No chain is already running**, for `backfill`. If one is, it writes nothing.
- **A process holds the lease.** If none does, the request is still written, with a warning
  that it waits until a server is up.

## The backfill chain

Turning `search.data` on starts sync only. The first load starts when an operator runs
`backfill`, or at startup with `search.jobs.backfillOnStart`. The lease holder then runs five
steps in order. Each step saves its own position, so a crash or a deploy needs no action.

| Step      | What it does                                                                                                            | Resumes from                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Backfill  | Walks `messages`, then `conversations`, and inserts a record for each. A record sync already wrote is never overwritten | Its saved position per collection   |
| Indexes   | Builds the record indexes, after the load                                                                               | Safe to repeat                      |
| Word list | Counts every record's tokens and replaces the word list                                                                 | Its saved phase and position        |
| Reconcile | Counts the differences between sources and records, then repairs them                                                   | Its saved pass, phase and positions |
| Verify    | Compares sources and records by ID. A pass makes the tenant ready                                                       | Starts over                         |

Jobs are throttled by `search.jobs.batchSize` and `batchDelayMs` (200 rows, then one second, by
default). `pause` stops the running job at its next batch, and `resume` lets it carry on.
Nothing pauses by itself.

## Reconcile

Reconcile is the safety net behind live sync. It walks every source and every record in both
directions, reports what differs, then repairs it, and ends by rebuilding the word list.

**Why it is needed.** Sync follows a change stream, and a stream can miss things:

- The server was down for longer than the stream's log is kept, or a resume failed.
- An event was skipped after failing three times.
- A delete emitted no event, which is possible for TTL deletes on some engines.
- A deploy changed how words are analysed, so older records need rebuilding.
- The word list drifted: its counts only go up between rebuilds.

**When it runs.**

| Trigger                                        | When                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| The timer                                      | `search.reconcileDays` (30 by default) after the last reconcile finished, at whatever hour that was |
| A gap in the change stream, or a skipped event | At once                                                                                             |
| A deploy that changes tokens                   | When the new writer starts                                                                          |
| A failed verification                          | At once, followed by another verification, up to three rounds                                       |
| An operator                                    | `node config/search-job.js reconcile`                                                               |
| The backfill chain                             | As its fourth step                                                                                  |

There is no setting for the hour. To choose it, run `reconcile` at that hour: the next
automatic run is then `reconcileDays` after that one finishes.

## Verify

Verification compares sources and records by ID, in both directions. Only sources older than a
minute count, and a suspect is read again once sync has passed it, so a change still in flight
is not called a gap. A pass is what makes the search box show.

| Result                            | Meaning                                                                                  | What happens next                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `passed`                          | Every source that belongs has a record, and no record lacks its source                   | The tenant is ready                                                          |
| `failed`, `mismatch`              | Records are missing or left over                                                         | Reconcile and verify again, up to three rounds, then the owner is called     |
| `failed`, `sync_behind`           | Sync had not caught up when the walk ended                                               | The same loop                                                                |
| `failed`, `sync_not_started`      | No sync writer has ever saved a position, usually because change streams are not enabled | Fix the cause, wait for `sync: last saved` to show a time, then run `verify` |
| `failed`, `analysis_failed`       | A language pack threw on some rows, so they have no record                               | Fix the pack, then run `backfill`                                            |
| `failed`, `backfill_not_finished` | Verification ran before the first load ended                                             | Let the chain finish                                                         |

A pass can be invalidated later: by a rollback to Meilisearch, by `search.data` going off, or
by a second tenant appearing in the database. Search is then hidden until a new verification
passes.

## Reading `status`

| Line                                           | Shows                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `chain step`, `failed attempts`                | Where the backfill chain is, and its last failure by class and code                 |
| `paused`, `lease held`                         | Whether a pause is set, and whether a process holds the lease                       |
| `messages`, `conversations`                    | Rows processed, rate, estimated finish, and rows a pack failed on                   |
| `word list`                                    | The rebuild's phase and progress                                                    |
| `sync`                                         | `last saved` (the writer is alive), `last change` (the stream delivers), `last gap` |
| `reconcile`                                    | The counts from its last report and what it repaired                                |
| `verify`                                       | The result, its reason, the counts, and when it last passed or was invalidated      |
| `pending requests`, `distinct tenantId values` | Requests waiting, and how many tenants the database holds                           |
| `next`                                         | The one thing to do                                                                 |

`last saved` keeps moving on an idle stream. `last change` moves only when a change was
delivered, which is how an open stream that delivers nothing is told from a quiet one.

## `drop`

`drop --yes` removes the four search collections and nothing else. It runs in the script,
because it is for a tenant that has turned search off, and then no server holds the lease.

It refuses:

- without `--yes`
- when the loaded configuration has no `search` block
- while `search.data` is on
- while a process holds the lease, or for `syncTakeoverSeconds` after a sync writer last saved

## Log lines to look for

Every failure log starts with `[search]` and carries the error's class, driver code and code
name. It never carries the error's message, a query or a document.

| Line                               | Meaning                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `[search] Language pack failed`    | A pack did not load. That process takes no lease and serves no search        |
| `[search] Background start failed` | The collections or the lease could not be set up at start. It is tried again |
| `[search] Job heartbeat failed`    | The job runner could not read or renew its state                             |
| `[search] Sync failed`             | The sync writer's turn failed. It is tried again, with a growing wait        |
| `[search] Job failed`              | A job step failed. It is tried again, with a growing wait                    |
| `[search] Read failed`             | One search read failed, and the user got `search_failed`                     |
