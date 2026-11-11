import type { SearchMethods } from '@librechat/data-schemas';
import type { SearchConfigSnapshot } from '../config';
import { JOB_STATE_READ, OBSERVED_KEY, STREAM_KEY, VERIFICATION_KEY } from '../jobs/control';

export type ObservedMethods = Pick<SearchMethods, 'readSearchState' | 'writeSearchState'>;

type Observed = Pick<SearchConfigSnapshot, 'backend' | 'data'>;

/**
 * R-11's readiness rule, run by each process in the background after it listens. Config
 * changes only by restart, so comparing this process's `{ backend, data }` with the last one
 * stored is how an abort or a stopped sync reaches readiness (FR-037).
 *
 * A tenant that never turned search data on has no `search_state`, so the read finds nothing
 * and nothing is written: no collection appears. With state present, moving from `search` to
 * `meilisearch`, or `data` going off, sets `invalidatedAt`, so an old pass cannot serve again
 * until reconcile and a later verification. `data` coming back on discards the
 * saved stream position, because the writes made while it was off are not in the stream any
 * more, and the writer then treats it as a gap and queues reconcile.
 */
export async function checkObserved({
  methods,
  config,
  now = Date.now,
}: {
  methods: ObservedMethods;
  config: Observed;
  now?: () => number;
}): Promise<void> {
  const previous = await methods.readSearchState(OBSERVED_KEY, JOB_STATE_READ);
  if (!previous) {
    return;
  }
  const at = new Date(now());
  /* Anything but `meilisearch`, so a value an older release stored still invalidates. */
  const wasServing = typeof previous.backend === 'string' && previous.backend !== 'meilisearch';
  const dataWentOff = previous.data === true && !config.data;
  if ((wasServing && config.backend === 'meilisearch') || dataWentOff) {
    await methods.writeSearchState(VERIFICATION_KEY, { invalidatedAt: at });
  }
  if (previous.data === false && config.data) {
    await methods.writeSearchState(STREAM_KEY, { resumeToken: null });
  }
  if (!config.data) {
    /* Only where the key already exists, so data off never creates anything. */
    await methods.writeSearchState(OBSERVED_KEY, {
      backend: config.backend,
      data: false,
      observedAt: at,
    });
  }
}

/** With search data on, after the collections exist, so this write creates nothing implicitly. */
export async function recordObserved({
  methods,
  config,
  now = Date.now,
}: {
  methods: ObservedMethods;
  config: Observed;
  now?: () => number;
}): Promise<void> {
  await methods.writeSearchState(OBSERVED_KEY, {
    backend: config.backend,
    data: config.data,
    observedAt: new Date(now()),
  });
}
