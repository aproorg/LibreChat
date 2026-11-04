# Config Contract: the `search` block

New optional field on `configSchema` in `packages/data-provider/src/config.ts`, read in `librechat.yaml` per tenant. Omitted, the app behaves as today (FR-041). The loader keeps raw config, so `loadSearchConfig` applies these defaults and joins `AppService` ([R-03](../research.md#r-03-seams-into-existing-code)).

Read once from the base config at process start ([R-19](../research.md#r-19-config-channel)). A change takes effect by rolling restart, which the runbook times (SC-017). `search` is in `BASE_ONLY_CONFIG_SECTIONS`, so no config document can change it.

```yaml
search:
  data: false                # sync, backfill, packs. Off: no pack loaded, no new records, no attribution
  backend: meilisearch       # meilisearch | shadow | search. The last two need data: true
  languages: [is, en]
  languageDataDir: ''        # required when `is` is enabled; R-02
  sidebarLimit: 1000         # today's value
  rankWindow: 200            # max 200; bounds cursor size (R-06)
  readConcurrency: 2
  maxConcurrentSearches: 4
  queryWordLimit: 10
  searchTimeoutMs: 10000
  syncTakeoverSeconds: 30
  vocabFlushSeconds: 300
  reconcileDays: 30
  sharedReadMaxBytes: 67108864
  statusCacheSeconds: 15
  analysisCacheWords: 100000
  meiliResyncPending: false  # rollback after removal: hide search until the full sync reports complete
  jobs:
    batchSize: 200
    batchDelayMs: 1000
  rank:
    lengthBucket: true       # FR-011
  prefix:
    maxCommonReads: 4
    maxRareTokens: 200
    maxVocabRows: 50000
  typo:
    maxCorrections: 8
    maxVocabRows: 50000
  shadow:
    maxConcurrent: 4
    panelRound: 1            # R-18
    panelUsers: []           # user IDs, set in tenant config, never in this repository
    largestUserId: ''        # set in tenant config; only a boolean reaches logs
```

Validation: `.strict()`; integers with a minimum of 1; `languages` is a plain string array, checked by the service against registered packs ([contracts/language-pack.md](language-pack.md)). A cross-field check on `backend` and `data` logs a configuration error rather than failing startup (FR-019). Each field gets a doc comment, plus an entry in `librechat.example.yaml`, which carries only neutral defaults.

Sources for defaults: [R-16](../research.md#r-16-planning-defaults). The sandbox may change them, and this file is updated in the same change.
