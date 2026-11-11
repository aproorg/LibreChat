# Config Contract: the `search` block

New optional field on `configSchema` in `packages/data-provider/src/config.ts`, read in `librechat.yaml` per tenant. Omitted, the app behaves as today (FR-041). The loader keeps raw config, so `loadSearchConfig` applies these defaults and joins `AppService` ([R-03](../research.md#r-03-seams-into-existing-code)).

Read once from the base config at process start ([R-19](../research.md#r-19-config-channel)). A change takes effect by rolling restart, which the runbook times (SC-017). `search` is in `BASE_ONLY_CONFIG_SECTIONS`, so no config document can change it.

```yaml
search:
  data: false                # sync, backfill, packs. Off: no pack loaded, no new records, no attribution
  backend: meilisearch       # meilisearch | search. `search` needs data: true
  languages: [is, en]
  languageDataDir: ''        # required when `is` is enabled; R-02
  largestUserId: ''          # set in tenant config; only a boolean reaches logs
  sidebarLimit: 1000         # today's value
  rankWindow: 200            # 25 to 200; the maximum bounds cursor size (R-06), the minimum is one page
  readConcurrency: 2
  maxConcurrentSearches: 4   # one user holds at most half; title reads have their own gate at 4x (R-12)
  queryWordLimit: 10         # max 32; the words ride in the cursor (R-06)
  searchTimeoutMs: 10000
  syncTakeoverSeconds: 30    # a waiting process checks every third of this, so takeover takes up to 4/3 of it
  vocabFlushSeconds: 300
  reconcileDays: 30
  sharedReadMaxBytes: 67108864
  statusCacheSeconds: 15
  analysisCacheWords: 100000
  meiliResyncPending: false  # rollback after removal: hide search until the full sync reports complete
  jobs:
    batchSize: 200
    batchDelayMs: 1000
    vocabCopyBatchSize: 5000 # word list rows per batch in a rebuild's copy pass; max 50000
    backfillOnStart: false   # the lease holder requests a backfill after startup if no chain exists yet
  sync:
    watch: database          # database | collections: R-05's fallback opens one stream per source collection
    dropUpdatedText: true    # R-09's $project on update events; off if the engine rejects the stage
  rank:
    lengthBucket: true       # FR-011
  prefix:
    maxCommonReads: 4
    maxRareTokens: 200
    maxVocabRows: 50000
  typo:
    maxCorrections: 8        # max 16
    maxVocabRows: 50000
```

Validation: `.strict()`; integers with a minimum of 1; `languages` is a plain string array, checked by the service against registered packs ([contracts/language-pack.md](language-pack.md)). A cross-field check on `backend` and `data` logs a configuration error rather than failing startup (FR-019). Each field gets a doc comment, plus an entry in `librechat.example.yaml`, which carries only neutral defaults.

Sources for defaults: [R-16](../research.md#r-16-planning-defaults). The sandbox may change them, and this file is updated in the same change.
