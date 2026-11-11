import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from './index';

const SEARCH_COLLECTIONS = ['msearch', 'csearch', 'search_vocab', 'search_state'];
const TENANT_ISOLATION_APPLIED = Symbol.for('librechat:tenantIsolation');

const hasTenantPlugin = (schema: mongoose.Schema): boolean =>
  (schema as unknown as { [key: symbol]: boolean })[TENANT_ISOLATION_APPLIED] === true;

describe('search models', () => {
  let server: MongoMemoryServer;
  let database: mongoose.Mongoose;
  let models: ReturnType<typeof createModels>;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    database = new mongoose.Mongoose();
    await database.connect(server.getUri());
    models = createModels(database);
    await Promise.all(Object.values(models).map((model) => model.init().catch(() => undefined)));
  });

  afterAll(async () => {
    await database.disconnect();
    await server.stop();
  });

  it('creates no search collection after createModels with automatic creation on', async () => {
    const collections = await database.connection.db!.listCollections().toArray();
    const names = collections.map((collection) => collection.name);
    expect(names).toContain('messages');
    for (const name of SEARCH_COLLECTIONS) {
      expect(names).not.toContain(name);
    }
  });

  it('maps each model to its collection', () => {
    expect(models.MessageSearch.collection.name).toBe('msearch');
    expect(models.ConversationSearch.collection.name).toBe('csearch');
    expect(models.SearchVocab.collection.name).toBe('search_vocab');
    expect(models.SearchState.collection.name).toBe('search_state');
  });

  it('turns off automatic creation and indexing on all four schemas', () => {
    for (const model of [
      models.MessageSearch,
      models.ConversationSearch,
      models.SearchVocab,
      models.SearchState,
    ]) {
      expect(model.schema.get('autoCreate')).toBe(false);
      expect(model.schema.get('autoIndex')).toBe(false);
    }
  });

  it('applies tenant isolation to the two record models only', () => {
    expect(hasTenantPlugin(models.MessageSearch.schema)).toBe(true);
    expect(hasTenantPlugin(models.ConversationSearch.schema)).toBe(true);
    expect(hasTenantPlugin(models.SearchVocab.schema)).toBe(false);
    expect(hasTenantPlugin(models.SearchState.schema)).toBe(false);
    expect(models.SearchVocab.schema.path('tenantId')).toBeUndefined();
    expect(models.SearchState.schema.path('tenantId')).toBeUndefined();
  });

  it('declares the message record per the data model', () => {
    const { schema } = models.MessageSearch;
    expect(schema.path('_id').instance).toBe('ObjectId');
    for (const field of ['user', 'conversationId', 'messageId', 'h', 'v', 'tenantId']) {
      expect(schema.path(field).instance).toBe('String');
    }
    expect(schema.path('createdAt').instance).toBe('Date');
    expect(schema.path('n').instance).toBe('Number');
    expect(schema.path('e').instance).toBe('Number');
    expect(schema.path('tokens').instance).toBe('Array');
    expect(schema.path('text')).toBeUndefined();
    expect(schema.path('updatedAt')).toBeUndefined();
  });

  it('declares the conversation record per the data model', () => {
    const { schema } = models.ConversationSearch;
    expect(schema.path('_id').instance).toBe('ObjectId');
    for (const field of ['user', 'conversationId', 'h', 'v', 'tenantId']) {
      expect(schema.path(field).instance).toBe('String');
    }
    expect(schema.path('e').instance).toBe('Number');
    expect(schema.path('tokens').instance).toBe('Array');
    expect(schema.path('title')).toBeUndefined();
  });

  it('keys the word list and state by string', () => {
    expect(models.SearchVocab.schema.path('_id').instance).toBe('String');
    expect(models.SearchVocab.schema.path('df').instance).toBe('Number');
    expect(models.SearchVocab.schema.path('dfNext').instance).toBe('Number');
    expect(models.SearchVocab.schema.path('r').instance).toBe('Number');
    expect(models.SearchState.schema.path('_id').instance).toBe('String');
    expect(models.SearchState.schema.get('strict')).toBe(false);
  });

  it('holds tokens to the 3,000 cap on both records', () => {
    const fields = {
      _id: new database.Types.ObjectId(),
      user: 'user',
      conversationId: 'conversation',
      messageId: 'message',
      createdAt: new Date(),
      n: 1,
      h: 'hash',
      v: 'version',
      e: 0,
    };
    const atCap = Array.from({ length: 3000 }, (_, index) => `t${index}`);
    const overCap = [...atCap, 'extra'];

    expect(new models.MessageSearch({ ...fields, tokens: atCap }).validateSync()).toBeUndefined();
    expect(
      new models.MessageSearch({ ...fields, tokens: overCap }).validateSync()?.errors.tokens,
    ).toBeDefined();
    expect(
      new models.ConversationSearch({ ...fields, tokens: atCap }).validateSync(),
    ).toBeUndefined();
    expect(
      new models.ConversationSearch({ ...fields, tokens: overCap }).validateSync()?.errors.tokens,
    ).toBeDefined();
  });
});
