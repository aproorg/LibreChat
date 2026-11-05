import type { AnyBulkWriteOperation } from 'mongoose';
import type {
  ConversationSearchRecord,
  MessageSearchRecord,
  SearchStateEntry,
} from '~/types/search';
import { buildRetentionVisibilityFilter } from '~/utils/retention';
import { buildIndexableQuery } from '~/models/plugins/mongoMeili';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { createIndexesWithRetry } from '~/utils/retry';
import { runAsSystem } from '~/config/tenantContext';
import { SearchError } from '~/utils/searchError';
import { CLIENT_MESSAGE_SELECT } from './message';

const MESSAGE_RECORD_INDEX = 'user_tokens_created';
const CONVERSATION_RECORD_INDEX = { user: 1, tokens: 1 };
const RECORD_TOKENS_CHUNK = 50;
/** Window rows carry no `tokens`: one can reach 45 KB, and a `singleBatch` read holds 16 MB. */
const WINDOW_FIELDS = 'messageId conversationId createdAt n';
const MESSAGE_TEXT_FIELDS =
  'messageId text content.type content.text content.think content.steer -_id';
const HIT_CONVERSATION_FIELDS = 'conversationId title model -_id';
/**
 * The one projection every job source read shares. `subagentTask` is `select: false`, so
 * naming it is what lets `isIndexableSource` see it; left out, a subagent row looks indexable.
 */
const SOURCE_STATE_FIELDS: Record<SearchSourceCollection, string> = {
  messages:
    'user conversationId messageId createdAt updatedAt isTemporary expiredAt unfinished subagentTask tenantId',
  conversations:
    'user conversationId createdAt updatedAt isTemporary expiredAt unfinished subagentThread tenantId',
};
const SOURCE_TEXT_FIELDS: Record<SearchSourceCollection, string> = {
  messages: 'text content.type content.text content.think content.steer',
  conversations: 'title tags',
};
const SOURCE_MODELS = { messages: 'Message', conversations: 'Conversation' } as const;
const RECORD_MODELS = { messages: 'MessageSearch', conversations: 'ConversationSearch' } as const;
const SEARCH_STATE_COLLECTION = 'search_state';
const LEASE_KEY = 'lease';
const JOB_REQUEST_PREFIX = 'jobRequest:';
const DUPLICATE_KEY = 11000;
/** Bounds one job read, so a stuck batch fails and retries rather than holding a slot forever. */
const JOB_READ_MAX_TIME_MS = 60_000;

/** How one search read runs. No read holds a cursor open or outlives its search. */
export interface SearchReadOptions {
  maxTimeMS: number;
  signal?: AbortSignal;
}

export interface SearchVocabFrequency {
  token: string;
  df: number;
}

export interface SearchWindowParams {
  user: string;
  /** One token reads in index order. Several share one `$in` read. */
  tokens: readonly string[];
  /** Other words' tokens, each set matched at least once. */
  allOf?: ReadonlyArray<readonly string[]>;
  limit: number;
}

export interface SearchWindowRow {
  _id: string;
  messageId: string;
  conversationId: string;
  createdAt: Date;
  n: number;
}

export interface SearchRecordTokens {
  _id: string;
  tokens: string[];
}

export interface SearchMessageText {
  messageId: string;
  text?: string;
  content?: unknown[];
}

/** A message as the client may see it: `CLIENT_MESSAGE_SELECT` already removed private fields. */
export interface SearchableMessage {
  messageId: string;
  conversationId: string;
  isCreatedByUser?: boolean;
  endpoint?: string;
  iconURL?: string;
  [field: string]: unknown;
}

export interface SearchHitConversation {
  conversationId: string;
  title?: string;
  model?: string;
}

export type SearchSourceCollection = 'messages' | 'conversations';

/** A stored source row with its `_id` as a string. Holds text only when asked for. */
export type SearchSourceRow = Record<string, unknown> & { _id: string };

export interface SearchSourceBatchParams {
  collection: SearchSourceCollection;
  /** Exclusive. Rows come in `_id` order. */
  afterId?: string;
  /** Inclusive. */
  upToId?: string;
  limit: number;
  /** Also read the fields a record's tokens come from. */
  withText?: boolean;
}

export interface SearchRecordBatchParams {
  collection: SearchSourceCollection;
  afterId?: string;
  upToId?: string;
  limit: number;
}

export interface SearchRecordWriteResult {
  written: number;
  /** Writes refused because a record exists: a newer writer's stays. */
  duplicates: number;
}

export interface SearchLeaseClaim {
  holder: string;
  until: Date;
}

export interface SearchVocabBatchRow {
  token: string;
  df: number;
  dfNext?: number;
  r?: number;
}

export interface SearchMethods {
  /** Creates the four search collections. Safe to repeat. */
  ensureSearchCollections(): Promise<void>;
  /** Builds the record indexes. Safe to repeat. Backfill calls it after its load. */
  ensureSearchIndexes(): Promise<void>;
  /** A token absent from the answer is absent from the word list, and still worth reading. */
  readVocabFrequencies(
    tokens: readonly string[],
    options: SearchReadOptions,
  ): Promise<SearchVocabFrequency[]>;
  /** Word list rows from `start` up to `end`, in token order, at most `limit`. */
  readVocabRange(
    range: { start: string; end: string; limit: number },
    options: SearchReadOptions,
  ): Promise<SearchVocabFrequency[]>;
  /** The newest of one user's records holding these tokens. */
  readRecordWindow(
    params: SearchWindowParams,
    options: SearchReadOptions,
  ): Promise<SearchWindowRow[]>;
  /** Tokens of chosen records, in chunks, for ranking. */
  readRecordTokens(
    params: { user: string; ids: readonly string[] },
    options: SearchReadOptions,
  ): Promise<SearchRecordTokens[]>;
  /** One user's conversations matching every word set. */
  readConversationRecords(
    params: { user: string; allOf: ReadonlyArray<readonly string[]>; limit: number },
    options: SearchReadOptions,
  ): Promise<Array<{ conversationId: string }>>;
  /** Canonical text fields of one user's messages, for proximity. */
  readMessageTexts(
    params: { user: string; messageIds: readonly string[] },
    options: SearchReadOptions,
  ): Promise<SearchMessageText[]>;
  /**
   * The messages still belonging in search, so a stale record for a temporary,
   * subagent, unfinished or expired message never reaches the client.
   */
  getSearchableMessages(
    user: string,
    messageIds: readonly string[],
    options: SearchReadOptions,
  ): Promise<SearchableMessage[]>;
  /** The visible, human conversations among these IDs. */
  getSearchHitConversations(
    user: string,
    conversationIds: readonly string[],
    options: SearchReadOptions,
  ): Promise<SearchHitConversation[]>;
  /** One key of `search_state`, or `null` when it was never written. */
  readSearchState(key: string, options: SearchReadOptions): Promise<SearchStateEntry | null>;
  /** Merges fields into one key of `search_state`, creating it when absent. */
  writeSearchState(key: string, fields: Record<string, unknown>): Promise<void>;
  deleteSearchState(key: string): Promise<void>;
  /** Whether search data was ever turned on here. A script write must not create the collection. */
  searchStateExists(): Promise<boolean>;
  /** Waiting `jobRequest:<id>` keys, oldest first. */
  listSearchJobRequests(): Promise<SearchStateEntry[]>;
  /** Takes the lease if it is free or expired, raising its epoch. `null` means another holds it. */
  acquireSearchLease(claim: SearchLeaseClaim & { now: Date }): Promise<{ epoch: number } | null>;
  /** `false` means this holder lost its turn. */
  renewSearchLease(claim: SearchLeaseClaim & { epoch: number }): Promise<boolean>;
  releaseSearchLease(claim: { holder: string; epoch: number }): Promise<void>;
  /** One page of source rows by `_id`, across tenants. Ends only on an empty page. */
  readSearchSources(params: SearchSourceBatchParams): Promise<SearchSourceRow[]>;
  /** The current state of chosen source rows, without text. An absent row is a deleted one. */
  readSearchSourcesById(
    collection: SearchSourceCollection,
    ids: readonly string[],
  ): Promise<SearchSourceRow[]>;
  /** Records in a range that an analyzer other than this one wrote. */
  countSearchRecordsAtOtherVersion(
    params: Omit<SearchRecordBatchParams, 'limit'> & { version: string },
  ): Promise<number>;
  /** A cheap estimate for progress reports, never a verification figure. */
  countSearchSources(collection: SearchSourceCollection): Promise<number>;
  /** Distinct non-null source `tenantId` values, for the operator's check before a backfill. */
  readSearchSourceTenants(): Promise<string[]>;
  /** Unordered and insert-only, so a record already there wins. */
  insertSearchRecords(
    collection: SearchSourceCollection,
    records: ReadonlyArray<MessageSearchRecord | ConversationSearchRecord>,
  ): Promise<SearchRecordWriteResult>;
  /** Whole-document upserts guarded by writer epoch. A duplicate means a newer writer owns it. */
  replaceSearchRecords(
    collection: SearchSourceCollection,
    records: ReadonlyArray<MessageSearchRecord | ConversationSearchRecord>,
  ): Promise<SearchRecordWriteResult>;
  deleteSearchRecords(collection: SearchSourceCollection, ids: readonly string[]): Promise<number>;
  /** Record IDs in a range, in `_id` order. */
  readSearchRecordIds(params: SearchRecordBatchParams): Promise<string[]>;
  /** Which of these IDs have a record. */
  readSearchRecordIdsIn(
    collection: SearchSourceCollection,
    ids: readonly string[],
  ): Promise<string[]>;
  /** One page of records' tokens by `_id`, for the word list rebuild. */
  readSearchRecordTokenBatch(
    params: Omit<SearchRecordBatchParams, 'upToId'>,
  ): Promise<SearchRecordTokens[]>;
  /** Adds to `dfNext` and stamps the run, leaving `df` serving until the copy pass. */
  incrementSearchVocabNext(params: {
    counts: ReadonlyArray<readonly [string, number]>;
    run: number;
  }): Promise<void>;
  /** One page of the word list by token, for the rebuild's copy pass. */
  readSearchVocabBatch(params: { afterId?: string; limit: number }): Promise<SearchVocabBatchRow[]>;
  /** Moves `dfNext` to `df` on some rows and deletes others. */
  settleSearchVocab(params: {
    copy: ReadonlyArray<{ token: string; df: number }>;
    remove: readonly string[];
  }): Promise<void>;
}

/** A read without a real user is a violated invariant, and must never reach the database. */
function assertUser(user: unknown): void {
  if (typeof user !== 'string' || user.length === 0) {
    throw new SearchError('search_failed');
  }
}

const tokenSets = (allOf: ReadonlyArray<readonly string[]>) =>
  allOf.map((tokens) => ({ tokens: { $in: [...tokens] } }));

/**
 * A `singleBatch` read of whole messages stops at 16 MB and says nothing, so what it
 * left out reads again. A round that adds nothing means the rest is really absent.
 */
async function readEveryMessage<T extends { messageId: string }>(
  messageIds: readonly string[],
  read: (ids: string[]) => Promise<T[]>,
): Promise<T[]> {
  const found: T[] = [];
  let missing = [...new Set(messageIds)];
  while (missing.length > 0) {
    const rows = await read(missing);
    if (rows.length === 0) {
      break;
    }
    found.push(...rows);
    const returned = new Set(rows.map(({ messageId }) => messageId));
    missing = missing.filter((id) => !returned.has(id));
  }
  return found;
}

const idRange = (afterId?: string, upToId?: string) =>
  afterId == null && upToId == null
    ? {}
    : {
        _id: {
          ...(afterId != null ? { $gt: afterId } : {}),
          ...(upToId != null ? { $lte: upToId } : {}),
        },
      };

/** Counts duplicate-key refusals in an unordered bulk, and rethrows anything else. */
function countDuplicates(error: unknown): number {
  const { code, writeErrors } = error as { code?: number; writeErrors?: unknown };
  const errors = (writeErrors == null ? [] : [writeErrors].flat()) as Array<{ code?: number }>;
  if (errors.length > 0 && errors.every((entry) => entry.code === DUPLICATE_KEY)) {
    return errors.length;
  }
  if (errors.length === 0 && code === DUPLICATE_KEY) {
    return 1;
  }
  throw error;
}

export function createSearchMethods(mongoose: typeof import('mongoose')): SearchMethods {
  const singleBatch = (limit: number, options: SearchReadOptions) => ({
    singleBatch: true,
    batchSize: limit,
    limit,
    maxTimeMS: options.maxTimeMS,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  async function ensureSearchCollections(): Promise<void> {
    const { MessageSearch, ConversationSearch, SearchVocab, SearchState } = mongoose.models;
    for (const model of [MessageSearch, ConversationSearch, SearchVocab, SearchState]) {
      await model.createCollection();
    }
  }

  async function ensureSearchIndexes(): Promise<void> {
    const { MessageSearch, ConversationSearch } = mongoose.models;
    await createIndexesWithRetry(MessageSearch);
    await createIndexesWithRetry(ConversationSearch);
  }

  async function readVocabFrequencies(
    tokens: readonly string[],
    options: SearchReadOptions,
  ): Promise<SearchVocabFrequency[]> {
    if (tokens.length === 0) {
      return [];
    }
    const rows = await mongoose.models.SearchVocab.find({ _id: { $in: [...tokens] } }, 'df', {
      ...singleBatch(tokens.length, options),
    }).lean<Array<{ _id: string; df: number }>>();
    return rows.map(({ _id, df }) => ({ token: _id, df }));
  }

  async function readVocabRange(
    { start, end, limit }: { start: string; end: string; limit: number },
    options: SearchReadOptions,
  ): Promise<SearchVocabFrequency[]> {
    const rows = await mongoose.models.SearchVocab.find(
      { _id: { $gte: start, $lt: end } },
      'df',
      singleBatch(limit, options),
    )
      .sort({ _id: 1 })
      .lean<Array<{ _id: string; df: number }>>();
    return rows.map(({ _id, df }) => ({ token: _id, df }));
  }

  async function readRecordWindow(
    { user, tokens, allOf, limit }: SearchWindowParams,
    options: SearchReadOptions,
  ): Promise<SearchWindowRow[]> {
    assertUser(user);
    if (tokens.length === 0) {
      return [];
    }
    const rows = await mongoose.models.MessageSearch.find(
      {
        user,
        tokens: tokens.length === 1 ? tokens[0] : { $in: [...tokens] },
        ...(allOf?.length ? { $and: tokenSets(allOf) } : {}),
      },
      WINDOW_FIELDS,
      { ...singleBatch(limit, options), hint: MESSAGE_RECORD_INDEX },
    )
      .sort({ createdAt: -1 })
      .lean<Array<Omit<SearchWindowRow, '_id'> & { _id: unknown }>>();
    return rows.map((row) => ({ ...row, _id: String(row._id) }));
  }

  async function readRecordTokens(
    { user, ids }: { user: string; ids: readonly string[] },
    options: SearchReadOptions,
  ): Promise<SearchRecordTokens[]> {
    assertUser(user);
    const found: SearchRecordTokens[] = [];
    for (let start = 0; start < ids.length; start += RECORD_TOKENS_CHUNK) {
      const chunk = ids.slice(start, start + RECORD_TOKENS_CHUNK);
      const rows = await mongoose.models.MessageSearch.find(
        { user, _id: { $in: chunk } },
        'tokens',
        singleBatch(chunk.length, options),
      ).lean<Array<{ _id: unknown; tokens: string[] }>>();
      for (const { _id, tokens } of rows) {
        found.push({ _id: String(_id), tokens });
      }
    }
    return found;
  }

  async function readConversationRecords(
    {
      user,
      allOf,
      limit,
    }: { user: string; allOf: ReadonlyArray<readonly string[]>; limit: number },
    options: SearchReadOptions,
  ): Promise<Array<{ conversationId: string }>> {
    assertUser(user);
    if (allOf.length === 0) {
      return [];
    }
    return mongoose.models.ConversationSearch.find(
      { user, $and: tokenSets(allOf) },
      'conversationId -_id',
      { ...singleBatch(limit, options), hint: CONVERSATION_RECORD_INDEX },
    ).lean<Array<{ conversationId: string }>>();
  }

  async function readMessageTexts(
    { user, messageIds }: { user: string; messageIds: readonly string[] },
    options: SearchReadOptions,
  ): Promise<SearchMessageText[]> {
    assertUser(user);
    return readEveryMessage(messageIds, (ids) =>
      mongoose.models.Message.find(
        { user, messageId: { $in: ids } },
        MESSAGE_TEXT_FIELDS,
        singleBatch(ids.length, options),
      ).lean<SearchMessageText[]>(),
    );
  }

  async function getSearchableMessages(
    user: string,
    messageIds: readonly string[],
    options: SearchReadOptions,
  ): Promise<SearchableMessage[]> {
    assertUser(user);
    const { Message } = mongoose.models;
    return readEveryMessage(messageIds, (ids) =>
      Message.find(
        {
          $and: [
            { user, messageId: { $in: ids } },
            buildIndexableQuery(Message.schema, 'subagentTask'),
            { unfinished: { $ne: true } },
          ],
        },
        CLIENT_MESSAGE_SELECT,
        singleBatch(ids.length, options),
      ).lean<SearchableMessage[]>(),
    );
  }

  async function getSearchHitConversations(
    user: string,
    conversationIds: readonly string[],
    options: SearchReadOptions,
  ): Promise<SearchHitConversation[]> {
    assertUser(user);
    if (conversationIds.length === 0) {
      return [];
    }
    return mongoose.models.Conversation.find(
      {
        $and: [
          { user, conversationId: { $in: [...conversationIds] } },
          buildRetentionVisibilityFilter(),
          { subagentThread: { $exists: false } },
        ],
      },
      HIT_CONVERSATION_FIELDS,
      singleBatch(conversationIds.length, options),
    ).lean<SearchHitConversation[]>();
  }

  async function readSearchState(
    key: string,
    options: SearchReadOptions,
  ): Promise<SearchStateEntry | null> {
    return mongoose.models.SearchState.findById(key, null, {
      maxTimeMS: options.maxTimeMS,
      ...(options.signal ? { signal: options.signal } : {}),
    }).lean<SearchStateEntry | null>();
  }

  const stateModel = () => mongoose.models.SearchState;

  async function writeSearchState(key: string, fields: Record<string, unknown>): Promise<void> {
    await stateModel().updateOne({ _id: key }, { $set: fields }, { upsert: true });
  }

  async function deleteSearchState(key: string): Promise<void> {
    await stateModel().deleteOne({ _id: key });
  }

  async function searchStateExists(): Promise<boolean> {
    const found = await stateModel()
      .db.db!.listCollections({ name: SEARCH_STATE_COLLECTION })
      .toArray();
    return found.length > 0;
  }

  async function listSearchJobRequests(): Promise<SearchStateEntry[]> {
    const end = `${JOB_REQUEST_PREFIX.slice(0, -1)};`;
    return stateModel()
      .find({ _id: { $gte: JOB_REQUEST_PREFIX, $lt: end } }, null, {
        maxTimeMS: JOB_READ_MAX_TIME_MS,
      })
      .sort({ requestedAt: 1 })
      .lean<SearchStateEntry[]>();
  }

  async function acquireSearchLease({
    holder,
    until,
    now,
  }: SearchLeaseClaim & { now: Date }): Promise<{ epoch: number } | null> {
    try {
      const lease = await stateModel()
        .findOneAndUpdate(
          { _id: LEASE_KEY, leaseUntil: { $lte: now } },
          { $set: { holder, leaseUntil: until }, $inc: { epoch: 1 } },
          { upsert: true, new: true },
        )
        .lean<{ epoch: number }>();
      return lease ? { epoch: lease.epoch } : null;
    } catch (error) {
      /* The filter missed a live lease, so the upsert tried to insert a second one. */
      if ((error as { code?: number }).code === DUPLICATE_KEY) {
        return null;
      }
      throw error;
    }
  }

  async function renewSearchLease({
    holder,
    epoch,
    until,
  }: SearchLeaseClaim & { epoch: number }): Promise<boolean> {
    const { matchedCount } = await stateModel().updateOne(
      { _id: LEASE_KEY, holder, epoch },
      { $set: { leaseUntil: until } },
    );
    return matchedCount === 1;
  }

  /* Expires rather than deletes, so the epoch never goes back. */
  async function releaseSearchLease({
    holder,
    epoch,
  }: {
    holder: string;
    epoch: number;
  }): Promise<void> {
    await stateModel().updateOne(
      { _id: LEASE_KEY, holder, epoch },
      { $set: { leaseUntil: new Date(0) } },
    );
  }

  const sourceRows = (rows: Array<Record<string, unknown>>): SearchSourceRow[] =>
    rows.map((row) => ({ ...row, _id: String(row._id) }));

  const jobRead = (limit: number) => singleBatch(limit, { maxTimeMS: JOB_READ_MAX_TIME_MS });

  function readSearchSources({
    collection: kind,
    afterId,
    upToId,
    limit,
    withText = false,
  }: SearchSourceBatchParams): Promise<SearchSourceRow[]> {
    const fields = withText
      ? `${SOURCE_STATE_FIELDS[kind]} ${SOURCE_TEXT_FIELDS[kind]}`
      : SOURCE_STATE_FIELDS[kind];
    return runAsSystem(async () =>
      sourceRows(
        await mongoose.models[SOURCE_MODELS[kind]]
          .find(idRange(afterId, upToId), fields, jobRead(limit))
          .sort({ _id: 1 })
          .lean<Array<Record<string, unknown>>>(),
      ),
    );
  }

  function readSearchSourcesById(
    kind: SearchSourceCollection,
    ids: readonly string[],
  ): Promise<SearchSourceRow[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return runAsSystem(async () =>
      sourceRows(
        await mongoose.models[SOURCE_MODELS[kind]]
          .find({ _id: { $in: [...ids] } }, SOURCE_STATE_FIELDS[kind], jobRead(ids.length))
          .lean<Array<Record<string, unknown>>>(),
      ),
    );
  }

  function countSearchSources(kind: SearchSourceCollection): Promise<number> {
    /* Across every tenant on purpose: one tenant per database, and only a progress figure (R-04). */
    return runAsSystem(async () =>
      // eslint-disable-next-line no-restricted-syntax
      mongoose.models[SOURCE_MODELS[kind]].estimatedDocumentCount(),
    );
  }

  function readSearchSourceTenants(): Promise<string[]> {
    return runAsSystem(async () => {
      const found = await Promise.all(
        Object.values(SOURCE_MODELS).map((name) =>
          mongoose.models[name].distinct('tenantId').maxTimeMS(JOB_READ_MAX_TIME_MS).exec(),
        ),
      );
      return [...new Set(found.flat())].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      );
    });
  }

  /* `insertOne` and `replaceOne` carry the source's `tenantId` through; a `$set` would lose it. */
  async function bulkWriteRecords(
    kind: SearchSourceCollection,
    ops: AnyBulkWriteOperation[],
  ): Promise<SearchRecordWriteResult> {
    if (ops.length === 0) {
      return { written: 0, duplicates: 0 };
    }
    return runAsSystem(async () => {
      try {
        await tenantSafeBulkWrite(mongoose.models[RECORD_MODELS[kind]], ops, {
          ordered: false,
          throwOnValidationError: true,
        });
        return { written: ops.length, duplicates: 0 };
      } catch (error) {
        const duplicates = countDuplicates(error);
        return { written: ops.length - duplicates, duplicates };
      }
    });
  }

  const insertSearchRecords: SearchMethods['insertSearchRecords'] = (kind, records) =>
    bulkWriteRecords(
      kind,
      /* The record's string `_id` casts to the schema's ObjectId inside `bulkWrite`. */
      records.map((document) => ({
        insertOne: { document },
      })) as unknown as AnyBulkWriteOperation[],
    );

  const replaceSearchRecords: SearchMethods['replaceSearchRecords'] = (kind, records) =>
    bulkWriteRecords(
      kind,
      records.map((replacement) => ({
        replaceOne: {
          filter: { _id: replacement._id, e: { $lte: replacement.e } },
          replacement,
          upsert: true,
        },
      })) as AnyBulkWriteOperation[],
    );

  function deleteSearchRecords(
    kind: SearchSourceCollection,
    ids: readonly string[],
  ): Promise<number> {
    if (ids.length === 0) {
      return Promise.resolve(0);
    }
    return runAsSystem(async () => {
      const { deletedCount } = await mongoose.models[RECORD_MODELS[kind]].deleteMany({
        _id: { $in: [...ids] },
      });
      return deletedCount;
    });
  }

  function readSearchRecordIds({
    collection: kind,
    afterId,
    upToId,
    limit,
  }: SearchRecordBatchParams): Promise<string[]> {
    return runAsSystem(async () => {
      const rows = await mongoose.models[RECORD_MODELS[kind]]
        .find(idRange(afterId, upToId), '_id', jobRead(limit))
        .sort({ _id: 1 })
        .lean<Array<{ _id: unknown }>>();
      return rows.map(({ _id }) => String(_id));
    });
  }

  function countSearchRecordsAtOtherVersion({
    collection: kind,
    afterId,
    upToId,
    version,
  }: Omit<SearchRecordBatchParams, 'limit'> & { version: string }): Promise<number> {
    return runAsSystem(async () =>
      mongoose.models[RECORD_MODELS[kind]]
        .countDocuments({ ...idRange(afterId, upToId), v: { $ne: version } })
        .maxTimeMS(JOB_READ_MAX_TIME_MS)
        .exec(),
    );
  }

  function readSearchRecordIdsIn(
    kind: SearchSourceCollection,
    ids: readonly string[],
  ): Promise<string[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return runAsSystem(async () => {
      const rows = await mongoose.models[RECORD_MODELS[kind]]
        .find({ _id: { $in: [...ids] } }, '_id', jobRead(ids.length))
        .lean<Array<{ _id: unknown }>>();
      return rows.map(({ _id }) => String(_id));
    });
  }

  function readSearchRecordTokenBatch({
    collection: kind,
    afterId,
    limit,
  }: Omit<SearchRecordBatchParams, 'upToId'>): Promise<SearchRecordTokens[]> {
    return runAsSystem(async () => {
      const rows = await mongoose.models[RECORD_MODELS[kind]]
        .find(idRange(afterId), 'tokens', jobRead(limit))
        .sort({ _id: 1 })
        .lean<Array<{ _id: unknown; tokens: string[] }>>();
      return rows.map(({ _id, tokens }) => ({ _id: String(_id), tokens }));
    });
  }

  async function incrementSearchVocabNext({
    counts,
    run,
  }: {
    counts: ReadonlyArray<readonly [string, number]>;
    run: number;
  }): Promise<void> {
    if (counts.length === 0) {
      return;
    }
    await runAsSystem(() =>
      tenantSafeBulkWrite(
        mongoose.models.SearchVocab,
        counts.map(([token, count]) => ({
          updateOne: {
            filter: { _id: token },
            update: { $inc: { dfNext: count }, $set: { r: run }, $setOnInsert: { df: 0 } },
            upsert: true,
          },
        })) as unknown as AnyBulkWriteOperation[],
        { ordered: false },
      ),
    );
  }

  async function readSearchVocabBatch({
    afterId,
    limit,
  }: {
    afterId?: string;
    limit: number;
  }): Promise<SearchVocabBatchRow[]> {
    const rows = await mongoose.models.SearchVocab.find(idRange(afterId), null, jobRead(limit))
      .sort({ _id: 1 })
      .lean<Array<{ _id: string; df: number; dfNext?: number; r?: number }>>();
    return rows.map(({ _id, ...row }) => ({ token: _id, ...row }));
  }

  async function settleSearchVocab({
    copy,
    remove,
  }: {
    copy: ReadonlyArray<{ token: string; df: number }>;
    remove: readonly string[];
  }): Promise<void> {
    const ops = [
      ...copy.map(({ token, df }) => ({
        updateOne: { filter: { _id: token }, update: { $set: { df }, $unset: { dfNext: 1 } } },
      })),
      ...remove.map((token) => ({ deleteOne: { filter: { _id: token } } })),
    ];
    if (ops.length > 0) {
      await runAsSystem(() =>
        tenantSafeBulkWrite(
          mongoose.models.SearchVocab,
          ops as unknown as AnyBulkWriteOperation[],
          { ordered: false },
        ),
      );
    }
  }

  return {
    ensureSearchCollections,
    ensureSearchIndexes,
    readVocabFrequencies,
    readVocabRange,
    readRecordWindow,
    readRecordTokens,
    readConversationRecords,
    readMessageTexts,
    getSearchableMessages,
    getSearchHitConversations,
    readSearchState,
    writeSearchState,
    deleteSearchState,
    searchStateExists,
    listSearchJobRequests,
    acquireSearchLease,
    renewSearchLease,
    releaseSearchLease,
    readSearchSources,
    readSearchSourcesById,
    countSearchSources,
    readSearchSourceTenants,
    insertSearchRecords,
    replaceSearchRecords,
    deleteSearchRecords,
    readSearchRecordIds,
    countSearchRecordsAtOtherVersion,
    readSearchRecordIdsIn,
    readSearchRecordTokenBatch,
    incrementSearchVocabNext,
    readSearchVocabBatch,
    settleSearchVocab,
  };
}
