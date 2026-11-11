import { isIndexableSource } from '@librechat/data-schemas';
import type {
  ConversationSearchRecord,
  MessageSearchRecord,
  SearchSourceCollection,
} from '@librechat/data-schemas';
import type { ExtractedConversation, ExtractedMessage, SearchSource } from './extract';
import type { Analyzer } from '../analyzer/analyze';
import { extractConversation, extractMessage } from './extract';

export interface BuildRecordOptions {
  analyzer: Analyzer;
  /** Analyzer version the tokens come from. */
  version: string;
  /** Writer epoch. Backfill writes 0. */
  epoch?: number;
}

const tenantOf = (source: SearchSource): { tenantId?: string } =>
  typeof source.tenantId === 'string' ? { tenantId: source.tenantId } : {};

/**
 * A record before its tokens. It holds `h`, so a caller can tell an unchanged row from its
 * stored stamp and skip the analysis, which is nearly all of a record's cost.
 */
export type PreparedRecord =
  | {
      collection: 'messages';
      fields: Omit<ExtractedMessage, 'text'>;
      /** Never store or log it. */
      text: string;
      tenant: { tenantId?: string };
    }
  | {
      collection: 'conversations';
      fields: Omit<ExtractedConversation, 'text'>;
      /** Never store or log it. */
      text: string;
      tenant: { tenantId?: string };
    };

/** `null` when the source does not belong in search. Runs no analysis. */
export function prepareRecord(
  collection: SearchSourceCollection,
  source: SearchSource,
): PreparedRecord | null {
  if (collection === 'messages') {
    if (!isIndexableSource(source, 'subagentTask')) {
      return null;
    }
    const { text, ...fields } = extractMessage(source);
    return { collection, fields, text, tenant: tenantOf(source) };
  }
  if (!isIndexableSource(source, 'subagentThread')) {
    return null;
  }
  const { text, ...fields } = extractConversation(source);
  return { collection, fields, text, tenant: tenantOf(source) };
}

/** Analyzes a prepared record's text into the record that is stored. */
export function finishRecord(
  prepared: PreparedRecord,
  { analyzer, version, epoch = 0 }: BuildRecordOptions,
): MessageSearchRecord | ConversationSearchRecord {
  if (prepared.collection === 'messages') {
    const tokens = analyzer.analyzeMessage(prepared.text);
    return {
      ...prepared.fields,
      n: tokens.length,
      v: version,
      e: epoch,
      tokens,
      ...prepared.tenant,
    };
  }
  return {
    ...prepared.fields,
    v: version,
    e: epoch,
    tokens: analyzer.docTokens(prepared.text),
    ...prepared.tenant,
  };
}

/** The record for one message, or `null` when the source does not belong in search. */
export function buildMessageRecord(
  source: SearchSource,
  options: BuildRecordOptions,
): MessageSearchRecord | null {
  const prepared = prepareRecord('messages', source);
  return prepared ? (finishRecord(prepared, options) as MessageSearchRecord) : null;
}

/** The record for one conversation, or `null` when the source does not belong in search. */
export function buildConversationRecord(
  source: SearchSource,
  options: BuildRecordOptions,
): ConversationSearchRecord | null {
  const prepared = prepareRecord('conversations', source);
  return prepared ? (finishRecord(prepared, options) as ConversationSearchRecord) : null;
}

/**
 * Whether this source should have a record: the question verification asks. A row missing
 * a field a record needs can never have one, so it is not a gap. Text is not read here.
 */
export function belongsInSearch(
  collection: SearchSourceCollection,
  source: SearchSource,
  /** The moment to judge `expiredAt` at. `0` asks whether the row belonged before it expired. */
  now?: number,
): boolean {
  const isMessage = collection === 'messages';
  if (!isIndexableSource(source, isMessage ? 'subagentTask' : 'subagentThread', now)) {
    return false;
  }
  try {
    if (isMessage) {
      extractMessage(source);
    } else {
      extractConversation(source);
    }
    return true;
  } catch {
    return false;
  }
}
