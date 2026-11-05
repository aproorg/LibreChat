import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Analyzer } from '~/search/analyzer/analyze';
import type { QualityDatabase } from './database';
import type { CorpusDocument } from './corpus';
import type { GoldenQuery } from './scoring';
import { corpusConversations, corpusMessages } from './corpus';
import { loadQualityCorpus } from './database';
import { requireQualityEnv } from './env';

export type ConditionName = 'P' | 'H';

/** A loading condition of `final/conditions.mjs`, as T016 wrote it out of tree. */
export interface QualityCondition {
  user: string;
  prefix: string;
  dir: string;
  vocab: string;
}

export interface QualityQuery extends GoldenQuery {
  /** Content words, after stop-word removal. */
  words: number;
  /** One content word, in a category needing no prefix or typo tier. Decided from its shape, not its result. */
  us1: boolean;
}

/** `SEARCH_QUALITY_DIR/queries.json`, from T016. */
export interface QualityManifest {
  users: { gold: string; other: string };
  conditions: Record<ConditionName, QualityCondition>;
  queries: QualityQuery[];
  gradeQueries: string[];
  /** Words only excluded or foreign messages hold. */
  isolationQueries: string[];
}

export const readQualityJson = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(join(requireQualityEnv('SEARCH_QUALITY_DIR'), name), 'utf8')) as T;

export interface ConditionRow {
  user: string;
  indexable: boolean;
  text: string;
  tokens?: string[];
  source: CorpusDocument;
}

/** T016's condition rows carry the reference's tokens beside the source fields production reads. */
type ConditionDocument = CorpusDocument & { _tokens?: string[] };

async function readConditionRows(dir: string): Promise<Map<string, ConditionRow>> {
  const rows = new Map<string, ConditionRow>();
  for await (const source of corpusMessages(dir)) {
    rows.set(String(source.messageId), {
      user: String(source.user),
      indexable: source._indexable !== false,
      text: source._text ?? '',
      tokens: (source as ConditionDocument)._tokens,
      source,
    });
  }
  return rows;
}

/**
 * Loads a condition's user beside the gold and other users, whose words the condition
 * shares, so a leak would have something to return. Reads the word list named in the
 * manifest, next to `SEARCH_QUALITY_VOCAB`.
 */
export async function loadCondition(
  database: QualityDatabase,
  analyzer: Analyzer,
  manifest: QualityManifest,
  name: ConditionName,
): Promise<{ condition: QualityCondition; rows: Map<string, ConditionRow> }> {
  const condition = manifest.conditions[name];
  const dir = join(requireQualityEnv('SEARCH_QUALITY_DIR'), condition.dir);
  await loadQualityCorpus(database, {
    analyzer,
    messages: corpusMessages(dir),
    conversations: corpusConversations(dir),
    vocabFile: join(dirname(requireQualityEnv('SEARCH_QUALITY_VOCAB')), condition.vocab),
    users: new Set([condition.user, manifest.users.gold, manifest.users.other]),
  });
  return { condition, rows: await readConditionRows(dir) };
}
