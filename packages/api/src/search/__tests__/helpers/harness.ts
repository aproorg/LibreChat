import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMethods,
  createModels,
  loadSearchConfig,
  type SearchMethods,
} from '@librechat/data-schemas';
import type { ConversationSearchConfig, DeepPartial, TCustomConfig } from 'librechat-data-provider';
import type { LanguagePack } from '../../languages/pack';
import type { SearchSource } from '../../sync/extract';
import type { Analyzer } from '../../analyzer/analyze';
import type { SearchMetrics } from '../../metrics';
import { createFakeDictionaryPack } from '../../languages/__tests__/helpers/fakeDictionary';
import { computeAnalyzerVersion } from '../../analyzer/version';
import { createAnalyzer } from '../../analyzer/analyze';
import { createSearchMetrics } from '../../metrics';
import { createEnPack } from '../../languages/en';
import { loadSearchRecords } from './loader';

export interface LoggedEvent {
  level: string;
  event: string;
  meta: object;
}

export interface SearchHarnessLogger {
  info(event: string, meta: object): void;
  warn(event: string, meta: object): void;
  error(event: string, meta: object): void;
}

export interface SearchHarness {
  database: mongoose.Mongoose;
  models: ReturnType<typeof createModels>;
  methods: SearchMethods & ReturnType<typeof createMethods>;
  packs: LanguagePack[];
  analyzer: Analyzer;
  /** Every event `metrics` logged since the last `reset`. */
  logged: LoggedEvent[];
  metrics: SearchMetrics;
  logger: SearchHarnessLogger;
  reset(): Promise<void>;
  /** Writes the sources, then loads their records through the production builders. */
  seed(options: {
    messages?: SearchSource[];
    conversations?: SearchSource[];
    verificationPassed?: boolean;
  }): Promise<void>;
  close(): Promise<void>;
}

export const searchConfig = (search: DeepPartial<ConversationSearchConfig> = {}) =>
  loadSearchConfig({
    search: { data: true, backend: 'search', ...search },
  } as DeepPartial<TCustomConfig>);

/** A real database, real models and methods, the fake dictionary and `en`. */
export async function createSearchHarness(): Promise<SearchHarness> {
  const server = await MongoMemoryServer.create();
  const database = new mongoose.Mongoose();
  database.set('autoIndex', false);
  await database.connect(server.getUri());
  const models = createModels(database);
  const methods = createMethods(database) as SearchHarness['methods'];

  const fake = createFakeDictionaryPack();
  const en = createEnPack();
  await fake.load?.();
  await en.load?.();
  const packs: LanguagePack[] = [fake, en];
  const analyzer = createAnalyzer({ packs, cacheWords: 1000 });
  const version = computeAnalyzerVersion(packs);

  const logged: LoggedEvent[] = [];
  const logger: SearchHarnessLogger = {
    info: (event, meta) => void logged.push({ level: 'info', event, meta }),
    warn: (event, meta) => void logged.push({ level: 'warn', event, meta }),
    error: (event, meta) => void logged.push({ level: 'error', event, meta }),
  };

  return {
    database,
    models,
    methods,
    packs,
    analyzer,
    logged,
    logger,
    metrics: createSearchMetrics(logger),
    async reset() {
      logged.length = 0;
      await database.connection.db!.dropDatabase();
      await methods.ensureSearchCollections();
      await methods.ensureSearchIndexes();
    },
    async seed({ messages = [], conversations = [], verificationPassed }) {
      const db = database.connection.db!;
      if (messages.length) {
        await db.collection('messages').insertMany(messages.map(toStored) as never[]);
      }
      if (conversations.length) {
        await db.collection('conversations').insertMany(conversations.map(toStored) as never[]);
      }
      await loadSearchRecords(models, {
        analyzer,
        version,
        messages,
        conversations,
        verificationPassed,
      });
    },
    async close() {
      await database.disconnect();
      await server.stop();
    },
  };
}

const toStored = (source: SearchSource): object => ({
  ...source,
  _id: new mongoose.Types.ObjectId(String(source._id)),
});

let counter = 0;
const nextId = () => {
  counter += 1;
  return counter.toString(16).padStart(24, '0');
};

/** A source message, stored and indexable unless the fields say otherwise. */
export function sourceMessage(fields: Record<string, unknown> & { text?: string }): SearchSource {
  const _id = nextId();
  return {
    _id,
    messageId: `m-${_id}`,
    user: 'user-a',
    conversationId: 'convo-a',
    isCreatedByUser: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...fields,
  } as SearchSource;
}

export function sourceConversation(fields: Record<string, unknown>): SearchSource {
  const _id = nextId();
  return {
    _id,
    conversationId: `c-${_id}`,
    user: 'user-a',
    title: 'Untitled',
    model: 'model',
    endpoint: 'openAI',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...fields,
  } as SearchSource;
}
