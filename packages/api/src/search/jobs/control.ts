import type { SearchSourceCollection } from '@librechat/data-schemas';

/** Why a job stopped early. The next run carries on from what the job saved. */
export type JobStop = 'paused' | 'lost';
export type JobOutcome = 'done' | JobStop;

/** What every job checks between batches, so throttle, pause and lease live in one place. */
export interface JobControl {
  readonly batchSize: number;
  /** A reason to stop now, or `null`. */
  check(): Promise<JobStop | null>;
  /** Whether this process may still write. Checked again just before a batch's write. */
  holds(): boolean;
  /** The throttle between batches. */
  wait(): Promise<void>;
}

export const CHAIN_KEY = 'chain';
export const VERIFICATION_KEY = 'verification';
export const VOCAB_KEY = 'vocab';
export const LEASE_KEY = 'lease';

export const SOURCE_COLLECTIONS: readonly SearchSourceCollection[] = ['messages', 'conversations'];

export const BACKFILL_KEYS: Readonly<Record<SearchSourceCollection, string>> = {
  messages: 'backfill:messages',
  conversations: 'backfill:conversations',
};

/** The limit on a state read a job or the script makes. */
export const JOB_STATE_READ = { maxTimeMS: 30_000 };

/** The lowest possible ObjectId of a moment: IDs from before it sort below this. */
export const objectIdFloor = (ms: number): string =>
  `${Math.floor(ms / 1000)
    .toString(16)
    .padStart(8, '0')}${'0'.repeat(16)}`;

export const giveWay = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
