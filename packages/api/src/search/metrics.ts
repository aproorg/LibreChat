import { SEARCH_ERROR_CODES } from 'librechat-data-provider';
import type { SearchErrorCode } from 'librechat-data-provider';

/** Numbers, durations, stable codes, surface names and record IDs only (FR-020). */
const SURFACES = ['messages', 'conversations', 'shares'] as const;
const BACKENDS = ['meilisearch', 'shadow', 'search'] as const;
const TIERS = ['none', 'exact', 'lemma', 'part', 'prefix', 'typo'] as const;
const OUTCOME_STATES = ['ok', 'empty', 'partial', 'aborted'] as const;
const SHADOW_STATES = ['ok', 'dropped', 'failed'] as const;
const SKIP_CODES = ['read_failed', 'analyze_failed', 'write_failed', 'unknown'] as const;
const LEASE_EVENTS = ['acquired', 'renewed', 'lost', 'released'] as const;
const VERIFY_STATUSES = ['pending', 'passed', 'failed'] as const;
const PACK_STATES = ['loading', 'loaded', 'failed'] as const;
const COLLECTIONS = ['messages', 'conversations'] as const;
const BACKFILL_STATUSES = ['running', 'paused', 'finished', 'failed'] as const;
const PAUSE_REASONS = ['operator', 'threshold'] as const;
const PROBE_CHECKS = [
  'temporary',
  'subagent',
  'tool_output',
  'context_meta',
  'other_user',
] as const;

const REALTEXT_FLUSH_MS = 60_000;

export type SearchSurface = (typeof SURFACES)[number];
export type SearchTier = (typeof TIERS)[number];
export type SearchOutcome = (typeof OUTCOME_STATES)[number] | SearchErrorCode;

export interface SearchRequestEvent {
  surface: SearchSurface;
  backend: (typeof BACKENDS)[number];
  detached: boolean;
  ms: number;
  reads?: number;
  rows?: number;
  words?: number;
  tierReached?: SearchTier;
  coldAfterIdle?: boolean;
  isLargestUser?: boolean;
  outcome: SearchOutcome;
}

export interface SearchShadowEvent {
  surface: SearchSurface;
  state: (typeof SHADOW_STATES)[number];
  dropped: boolean;
}

export interface SearchCursorErrorEvent {
  surface: SearchSurface;
  retries: number;
  final: boolean;
}

export interface SearchSyncLagEvent {
  lagMs: number;
  batch: number;
}

export interface SearchSyncStatusEvent {
  savedAgeMs: number;
  hasHolder: boolean;
  isHolder: boolean;
}

export interface SearchSyncGapEvent {
  resumeFailed: boolean;
  restartedAt: number;
}

export interface SearchSyncSkipEvent {
  id: string;
  attempts: number;
  code: (typeof SKIP_CODES)[number];
}

export interface SearchLeaseEvent {
  holder: string;
  epoch: number;
  event: (typeof LEASE_EVENTS)[number];
}

export interface SearchPartialEvent {
  surface: SearchSurface;
  code: SearchErrorCode;
}

export interface SearchReconcileEvent {
  missing: number;
  orphans: number;
  stale: number;
  of: number;
}

export interface SearchVerifyEvent {
  status: (typeof VERIFY_STATUSES)[number];
  mismatchedUsers: number;
  round: number;
}

export interface SearchPackEvent {
  id: string;
  state: (typeof PACK_STATES)[number];
  ms: number;
  rssDelta: number;
}

export interface SearchBackfillEvent {
  collection: (typeof COLLECTIONS)[number];
  rate: number;
  status: (typeof BACKFILL_STATUSES)[number];
  pausedReason?: (typeof PAUSE_REASONS)[number];
}

export interface SearchProbeEvent {
  check: (typeof PROBE_CHECKS)[number];
  leak: boolean;
}

/** Reads one field. Answers `undefined`, dropping the field, for anything the contract forbids. */
type Field<T> = (value: unknown) => T | undefined;

/** One reader per field of an event, so a new field cannot reach a log unchecked. */
type FieldSpec<T> = { [K in keyof Required<T>]: Field<Required<T>[K]> };

const count: Field<number> = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const flag: Field<boolean> = (value) => (typeof value === 'boolean' ? value : undefined);

const oneOf =
  <T extends string>(allowed: readonly T[]): Field<T> =>
  (value) =>
    allowed.includes(value as T) ? (value as T) : undefined;

const matching =
  (pattern: RegExp): Field<string> =>
  (value) =>
    typeof value === 'string' && pattern.test(value) ? value : undefined;

const recordId = matching(/^[0-9a-f]{24}$/i);
/** A generated process ID, never a host name. */
const holderId = matching(/^[0-9a-f-]{8,64}$/i);
/** Registered pack IDs and those a deployment lists are short lowercase names. */
const packId = matching(/^[a-z][a-z0-9_]{0,15}$/);

const REQUEST: FieldSpec<SearchRequestEvent> = {
  surface: oneOf(SURFACES),
  backend: oneOf(BACKENDS),
  detached: flag,
  ms: count,
  reads: count,
  rows: count,
  words: count,
  tierReached: oneOf(TIERS),
  coldAfterIdle: flag,
  isLargestUser: flag,
  outcome: oneOf<SearchOutcome>([...OUTCOME_STATES, ...SEARCH_ERROR_CODES]),
};
const SHADOW: FieldSpec<SearchShadowEvent> = {
  surface: oneOf(SURFACES),
  state: oneOf(SHADOW_STATES),
  dropped: flag,
};
const CURSOR_ERROR: FieldSpec<SearchCursorErrorEvent> = {
  surface: oneOf(SURFACES),
  retries: count,
  final: flag,
};
const SYNC_LAG: FieldSpec<SearchSyncLagEvent> = { lagMs: count, batch: count };
const SYNC_STATUS: FieldSpec<SearchSyncStatusEvent> = {
  savedAgeMs: count,
  hasHolder: flag,
  isHolder: flag,
};
const SYNC_GAP: FieldSpec<SearchSyncGapEvent> = { resumeFailed: flag, restartedAt: count };
const SYNC_SKIP: FieldSpec<SearchSyncSkipEvent> = {
  id: recordId,
  attempts: count,
  code: oneOf(SKIP_CODES),
};
const LEASE: FieldSpec<SearchLeaseEvent> = {
  holder: holderId,
  epoch: count,
  event: oneOf(LEASE_EVENTS),
};
const PARTIAL: FieldSpec<SearchPartialEvent> = {
  surface: oneOf(SURFACES),
  code: oneOf(SEARCH_ERROR_CODES),
};
const RECONCILE: FieldSpec<SearchReconcileEvent> = {
  missing: count,
  orphans: count,
  stale: count,
  of: count,
};
const VERIFY: FieldSpec<SearchVerifyEvent> = {
  status: oneOf(VERIFY_STATUSES),
  mismatchedUsers: count,
  round: count,
};
const PACK: FieldSpec<SearchPackEvent> = {
  id: packId,
  state: oneOf(PACK_STATES),
  ms: count,
  rssDelta: count,
};
const BACKFILL: FieldSpec<SearchBackfillEvent> = {
  collection: oneOf(COLLECTIONS),
  rate: count,
  status: oneOf(BACKFILL_STATUSES),
  pausedReason: oneOf(PAUSE_REASONS),
};
const PROBE: FieldSpec<SearchProbeEvent> = { check: oneOf(PROBE_CHECKS), leak: flag };

function pick<T>(spec: FieldSpec<T>, fields: unknown): Partial<T> {
  const source = (fields ?? {}) as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const [key, read] of Object.entries(spec) as [string, Field<unknown>][]) {
    const value = read(source[key]);
    if (value !== undefined) {
      picked[key] = value;
    }
  }
  return picked as Partial<T>;
}

const average = (total: number, samples: number): number => (samples > 0 ? total / samples : 0);

export interface SearchMetricsLogger {
  info(message: string, meta: object): unknown;
  warn(message: string, meta: object): unknown;
}

/** Accumulates `search.realtext` between flushes. Each method belongs to the task that measures it. */
export interface SearchRealtext {
  addMessage(tokens: number, atCap: boolean): void;
  addTier(tier: SearchTier): void;
  addPrefixFanout(tokens: number): void;
  addVocabRowsTruncated(): void;
  addTypoSkippedWordExists(): void;
  addNoLetterQuery(): void;
  addStopOnlyQuery(): void;
}

export interface SearchMetrics {
  request(fields: SearchRequestEvent): void;
  shadow(fields: SearchShadowEvent): void;
  cursorError(fields: SearchCursorErrorEvent): void;
  syncLag(fields: SearchSyncLagEvent): void;
  syncStatus(fields: SearchSyncStatusEvent): void;
  syncGap(fields: SearchSyncGapEvent): void;
  syncSkip(fields: SearchSyncSkipEvent): void;
  lease(fields: SearchLeaseEvent): void;
  partial(fields: SearchPartialEvent): void;
  reconcile(fields: SearchReconcileEvent): void;
  verify(fields: SearchVerifyEvent): void;
  pack(fields: SearchPackEvent): void;
  backfill(fields: SearchBackfillEvent): void;
  probe(fields: SearchProbeEvent): void;
  realtext: SearchRealtext;
  flushRealtext(): void;
  /** Flushes `search.realtext` each minute. Returns the function that stops it. */
  startRealtextFlush(): () => void;
}

/**
 * Typed emitters for every `search.*` event. Each one rebuilds its log fields
 * from an allowlist, so query text, document content or raw error text passed
 * by mistake is dropped here rather than relying on every caller.
 */
export function createSearchMetrics(logger: SearchMetricsLogger): SearchMetrics {
  const emitter =
    <T>(level: 'info' | 'warn', event: string, spec: FieldSpec<T>) =>
    (fields: T): void => {
      logger[level](event, pick(spec, fields));
    };

  const emptyRealtext = () => ({
    messages: 0,
    tokens: 0,
    atCap: 0,
    tiers: {} as Partial<Record<SearchTier, number>>,
    tierTotal: 0,
    fanoutSamples: 0,
    fanoutTotal: 0,
    vocabRowsTruncated: 0,
    typoSkippedWordExists: 0,
    noLetterQueries: 0,
    stopOnlyQueries: 0,
  });
  let totals = emptyRealtext();
  let touched = false;
  const touch = () => {
    touched = true;
    return totals;
  };

  const readTier = oneOf(TIERS);

  const realtext: SearchRealtext = {
    addMessage(tokens, atCap) {
      const value = count(tokens);
      if (value === undefined) {
        return;
      }
      const state = touch();
      state.messages += 1;
      state.tokens += value;
      state.atCap += atCap === true ? 1 : 0;
    },
    addTier(tier) {
      const value = readTier(tier);
      if (value === undefined) {
        return;
      }
      const state = touch();
      state.tiers[value] = (state.tiers[value] ?? 0) + 1;
      state.tierTotal += 1;
    },
    addPrefixFanout(tokens) {
      const value = count(tokens);
      if (value === undefined) {
        return;
      }
      const state = touch();
      state.fanoutSamples += 1;
      state.fanoutTotal += value;
    },
    addVocabRowsTruncated() {
      touch().vocabRowsTruncated += 1;
    },
    addTypoSkippedWordExists() {
      touch().typoSkippedWordExists += 1;
    },
    addNoLetterQuery() {
      touch().noLetterQueries += 1;
    },
    addStopOnlyQuery() {
      touch().stopOnlyQueries += 1;
    },
  };

  const flushRealtext = (): void => {
    if (!touched) {
      return;
    }
    const state = totals;
    totals = emptyRealtext();
    touched = false;
    const tierShare = Object.fromEntries(
      Object.entries(state.tiers).map(([tier, hits]) => [tier, hits / state.tierTotal]),
    );
    logger.info('search.realtext', {
      tokensPerMessage: average(state.tokens, state.messages),
      atCap: state.atCap,
      tierShare,
      prefixFanout: average(state.fanoutTotal, state.fanoutSamples),
      vocabRowsTruncated: state.vocabRowsTruncated,
      typoSkippedWordExists: state.typoSkippedWordExists,
      noLetterQueries: state.noLetterQueries,
      stopOnlyQueries: state.stopOnlyQueries,
    });
  };

  return {
    request: emitter('info', 'search.request', REQUEST),
    shadow: emitter('info', 'search.shadow', SHADOW),
    cursorError: emitter('warn', 'search.cursor_error', CURSOR_ERROR),
    syncLag: emitter('info', 'search.sync_lag', SYNC_LAG),
    syncStatus: emitter('info', 'search.sync_status', SYNC_STATUS),
    syncGap: emitter('warn', 'search.sync_gap', SYNC_GAP),
    syncSkip: emitter('warn', 'search.sync_skip', SYNC_SKIP),
    lease: emitter('info', 'search.lease', LEASE),
    partial: emitter('warn', 'search.partial', PARTIAL),
    reconcile: emitter('info', 'search.reconcile', RECONCILE),
    verify: emitter('info', 'search.verify', VERIFY),
    pack: emitter('info', 'search.pack', PACK),
    backfill: emitter('info', 'search.backfill', BACKFILL),
    probe: emitter('info', 'search.probe', PROBE),
    realtext,
    flushRealtext,
    startRealtextFlush() {
      const timer = setInterval(flushRealtext, REALTEXT_FLUSH_MS);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
