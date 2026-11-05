import type { SearchReason } from 'librechat-data-provider';

/** One indexable message's search tokens, derived from its source. Holds no message text. */
export interface MessageSearchRecord {
  /** The source message's `_id`, as a hex string. A delete event carries only this. */
  _id: string;
  user: string;
  conversationId: string;
  messageId: string;
  /** The source's value; the sort key. */
  createdAt: Date;
  /** Token count, for the length bucket. */
  n: number;
  /** Hash of the extracted text and identity fields. The same value writes nothing. */
  h: string;
  /** Analyzer version. */
  v: string;
  /** Writer epoch; 0 from backfill. */
  e: number;
  /** At most 3,000. Compound parts carry `~`. */
  tokens: string[];
  tenantId?: string;
}

/** One indexable conversation's search tokens, from its title and tags. */
export interface ConversationSearchRecord {
  /** The source conversation's `_id`, as a hex string. */
  _id: string;
  user: string;
  conversationId: string;
  /** Hash of title, tags and identity fields. */
  h: string;
  v: string;
  e: number;
  tokens: string[];
  tenantId?: string;
}

/** One token in the word list. */
export interface SearchVocabRow {
  /** The token, including `~` forms. */
  _id: string;
  /** Approximate. Only orders expansions and rarity. */
  df: number;
  /** Count building during a rebuild. */
  dfNext?: number;
  /** Rebuild run that last stamped this row. */
  r?: number;
}

/** One key of sync state. Holds IDs, counts, timestamps and statuses, never content. */
export interface SearchStateEntry {
  _id: string;
  [key: string]: unknown;
}

/** What a search needs from its request. Reads no config. */
export interface SearchContext {
  /** The session user. Every read is scoped to this. */
  user: string;
  /** Fires when the client disconnects before the response finishes. */
  signal: AbortSignal;
  /** Epoch milliseconds when the request's search began. */
  startedAt: number;
}

/** Conversations a search matched, for the existing filter and cursor logic to take over. */
export interface SearchPortMatches {
  conversationIds: string[];
  /** Message search failed, so only title matches are included. */
  partial?: boolean;
  reason?: SearchReason;
}

/**
 * The seam from database methods into the search service. Every method answers
 * `null` when Meilisearch serves, so its caller runs today's code unchanged.
 */
export interface SearchPort {
  /** Conversations matched by messages, titles or tags, for the sidebar and Archived Chats. */
  conversationMatches(ctx: SearchContext, query: string): Promise<SearchPortMatches | null>;
  /** Conversations matched by title or tags, for shared links. */
  titleMatches(ctx: SearchContext, query: string): Promise<SearchPortMatches | null>;
}
