import { createHash } from 'node:crypto';
import { parseTextParts } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';

/** A stored source row, as a change event, a lean read or a corpus line holds it. */
export type SearchSource = Record<string, unknown>;

export interface ExtractedMessage {
  _id: string;
  user: string;
  conversationId: string;
  messageId: string;
  createdAt: Date;
  /** Message text, thinking and steer text. Never store or log it. */
  text: string;
  h: string;
}

export interface ExtractedConversation {
  _id: string;
  user: string;
  conversationId: string;
  /** Title and tags. Never store or log it. */
  text: string;
  h: string;
}

/** The hash spans fields with delimiting, so text cannot move between them unseen. */
const hash = (fields: ReadonlyArray<string | readonly string[]>): string =>
  createHash('sha256').update(JSON.stringify(fields)).digest('hex');

function requireString(source: SearchSource, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Search source has no usable ${field}`);
  }
  return value;
}

function requireDate(source: SearchSource, field: string): Date {
  const value = source[field];
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  throw new TypeError(`Search source has no usable ${field}`);
}

const requireId = (source: SearchSource): string => {
  if (source._id == null) {
    throw new TypeError('Search source has no usable _id');
  }
  return String(source._id);
};

/**
 * Fields are taken by name: `contextMeta`, `summary`, `metadata`, tool output, sender
 * and IDs never reach the text (FR-008), and nothing here logs a document.
 */
function messageText(source: SearchSource): string {
  if (Array.isArray(source.content)) {
    return parseTextParts(source.content as TMessageContentParts[], false, { includeSteer: true });
  }
  return typeof source.text === 'string' ? source.text : '';
}

export function extractMessage(source: SearchSource): ExtractedMessage {
  const user = requireString(source, 'user');
  const conversationId = requireString(source, 'conversationId');
  const createdAt = requireDate(source, 'createdAt');
  const text = messageText(source);
  return {
    _id: requireId(source),
    user,
    conversationId,
    messageId: requireString(source, 'messageId'),
    createdAt,
    text,
    h: hash([text, user, conversationId, createdAt.toISOString()]),
  };
}

export function extractConversation(source: SearchSource): ExtractedConversation {
  const user = requireString(source, 'user');
  const conversationId = requireString(source, 'conversationId');
  const title = typeof source.title === 'string' ? source.title : '';
  const tags = Array.isArray(source.tags)
    ? source.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  return {
    _id: requireId(source),
    user,
    conversationId,
    text: [title, ...tags].filter((part) => part.length > 0).join(' '),
    h: hash([title, tags, user, conversationId]),
  };
}
