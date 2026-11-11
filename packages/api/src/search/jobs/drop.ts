import { runAsSystem } from '@librechat/data-schemas';
import type { SearchMethods } from '@librechat/data-schemas';
import type { SearchConfigSnapshot } from '../config';
import { JOB_STATE_READ, LEASE_KEY, STREAM_KEY } from './control';

export type DropSearchMethods = Pick<SearchMethods, 'readSearchState' | 'dropSearchCollections'>;

/** Why nothing was dropped. Each has its own line in `config/search-job.js`. */
export type DropRefusalCode = 'search_data_on' | 'search_lease_held' | 'search_sync_recent';

export type DropSearchResult =
  | { ok: true; value: { dropped: string[] } }
  | { ok: false; error: { code: DropRefusalCode } };

/**
 * Removes the four search collections and nothing else, for a tenant that has left the new
 * search for good. It runs in the operator script itself, because with search data off no
 * process holds the lease to run a job.
 *
 * It refuses while search data is on: by this configuration, and by a live lease, which
 * means some process still runs with the old configuration and would write the collections
 * back. A lease runs out `syncTakeoverSeconds` after its holder stops.
 *
 * A lease its holder gave up at shutdown looks run out at once, while another process with
 * search data on may be about to take it. So it also refuses while a sync writer saved its
 * position within the takeover time: a writer saves every few seconds, even when idle.
 */
export function dropSearchData({
  methods,
  config,
  now = Date.now,
}: {
  methods: DropSearchMethods;
  config: Pick<SearchConfigSnapshot, 'data' | 'syncTakeoverSeconds'>;
  now?: () => number;
}): Promise<DropSearchResult> {
  return runAsSystem(async (): Promise<DropSearchResult> => {
    if (config.data) {
      return { ok: false, error: { code: 'search_data_on' } };
    }
    const lease = await methods.readSearchState(LEASE_KEY, JOB_STATE_READ);
    const leaseUntil = lease?.leaseUntil instanceof Date ? lease.leaseUntil.getTime() : 0;
    if (leaseUntil > now()) {
      return { ok: false, error: { code: 'search_lease_held' } };
    }
    const stream = await methods.readSearchState(STREAM_KEY, JOB_STATE_READ);
    const savedAt = stream?.savedAt instanceof Date ? stream.savedAt.getTime() : 0;
    if (now() - savedAt < config.syncTakeoverSeconds * 1000) {
      return { ok: false, error: { code: 'search_sync_recent' } };
    }
    return { ok: true, value: { dropped: await methods.dropSearchCollections() } };
  });
}
