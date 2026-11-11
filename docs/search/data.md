# Search data

Back to the [overview](README.md).

Search adds four collections to the tenant's database. They are derived from `messages` and
`conversations`, which gain no field and no index. Dropping all four affects nothing else.

## The four collections

| Collection     | One row is                                                                                | Written by                                                        | Read by                                                                              |
| -------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `msearch`      | One message's tokens, with its user, conversation and date. It shares the message's `_id` | Sync writer, backfill, reconcile                                  | `/search` and sidebar reads, reconcile, verify, the word list rebuild                |
| `csearch`      | One conversation's title and tag tokens                                                   | The same three                                                    | Title and tag reads for the sidebar and shared links, reconcile, verify, the rebuild |
| `search_vocab` | One distinct token and how many records hold it                                           | The sync writer's counter and the word list rebuild               | Every search (counts), prefix and typo expansion                                     |
| `search_state` | One document per key: the lease, positions, job state, verification                       | The job runner, the sync writer, the jobs, `config/search-job.js` | `/api/search/enable`, the `status` command, every job when it resumes                |

## What is never stored

- **Message text.** A record holds tokens only.
- **Tool output, context metadata, sender fields and IDs** as searchable text.
- **Temporary chats, expired rows, unfinished messages and subagent messages.** They have no
  record at all.

## The word list (`search_vocab`)

It holds one row per distinct token across the whole tenant: `{ _id: token, df }`, where `df`
is the number of records that hold the token. It carries no text, no user and no link to a
message.

**What goes in.** Every token of every record: the folded word, its dictionary forms or stem,
its compound parts, and numbers as typed. See [From text to tokens](how-it-works.md#from-text-to-tokens).

**What stays out.** Stop words, words over 48 characters, anything past a record's 3,000
tokens, and content that is never indexed.

**How it is written.**

1. **Live.** The sync writer counts the tokens of each new or changed record in memory and
   writes the counts every `vocabFlushSeconds` (5 minutes by default), or sooner once it holds
   50,000 distinct tokens.
2. **First load.** The backfill chain builds the list from all records in its word list step.
3. **Rebuild.** Every reconcile ends by recounting from the records and deleting every row that
   no record holds any more.

**What search uses it for.**

- **Rare or common.** A token found in 300 records or fewer is read differently from a common
  one, which keeps every read bounded.
- **Unknown words.** A query word with no row is what triggers typo correction.
- **Prefix and typo expansion.** Both read their candidate words from this list.

**What to know about its accuracy.**

- Counts only go up between rebuilds: an edited message is counted again, and a deleted one is
  not subtracted. Counts only order expansions and rarity, and the rebuild corrects them.
- A process killed before a flush loses the counts it held. A word first seen in that window is
  missing from the list until the next rebuild. Exact search still finds it; prefix and typo
  expansion do not.

## How long things stay

| When this happens                                   | The search record                                                                           | The word in the word list                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| A message is deleted, by a user or by a cleanup job | Removed within the sync lag, through the change stream                                      | Stays until the next rebuild, then removed if no other record holds it |
| A message is deleted by a TTL index                 | The same, if the engine emits a delete event. If it does not, the next reconcile removes it | The same reconcile removes it                                          |
| A chat turns temporary                              | Removed within the sync lag                                                                 | As for a delete                                                        |
| `search.data` is turned off                         | Stays until the operator runs `drop`                                                        | Stays until `drop`                                                     |

The automatic reconcile runs every `reconcileDays` (30 by default), so that is the longest a
word outlives its last message.

## Sensitive data and retention

The word list is tenant-wide and can hold single sensitive tokens: a name, a phone number, or
an ID or account number written as one run of digits. It never holds a sentence, and a row
does not say who wrote the word or where.

- **Who can read it.** No API returns the word list, and every search result is scoped to the
  searching user. People with database access, and backups, can read it.
- **Retention rules.** A tenant's retention rules must name the word list beside the message
  and conversation records, with the reconcile interval as its bound. The
  [runbook](runbook.md#retention) has the steps.
- **A shorter bound.** Lower `search.reconcileDays`, or request a reconcile after a cleanup
  run with `node config/search-job.js reconcile`. Each reconcile walks every source and every
  record and rebuilds the word list.

## Keys in `search_state`

| Key                                           | Holds                                                                                            | Used for                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `lease`                                       | Holder, epoch, expiry                                                                            | One writer per database                |
| `stream`                                      | Resume token, when it was saved, how far sync has caught up, the last delivered change           | Where sync resumes                     |
| `backfill:messages`, `backfill:conversations` | Position, status, pause flag, progress, rows a pack failed on                                    | Crash resume and progress              |
| `chain`                                       | The current step, start and finish, failures                                                     | Position in the backfill chain         |
| `vocab`                                       | Run number, phase and position                                                                   | The word list rebuild                  |
| `reconcile`                                   | Pass, phase, positions, counts of missing, orphaned and stale records                            | The report, then the repair position   |
| `verification`                                | Status, reason, when it passed, when and why it was invalidated, counts, a sample of missing IDs | Readiness                              |
| `analyzer`                                    | Version, the packs and their credit, the tenant pin                                              | Token changes and the one-tenant check |
| `observed`                                    | The last `backend` and `data` settings seen                                                      | Noticing a rollback at process start   |
| `jobRequest:<id>`                             | The job and when it was asked for                                                                | Work queued for the lease holder       |

Every field is listed in
[`data-model.md`](../../specs/001-conversation-search/data-model.md).
