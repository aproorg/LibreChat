import { createGunzip } from 'node:zlib';
import { access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ConversationSearchRecord, MessageSearchRecord } from '@librechat/data-schemas';
import type { Readable } from 'node:stream';
import type { SearchSource } from '../../sync/extract';
import type { Analyzer } from '../../analyzer/analyze';
import { buildConversationRecord, buildMessageRecord } from '../../sync/record';

const BATCH = 2000;

interface SearchLoaderModel {
  insertMany(
    rows: object[],
    options: { ordered: boolean; rawResult: true },
  ): Promise<{ mongoose?: { validationErrors?: unknown[] } }>;
  create(row: object): Promise<unknown>;
}

export interface SearchLoaderModels {
  MessageSearch: Pick<SearchLoaderModel, 'insertMany'>;
  ConversationSearch: Pick<SearchLoaderModel, 'insertMany'>;
  SearchVocab: Pick<SearchLoaderModel, 'insertMany'>;
  SearchState: Pick<SearchLoaderModel, 'create'>;
}

export interface LoadSearchRecordsOptions {
  analyzer: Analyzer;
  version: string;
  messages?: Iterable<SearchSource> | AsyncIterable<SearchSource>;
  conversations?: Iterable<SearchSource> | AsyncIterable<SearchSource>;
  /**
   * Word list as `{ "t": token, "df": n }` lines, gzipped when the name ends in `.gz`.
   * The reference takes its word list from the whole corpus while loading sample users.
   * Without it, the list comes from the records loaded here.
   */
  vocabFile?: string;
  /** Seeds a passed verification record, for tests that need search ready. */
  verificationPassed?: boolean;
}

export interface LoadedSearchRecords {
  messages: number;
  conversations: number;
  vocab: number;
}

/** `ordered: false` skips a row failing validation, which would make the counts untrue. */
async function insertBatch(
  model: Pick<SearchLoaderModel, 'insertMany'>,
  batch: object[],
): Promise<void> {
  const result = await model.insertMany(batch, { ordered: false, rawResult: true });
  const rejected = result.mongoose?.validationErrors?.length ?? 0;
  if (rejected > 0) {
    throw new Error(`${rejected} of ${batch.length} rows failed validation`);
  }
}

async function insertInBatches(
  model: Pick<SearchLoaderModel, 'insertMany'>,
  rows: AsyncIterable<object>,
): Promise<number> {
  let batch: object[] = [];
  let total = 0;
  for await (const row of rows) {
    batch.push(row);
    if (batch.length >= BATCH) {
      await insertBatch(model, batch);
      total += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    await insertBatch(model, batch);
    total += batch.length;
  }
  return total;
}

/** A missing file fails here: a read stream's error does not cross `pipe` to the line reader. */
async function* vocabFromFile(path: string): AsyncGenerator<object> {
  await access(path);
  const file = createReadStream(path);
  const input: Readable = path.endsWith('.gz') ? file.pipe(createGunzip()) : file;
  for await (const line of createInterface({ input })) {
    if (line.length > 0) {
      const { t, df } = JSON.parse(line) as { t: string; df: number };
      yield { _id: t, df };
    }
  }
}

async function* vocabFromCounts(counts: Map<string, number>): AsyncGenerator<object> {
  for (const [token, df] of counts) {
    yield { _id: token, df };
  }
}

/** Loads sources into search records through the production builders, for read tests. */
export async function loadSearchRecords(
  models: SearchLoaderModels,
  options: LoadSearchRecordsOptions,
): Promise<LoadedSearchRecords> {
  const { analyzer, version, vocabFile, verificationPassed = false } = options;
  const counts = new Map<string, number>();
  const count = (tokens: readonly string[]) => {
    if (vocabFile == null) {
      for (const token of tokens) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
  };

  async function* messageRecords(): AsyncGenerator<MessageSearchRecord> {
    for await (const source of options.messages ?? []) {
      const record = buildMessageRecord(source, { analyzer, version });
      if (record) {
        count(record.tokens);
        yield record;
      }
    }
  }

  async function* conversationRecords(): AsyncGenerator<ConversationSearchRecord> {
    for await (const source of options.conversations ?? []) {
      const record = buildConversationRecord(source, { analyzer, version });
      if (record) {
        count(record.tokens);
        yield record;
      }
    }
  }

  const messages = await insertInBatches(models.MessageSearch, messageRecords());
  const conversations = await insertInBatches(models.ConversationSearch, conversationRecords());
  const vocab = await insertInBatches(
    models.SearchVocab,
    vocabFile != null ? vocabFromFile(vocabFile) : vocabFromCounts(counts),
  );
  if (verificationPassed) {
    const now = new Date();
    await models.SearchState.create({
      _id: 'verification',
      status: 'passed',
      snapshotAt: now,
      passedAt: now,
      mismatchedUsers: 0,
      rounds: 1,
    });
  }
  return { messages, conversations, vocab };
}
