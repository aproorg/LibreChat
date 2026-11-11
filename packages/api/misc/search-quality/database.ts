import mongoose from 'mongoose';
import { createModels } from '@librechat/data-schemas';
import { loadSearchRecords } from '~/search/__tests__/helpers/loader';
import { computeAnalyzerVersion } from '~/search/analyzer/version';
import type { Analyzer } from '~/search/analyzer/analyze';
import type { CorpusDocument } from './corpus';

export interface QualityDatabase {
  connection: mongoose.Mongoose;
  models: ReturnType<typeof createModels>;
  close(): Promise<void>;
}

/** `dbName` keeps specs apart: Jest runs them at once, and each load starts by emptying its database. */
export async function connectQualityDatabase(
  uri: string,
  dbName: string,
): Promise<QualityDatabase> {
  const connection = new mongoose.Mongoose();
  await connection.connect(uri, { dbName });
  return {
    connection,
    models: createModels(connection),
    close: () => connection.disconnect(),
  };
}

/** Which of a corpus's users to load. The word list still comes from the whole corpus. */
export interface LoadCorpusOptions {
  analyzer: Analyzer;
  messages: AsyncIterable<CorpusDocument>;
  conversations: AsyncIterable<CorpusDocument>;
  vocabFile: string;
  users: ReadonlySet<string>;
}

async function* forUsers(
  docs: AsyncIterable<CorpusDocument>,
  users: ReadonlySet<string>,
): AsyncGenerator<CorpusDocument> {
  for await (const doc of docs) {
    if (typeof doc.user === 'string' && users.has(doc.user)) {
      yield doc;
    }
  }
}

/**
 * Loads sample users through the production record builders, as `final/load-local.mjs`
 * loads them: `df` decides the rare and common split and the tiers, so the word list
 * comes from the whole corpus. Starts from an empty database.
 */
export async function loadQualityCorpus(database: QualityDatabase, options: LoadCorpusOptions) {
  const { analyzer, messages, conversations, vocabFile, users } = options;
  await database.connection.connection.dropDatabase();
  const loaded = await loadSearchRecords(database.models, {
    analyzer,
    version: computeAnalyzerVersion(analyzer.packs),
    messages: forUsers(messages, users),
    conversations: forUsers(conversations, users),
    vocabFile,
  });
  await database.models.MessageSearch.createIndexes();
  await database.models.ConversationSearch.createIndexes();
  return loaded;
}
