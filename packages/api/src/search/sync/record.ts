import { isIndexableSource } from '@librechat/data-schemas';
import type { ConversationSearchRecord, MessageSearchRecord } from '@librechat/data-schemas';
import type { Analyzer } from '../analyzer/analyze';
import type { SearchSource } from './extract';
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

/** The record for one message, or `null` when the source does not belong in search. */
export function buildMessageRecord(
  source: SearchSource,
  { analyzer, version, epoch = 0 }: BuildRecordOptions,
): MessageSearchRecord | null {
  if (!isIndexableSource(source, 'subagentTask')) {
    return null;
  }
  const { text, ...fields } = extractMessage(source);
  const tokens = analyzer.analyzeMessage(text);
  return { ...fields, n: tokens.length, v: version, e: epoch, tokens, ...tenantOf(source) };
}

/** The record for one conversation, or `null` when the source does not belong in search. */
export function buildConversationRecord(
  source: SearchSource,
  { analyzer, version, epoch = 0 }: BuildRecordOptions,
): ConversationSearchRecord | null {
  if (!isIndexableSource(source, 'subagentThread')) {
    return null;
  }
  const { text, ...fields } = extractConversation(source);
  return { ...fields, v: version, e: epoch, tokens: analyzer.docTokens(text), ...tenantOf(source) };
}
