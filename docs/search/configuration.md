# Search configuration

Back to the [overview](README.md).

Search is configured by the optional `search` block in `librechat.yaml`. Omitted, the app
behaves as it does without the feature. The block is read once at process start, so every
change takes effect by a rolling restart, and no config document can change it. The commented
block in `librechat.example.yaml` lists every field with its default.

## The two settings that move a tenant

| Setting   | Default       | What it does                                                                        |
| --------- | ------------- | ----------------------------------------------------------------------------------- |
| `data`    | `false`       | Turns on sync, the jobs, the language packs and the dictionary credit               |
| `backend` | `meilisearch` | Chooses who serves searches: `meilisearch` or `search`. `search` needs `data: true` |

A tenant goes from off to serving in three moves: set `data: true` and restart, run the
backfill until verification passes, then set `backend: search` and restart. Rolling back is
setting `backend: meilisearch` again, for as long as Meilisearch still runs. The
[runbook](runbook.md) has each step.

```yaml
search:
  data: true
  backend: search
  languages: [is, en]
  languageDataDir: /path/to/the/delivered/language/data
```

## Languages

| Setting           | Default    | What it does                                                                                                               |
| ----------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `languages`       | `[is, en]` | The enabled language packs                                                                                                 |
| `languageDataDir` | empty      | Where the Icelandic pack loads its data from. Required when `is` is enabled. The data is delivered outside this repository |

## Search limits

| Setting                                                                | Default       | What it does                                                                                                       |
| ---------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `maxConcurrentSearches`                                                | 4             | Most searches one process serves at once. One user holds at most half. Above either, a search answers busy at once |
| `readConcurrency`                                                      | 2             | Most database reads one search runs at once                                                                        |
| `searchTimeoutMs`                                                      | 10000         | Time allowed for one search                                                                                        |
| `queryWordLimit`                                                       | 10            | Most query words used, counted after stop words (at most 32)                                                       |
| `sidebarLimit`                                                         | 1000          | Most messages the sidebar reads for one search                                                                     |
| `rankWindow`                                                           | 200           | Rows ranked per read window, from 25 to 200                                                                        |
| `prefix.maxCommonReads`, `prefix.maxRareTokens`, `prefix.maxVocabRows` | 4, 200, 50000 | Budgets for expanding the last word by prefix                                                                      |
| `typo.maxCorrections`, `typo.maxVocabRows`                             | 8, 50000      | Budgets for correcting a word that matches nothing                                                                 |
| `rank.lengthBucket`                                                    | `true`        | Prefers shorter messages among equal matches                                                                       |
| `sharedReadMaxBytes`                                                   | 67108864      | Memory for finished reads shared between `/search` and the sidebar, per process                                    |
| `statusCacheSeconds`                                                   | 15            | How long the answer behind `/api/search/enable` is cached                                                          |
| `analysisCacheWords`                                                   | 100000        | Words in the analyzer's cache. Affects speed only                                                                  |

Three limits are derived and have no setting of their own: one user's share of the cap (half,
at least one), the limit on title reads (four times the cap), and the number of words one
search corrects (three).

## Sync and jobs

| Setting                               | Default    | What it does                                                                                        |
| ------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| `syncTakeoverSeconds`                 | 30         | Seconds before another process takes over from a silent sync writer. The heartbeat is a third of it |
| `vocabFlushSeconds`                   | 300        | Seconds between word list flushes                                                                   |
| `reconcileDays`                       | 30         | Days between automatic reconcile runs. Also the longest a deleted word stays in the word list       |
| `jobs.batchSize`, `jobs.batchDelayMs` | 200, 1000  | Rows per batch in backfill and repair jobs, and the pause between batches                           |
| `jobs.vocabCopyBatchSize`             | 5000       | Word list rows settled per batch at the end of a rebuild (at most 50000)                            |
| `jobs.backfillOnStart`                | `false`    | Requests a backfill after startup if no backfill chain exists yet, so a deploy can start it         |
| `sync.watch`                          | `database` | `database` opens one change stream, `collections` opens one per source collection                   |
| `sync.dropUpdatedText`                | `true`     | Drops text from update events, so a large message edit fits in one event                            |

## Other

| Setting              | Default | What it does                                                                              |
| -------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `meiliResyncPending` | `false` | After a rollback to a removed Meilisearch: hides search until its full sync has caught up |
| `largestUserId`      | empty   | Flags that user's searches in metrics. Only a boolean reaches logs                        |

## Environment variables

| Variable                         | Role                                                                 |
| -------------------------------- | -------------------------------------------------------------------- |
| `SEARCH`                         | Gates the search box, as before                                      |
| `MEILI_HOST`, `MEILI_MASTER_KEY` | Decide whether Meilisearch's own sync starts                         |
| `JWT_SECRET`                     | Keys the load-more cursor. Rotating it ends every running pagination |

## What a wrong value does

- The block is validated strictly: an unknown key, or a value out of range, stops the process
  at startup. Check a tenant's block against the release checklist in the
  [runbook](runbook.md#release-checklist) before a deploy.
- `backend: search` with `data: false` is logged as a configuration error and serves nothing.
- A language ID with no registered pack is a pack failure: that process does not serve search,
  and chat is unaffected.
