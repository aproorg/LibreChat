import type { SearchMethods } from '@librechat/data-schemas';
import type { SearchMetrics } from '../metrics';

export type SearchLeaseMethods = Pick<
  SearchMethods,
  'acquireSearchLease' | 'renewSearchLease' | 'releaseSearchLease'
>;

export interface SearchLease {
  readonly holder: string;
  /** Milliseconds between `tick`s: a third of the takeover time (R-09). */
  readonly heartbeatMs: number;
  /** Takes or renews the lease. Answers whether this process holds it now. */
  tick(): Promise<boolean>;
  /** Local only: a holder past its deadline stops before writing, even if nobody took over. */
  isHeld(): boolean;
  /** The current turn, or `null` between turns. A job holds only the turn it started under. */
  epoch(): number | null;
  /**
   * When this process took the current turn, or `null` between turns. Until the stream passes
   * it, the writer replays events another holder may have applied (R-09).
   */
  acquiredAt(): number | null;
  release(): Promise<void>;
}

export function createSearchLease({
  methods,
  holder,
  takeoverSeconds,
  packsLoaded,
  metrics,
  now = Date.now,
}: {
  methods: SearchLeaseMethods;
  /** A random ID, because this reaches logs and a hostname must not. */
  holder: string;
  takeoverSeconds: number;
  packsLoaded(): boolean;
  metrics: Pick<SearchMetrics, 'lease'>;
  now?: () => number;
}): SearchLease {
  const ttlMs = takeoverSeconds * 1000;
  let epoch: number | null = null;
  let until = 0;
  let takenAt: number | null = null;

  const emit = (event: 'acquired' | 'lost' | 'released', at: number) =>
    metrics.lease({ holder, epoch: at, event });

  async function release(): Promise<void> {
    if (epoch === null) {
      return;
    }
    const released = epoch;
    epoch = null;
    until = 0;
    takenAt = null;
    await methods.releaseSearchLease({ holder, epoch: released });
    emit('released', released);
  }

  async function tick(): Promise<boolean> {
    if (!packsLoaded()) {
      await release();
      return false;
    }
    const next = now() + ttlMs;
    if (epoch !== null) {
      if (await methods.renewSearchLease({ holder, epoch, until: new Date(next) })) {
        until = next;
        return true;
      }
      emit('lost', epoch);
      epoch = null;
      until = 0;
      takenAt = null;
    }
    const taken = await methods.acquireSearchLease({
      holder,
      until: new Date(next),
      now: new Date(now()),
    });
    if (taken === null) {
      return false;
    }
    epoch = taken.epoch;
    until = next;
    takenAt = now();
    emit('acquired', epoch);
    return true;
  }

  return {
    holder,
    heartbeatMs: Math.ceil(ttlMs / 3),
    tick,
    isHeld: () => epoch !== null && now() < until,
    epoch: () => epoch,
    acquiredAt: () => takenAt,
    release,
  };
}
