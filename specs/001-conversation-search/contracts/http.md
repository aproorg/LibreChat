# HTTP Contract

Default configuration (`search.data: false`, `search.backend: meilisearch`): every response stays exactly as today. Each section states when it applies. Flows per surface are in [R-03](../research.md#r-03-seams-into-existing-code).

## GET /api/messages?search=…

Applies when `backend: search`. On `meilisearch`, a cursor with the `s1.` prefix returns `search_cursor_invalid`, because that cursor came from before a rollback. Today's client never sends any other cursor here.

| Field | Type | Notes |
|---|---|---|
| `messages` | array | Same fields the client renders today; private fields stripped; ranked order kept |
| `nextCursor` | string or null | Non-null whenever more matches may exist, even when `messages` is short or empty after filtering. One exception: a plan too large for the cursor's fixed slot (R-06) yields `null`, so that search has no load-more |
| `reason` | `only_stop_words`, optional | With `messages: []` |

**Request**: `cursor` is opaque and encrypted ([R-06](../research.md#r-06-paging-model)). `pageSize` is ignored: the page is 25 (FR-013). `user` comes from the session only. Every other parameter behaves as today.

## GET /api/convos?search=…

Applies when `backend: search`, including Archived Chats, which uses this route. Adds to today's response: `partial: true` when message search failed and only title matches are shown; `reason: only_stop_words` with an empty list. Paging, sort and every other filter stay the same.

## GET /api/share?search=…

Applies when `backend: search`. Adds `reason: only_stop_words`. Existing paging and filtering of the links shown stay.

## GET /api/search/enable

Bare boolean, as today, with the status read cached ([R-15](../research.md#r-15-client-data-needs)).

| Backend | True when |
|---|---|
| `SEARCH` off | Never |
| `meilisearch` | `MEILI_HOST` and `MEILI_MASTER_KEY` both set, Meilisearch healthy, and `search.meiliResyncPending` is unset or, per model, nothing is pending indexing or cleanup and unprocessed documents are within `MEILI_SYNC_THRESHOLD` |
| `search` | `search.data` on, no pack failed to load in this process, and `verification.status` is `passed` with `passedAt` later than `invalidatedAt` |

One change from before this feature: with `MEILI_HOST` set and no `MEILI_MASTER_KEY`, the answer was true when Meilisearch was healthy, and is now false. Search could not work in that state, because indexing needs both, so this hides a search box that returned nothing.

Misconfiguration (`backend: search` with `data` off): `search` reports false and logs a configuration error. A pack that failed to load makes `search` report false in that process, and alarms. While packs are still loading it reports true, because the client asks once per app load and keeps the answer; a search in those seconds answers `search_busy`.

## GET /api/search/meta (new)

Called by the About tab in Settings for the attribution. JWT required. Applies whenever `search.data` is on, on either backend, and until FR-043's re-analysis finishes.

```json
{
  "attribution": { "text": "…verbatim…", "url": "https://bin.arnastofnun.is" }
}
```

`attribution` is present per FR-043, and it is the only field. With the default configuration it returns `{}`.

## Errors

Apply when `backend: search`, except the cursor rule above. Clients do not retry `search_busy` or `search_cursor_invalid`.

| Code | HTTP | When | Surface |
|---|---|---|---|
| `search_busy` | 503 | Cursor limit after two retries, per-process cap, timeout, or this process's packs still loading | `/search`; sidebar and shared links when the title read fails |
| `search_failed` | 500 | Any other read failure, this process's pack failed to load, or `data` off | `/search`; sidebar and shared links when the title read fails |
| `search_cursor_invalid` | 400 | Malformed, forged, stale or wrong-query cursor | `/search`; client offers a restart |

Body: `{ "code": "<code>" }`, no message text (FR-018, FR-020). Clients map codes to localized copy, with a fallback.

Sidebar with message read failed and title read fine: 200 with `partial: true`, plus an alarm. Sidebar with title read failed: the code above, message hits discarded.

Shared links no longer return an empty 200 on failure on this backend, so an outage never reads as no results.

## Types

Add to `packages/data-provider`: `SearchErrorCode`, `SearchReason`, response additions, `SearchMeta`, endpoints in `api-endpoints.ts`, services in `data-service.ts`, keys in `keys.ts`.
