import type {
  ConversationSearchRecord,
  MessageSearchRecord,
  SearchMethods,
  SearchSourceCollection,
  SearchSourceEvent,
} from '@librechat/data-schemas';
import type { Analyzer } from '../analyzer/analyze';
import type { VocabCounter } from './vocab';
import { buildConversationRecord, buildMessageRecord } from './record';
import { removeRecordsOfGoneSources } from '../jobs/check';
import { SOURCE_COLLECTIONS } from '../jobs/control';

export type ApplyMethods = Pick<
  SearchMethods,
  | 'readSearchRecordStamps'
  | 'replaceSearchRecords'
  | 'deleteSearchRecords'
  | 'readSearchSourcesById'
>;

export type SyncApplyCode = 'read_failed' | 'analyze_failed' | 'write_failed';

/** A batch that could not be applied, by stable code. Holds no driver or analyzer text. */
export class SyncApplyError extends Error {
  readonly code: SyncApplyCode;
  /**
   * The event itself cannot be applied, as when a pack throws on its text or its record fails
   * validation. Otherwise the database failed, and the batch is worth reading again later.
   */
  readonly poison: boolean;

  constructor(code: SyncApplyCode, poison = code === 'analyze_failed') {
    super(code);
    this.name = 'SyncApplyError';
    this.code = code;
    this.poison = poison;
  }
}

/**
 * A document or schema validation failure belongs to the record, not to the database. Mongoose
 * reports a bulk write's failed validation as `MongooseBulkWriteError` with `validationErrors`.
 */
const isValidationFailure = (error: unknown): boolean => {
  const { name, code, validationErrors } = (error ?? {}) as {
    name?: unknown;
    code?: unknown;
    validationErrors?: unknown;
  };
  return (
    name === 'ValidationError' ||
    name === 'MongooseBulkWriteError' ||
    (Array.isArray(validationErrors) && validationErrors.length > 0) ||
    code === 121
  );
};

/** The writer's turn, as one batch sees it. */
export interface ApplyTurn {
  epoch: number;
  /**
   * When this turn began. An event older than this may already have been applied by the
   * holder before, which may still be paused rather than gone, so it raises `e` even on an
   * unchanged `h` (R-09).
   */
  replayBefore: number;
  /** Whether this process may still write, checked just before and after the write. */
  holds(): boolean;
}

export interface ApplyDeps {
  methods: ApplyMethods;
  analyzer: Analyzer;
  version: string;
  turn: ApplyTurn;
  vocab: Pick<VocabCounter, 'add'>;
}

export interface ApplyResult {
  written: number;
  deleted: number;
  /** Writes refused or unneeded: the same `h`, or a newer writer's record. */
  unchanged: number;
  /** The turn ended around the write, so the source check ran. */
  lost: boolean;
}

type Change = Exclude<SearchSourceEvent, { type: 'meili' } | { type: 'gap' }>;

/**
 * Meilisearch's bookkeeping writes drop first, or one could hide the edit it followed. Then
 * each row keeps only its last event, so a batch costs one record read and one bulk write
 * per collection however often a row changed.
 */
export function lastChanges(events: readonly SearchSourceEvent[]): Change[] {
  const last = new Map<string, Change>();
  for (const event of events) {
    if (event.type === 'meili' || event.type === 'gap') {
      continue;
    }
    const key = `${event.collection}:${event.id}`;
    last.delete(key);
    last.set(key, event);
  }
  return [...last.values()];
}

function build(
  collection: SearchSourceCollection,
  change: Extract<Change, { type: 'upsert' }>,
  options: { analyzer: Analyzer; version: string; epoch: number },
): MessageSearchRecord | ConversationSearchRecord | null {
  try {
    return collection === 'messages'
      ? buildMessageRecord(change.source, options)
      : buildConversationRecord(change.source, options);
  } catch (error) {
    /* A row missing `user` or a date can never have a record: the same as a non-indexable one. */
    if (error instanceof TypeError && /^Search source has no usable/.test(error.message)) {
      return null;
    }
    throw new SyncApplyError('analyze_failed');
  }
}

async function step<T>(code: SyncApplyCode, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new SyncApplyError(code, isValidationFailure(error));
  }
}

/**
 * One stream batch, per R-09: guarded upserts and deletes, raising `e` while replaying.
 * Writes only to the record collections. Throws `SyncApplyError` for the writer's retry.
 */
export async function applyChanges(
  changes: readonly Change[],
  { methods, analyzer, version, turn, vocab }: ApplyDeps,
): Promise<ApplyResult> {
  const result: ApplyResult = { written: 0, deleted: 0, unchanged: 0, lost: false };
  for (const collection of SOURCE_COLLECTIONS) {
    const mine = changes.filter((change) => change.collection === collection);
    if (mine.length === 0) {
      continue;
    }
    const records: Array<{ record: MessageSearchRecord | ConversationSearchRecord; at: number }> =
      [];
    const deletes: string[] = [];
    for (const change of mine) {
      const record =
        change.type === 'upsert'
          ? build(collection, change, { analyzer, version, epoch: turn.epoch })
          : null;
      if (record) {
        records.push({ record, at: change.at });
      } else {
        deletes.push(change.id);
      }
    }

    const stamps = new Map(
      (
        await step('read_failed', () =>
          methods.readSearchRecordStamps(
            collection,
            records.map(({ record }) => record._id),
          ),
        )
      ).map((stamp) => [stamp._id, stamp]),
    );
    const writes: Array<MessageSearchRecord | ConversationSearchRecord> = [];
    const counted: Array<readonly string[]> = [];
    for (const { record, at } of records) {
      const stamp = stamps.get(record._id);
      if (stamp && stamp.e > turn.epoch) {
        result.unchanged += 1;
        continue;
      }
      const same = stamp != null && stamp.h === record.h && stamp.v === record.v;
      const replaying = at < turn.replayBefore && stamp != null && stamp.e < turn.epoch;
      if (same && !replaying) {
        result.unchanged += 1;
        continue;
      }
      writes.push(record);
      if (!same) {
        counted.push(record.tokens);
      }
    }

    if (!turn.holds()) {
      result.lost = true;
      return result;
    }
    const replaced = await step('write_failed', () =>
      methods.replaceSearchRecords(collection, writes),
    );
    result.written += replaced.written;
    result.unchanged += replaced.duplicates;
    result.deleted += await step('write_failed', () =>
      methods.deleteSearchRecords(collection, deletes, { atMostEpoch: turn.epoch }),
    );
    counted.forEach((tokens) => vocab.add(tokens));

    if (!turn.holds()) {
      /* A paused writer's upsert can bring back a record its successor deleted (R-09). */
      result.lost = true;
      await step('write_failed', () =>
        removeRecordsOfGoneSources(
          methods,
          collection,
          writes.map(({ _id }) => _id),
        ),
      );
      return result;
    }
  }
  return result;
}

/** The tenant pin (R-04): `mismatch` when a second non-null `tenantId` appears. */
export function checkTenant(
  changes: readonly Change[],
  pinned: string | null,
): { ok: true; pin: string | null } | { ok: false } {
  let pin = pinned;
  for (const change of changes) {
    if (change.type !== 'upsert') {
      continue;
    }
    const tenantId = change.source.tenantId;
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      continue;
    }
    if (pin === null) {
      pin = tenantId;
    } else if (pin !== tenantId) {
      return { ok: false };
    }
  }
  return { ok: true, pin };
}
