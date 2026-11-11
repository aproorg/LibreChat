import { isEnabled } from '~/utils/common';

/** The variables Meilisearch runs on, handed in by the caller rather than read from the process. */
export interface MeiliEnv {
  SEARCH?: string;
  MEILI_HOST?: string;
  MEILI_MASTER_KEY?: string;
  MEILI_SYNC_THRESHOLD?: string;
}

/** What one model's `getSyncProgress` reports, as `api/db/indexSync.js` reads it. */
export interface MeiliSyncProgress {
  totalProcessed: number;
  totalDocuments: number;
  pendingIndexing?: number;
  pendingCleanup?: number;
}

export interface MeiliHealthClient {
  health(): Promise<{ status: string }>;
}

/** What `/api/search/enable` needs of Meilisearch. The server entry points supply it. */
export interface MeiliStatusDeps {
  env: MeiliEnv;
  /** The client class. Built at most once, and only when Meilisearch is configured. */
  MeiliSearch?: new (options: { host: string; apiKey: string }) => MeiliHealthClient;
  /** The app's models. `Message` and `Conversation` carry `getSyncProgress` when the plugin is on. */
  models?: Partial<Record<string, { getSyncProgress?(): Promise<MeiliSyncProgress> }>>;
}

/** The two models Meilisearch indexes. */
export const MEILI_SYNC_MODELS = ['Message', 'Conversation'] as const;

/** Unprocessed documents `indexSync` leaves alone, so the same number counts as caught up. */
export const DEFAULT_MEILI_SYNC_THRESHOLD = 1000;

export const isSearchEnvOn = (env: MeiliEnv): boolean => isEnabled(env.SEARCH);

/**
 * Whether this process can reach a Meilisearch at all. `indexSync` starts only when it can
 * (FR-036): by these variables and not by `search.backend`, because Meilisearch must stay
 * in sync while the new search serves.
 */
export function isMeiliConfigured(env: MeiliEnv): boolean {
  return Boolean(env.MEILI_HOST) && Boolean(env.MEILI_MASTER_KEY);
}

export function meiliSyncThreshold(env: MeiliEnv): number {
  const parsed = env.MEILI_SYNC_THRESHOLD ? parseInt(env.MEILI_SYNC_THRESHOLD, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MEILI_SYNC_THRESHOLD;
}

/**
 * The full sync has caught up on one model. Not `isComplete`: one aborted message or one
 * unacknowledged save leaves that false with nothing left to clear it.
 */
export function isMeiliSyncCaughtUp(progress: MeiliSyncProgress, threshold: number): boolean {
  return (
    (progress.pendingIndexing ?? 0) === 0 &&
    (progress.pendingCleanup ?? 0) === 0 &&
    progress.totalDocuments - progress.totalProcessed <= threshold
  );
}
