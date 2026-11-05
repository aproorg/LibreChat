import type { SearchStateEntry } from '~/types/search';
import { buildRetentionVisibilityFilter } from '~/utils/retention';
import { buildIndexableQuery } from '~/models/plugins/mongoMeili';
import { createIndexesWithRetry } from '~/utils/retry';
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
  };
}
