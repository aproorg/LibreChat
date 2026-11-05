import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { SearchPort } from '~/types/search';
import type { SearchMethods } from './search';
import { createSearchMethods } from './search';
import { createMethods } from './index';
import { createModels } from '~/models';

const SEARCH_COLLECTIONS = ['msearch', 'csearch', 'search_vocab', 'search_state'];

describe('search collections and indexes', () => {
  let server: MongoMemoryServer;
  let database: mongoose.Mongoose;
  let methods: SearchMethods;

  const collectionNames = async (): Promise<string[]> =>
    (await database.connection.db!.listCollections().toArray()).map(({ name }) => name);

  const indexesOf = (name: string) => database.connection.db!.collection(name).indexes();

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    database = new mongoose.Mongoose();
    database.set('autoCreate', false);
    database.set('autoIndex', false);
    await database.connect(server.getUri());
    createModels(database);
    methods = createSearchMethods(database);
  });

  afterAll(async () => {
    await database.disconnect();
    await server.stop();
  });

  beforeEach(async () => {
    await database.connection.db!.dropDatabase();
  });

  it('is part of createMethods', () => {
    const all = createMethods(database);
    expect(typeof all.ensureSearchCollections).toBe('function');
    expect(typeof all.ensureSearchIndexes).toBe('function');
  });

  it('takes a lazy search port, which it does not call while creating methods', () => {
    const getSearchPort = jest.fn((): SearchPort | null => null);
    const all = createMethods(database, { getSearchPort });
    expect(typeof all.getConvosByCursor).toBe('function');
    expect(getSearchPort).not.toHaveBeenCalled();
  });

  it('creates the four collections and no index beyond _id, and repeats safely', async () => {
    await methods.ensureSearchCollections();
    await methods.ensureSearchCollections();

    const names = await collectionNames();
    for (const name of SEARCH_COLLECTIONS) {
      expect(names).toContain(name);
      expect((await indexesOf(name)).map((index) => index.name)).toEqual(['_id_']);
    }
  });

  it('builds exactly the record indexes, and repeats safely', async () => {
    await methods.ensureSearchCollections();
    await methods.ensureSearchIndexes();
    await methods.ensureSearchIndexes();

    const messageIndexes = await indexesOf('msearch');
    expect(messageIndexes).toHaveLength(2);
    const named = messageIndexes.find((index) => index.name === 'user_tokens_created');
    expect(named?.key).toEqual({ user: 1, tokens: 1, createdAt: -1 });

    const conversationIndexes = await indexesOf('csearch');
    expect(conversationIndexes).toHaveLength(2);
    expect(conversationIndexes.find((index) => index.name !== '_id_')?.key).toEqual({
      user: 1,
      tokens: 1,
    });

    expect((await indexesOf('search_vocab')).map((index) => index.name)).toEqual(['_id_']);
    expect((await indexesOf('search_state')).map((index) => index.name)).toEqual(['_id_']);
  });

  it('creates nothing until called', async () => {
    createMethods(database);
    const names = await collectionNames();
    for (const name of SEARCH_COLLECTIONS) {
      expect(names).not.toContain(name);
    }
  });
});

describe('search reads', () => {
  const USER = 'user-a';
  const OTHER = 'user-b';
  const READ = { maxTimeMS: 5000 };
  /** Given a batch size equal to the limit, the driver sends one more so the server closes the cursor. */
  const DRIVER_BATCH_MARGIN = 1;

  let server: MongoMemoryServer;
  let database: mongoose.Mongoose;
  let methods: SearchMethods;
  let commands: Array<Record<string, unknown>> = [];
  let onCommand: (event: { commandName: string; command: Record<string, unknown> }) => void;

  const objectId = () => new database.Types.ObjectId();
  const finds = (collection: string) => commands.filter((command) => command.find === collection);

  const insertRecord = async (user: string, token: string, messageId: string, createdAt: Date) =>
    database.connection.db!.collection('msearch').insertOne({
      _id: objectId(),
      user,
      conversationId: `convo-${user}`,
      messageId,
      createdAt,
      n: 1,
      h: 'h',
      v: 'v',
      e: 0,
      tokens: [token, 'shared'],
    } as never);

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    database = new mongoose.Mongoose();
    database.set('autoCreate', false);
    database.set('autoIndex', false);
    await database.connect(server.getUri(), { monitorCommands: true });
    createModels(database);
    methods = createSearchMethods(database);
    onCommand = ({ command }) => {
      commands.push(command);
    };
    database.connection.getClient().on('commandStarted', onCommand);
  });

  afterAll(async () => {
    database.connection.getClient().off('commandStarted', onCommand);
    await database.disconnect();
    await server.stop();
  });

  beforeEach(async () => {
    await database.connection.db!.dropDatabase();
    await methods.ensureSearchCollections();
    await methods.ensureSearchIndexes();
    commands = [];
  });

  describe('readVocabFrequencies', () => {
    it('answers only the tokens it was asked about', async () => {
      await database.models.SearchVocab.insertMany([
        { _id: 'a', df: 3 },
        { _id: 'b', df: 7 },
      ]);
      expect(await methods.readVocabFrequencies(['a', 'missing'], READ)).toEqual([
        { token: 'a', df: 3 },
      ]);
    });

    it('reads nothing for no tokens', async () => {
      expect(await methods.readVocabFrequencies([], READ)).toEqual([]);
      expect(finds('search_vocab')).toHaveLength(0);
    });
  });

  describe('readVocabRange', () => {
    it('stays inside the range and the limit', async () => {
      await database.models.SearchVocab.insertMany([
        { _id: 'ka', df: 1 },
        { _id: 'kb', df: 2 },
        { _id: 'kc', df: 3 },
        { _id: 'l', df: 4 },
      ]);
      const rows = await methods.readVocabRange({ start: 'k', end: 'l', limit: 2 }, READ);
      expect(rows).toEqual([
        { token: 'ka', df: 1 },
        { token: 'kb', df: 2 },
      ]);
      expect(finds('search_vocab')[0]).toMatchObject({
        limit: 2,
        batchSize: 2 + DRIVER_BATCH_MARGIN,
        singleBatch: true,
      });
    });
  });

  describe('readRecordWindow', () => {
    it('returns newest first without tokens, and never another user', async () => {
      await insertRecord(USER, 'word', 'old', new Date('2026-01-01'));
      await insertRecord(USER, 'word', 'new', new Date('2026-02-01'));
      await insertRecord(OTHER, 'word', 'theirs', new Date('2026-03-01'));

      const rows = await methods.readRecordWindow(
        { user: USER, tokens: ['word'], limit: 10 },
        READ,
      );

      expect(rows.map(({ messageId }) => messageId)).toEqual(['new', 'old']);
      expect(rows[0]).toEqual({
        _id: expect.any(String),
        messageId: 'new',
        conversationId: `convo-${USER}`,
        createdAt: new Date('2026-02-01'),
        n: 1,
      });
      expect(rows[0]).not.toHaveProperty('tokens');
    });

    it('sends singleBatch, a batch size equal to the limit, maxTimeMS and the index hint', async () => {
      await insertRecord(USER, 'word', 'one', new Date());

      await methods.readRecordWindow({ user: USER, tokens: ['word', 'other'], limit: 7 }, READ);

      expect(finds('msearch')[0]).toMatchObject({
        filter: { user: USER, tokens: { $in: ['word', 'other'] } },
        singleBatch: true,
        batchSize: 7 + DRIVER_BATCH_MARGIN,
        limit: 7,
        maxTimeMS: 5000,
        hint: 'user_tokens_created',
      });
      expect(finds('msearch')[0].sort).toEqual(new Map([['createdAt', -1]]));
      expect(commands.filter(({ getMore }) => getMore != null)).toHaveLength(0);
      expect(JSON.stringify(finds('msearch')[0].projection)).not.toContain('tokens');
    });

    it('requires every word set it is given', async () => {
      await insertRecord(USER, 'word', 'both', new Date());
      await database.connection
        .db!.collection('msearch')
        .updateOne({ messageId: 'both' }, { $push: { tokens: 'extra' } } as never);
      await insertRecord(USER, 'word', 'one', new Date());

      const rows = await methods.readRecordWindow(
        { user: USER, tokens: ['word'], allOf: [['extra']], limit: 10 },
        READ,
      );

      expect(rows.map(({ messageId }) => messageId)).toEqual(['both']);
    });

    it('stops when its signal fires', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        methods.readRecordWindow(
          { user: USER, tokens: ['word'], limit: 1 },
          { ...READ, signal: controller.signal },
        ),
      ).rejects.toThrow();
    });
  });

  describe('readRecordTokens', () => {
    it('reads by id in chunks of 50, and only the session user', async () => {
      const mine: string[] = [];
      for (let index = 0; index < 51; index += 1) {
        const { insertedId } = await insertRecord(USER, 'word', `m${index}`, new Date());
        mine.push(String(insertedId));
      }
      const { insertedId: theirs } = await insertRecord(OTHER, 'word', 'theirs', new Date());

      const rows = await methods.readRecordTokens(
        { user: USER, ids: [...mine, String(theirs)] },
        READ,
      );

      expect(rows).toHaveLength(51);
      expect(rows.every(({ tokens }) => tokens.includes('word'))).toBe(true);
      expect(rows.map(({ _id }) => _id)).not.toContain(String(theirs));
      expect(finds('msearch')).toHaveLength(2);
      expect(finds('msearch')[0]).toMatchObject({ singleBatch: true, maxTimeMS: 5000 });
    });
  });

  describe('readConversationRecords', () => {
    const insertTitle = (user: string, conversationId: string, tokens: string[]) =>
      database.connection.db!.collection('csearch').insertOne({
        _id: objectId(),
        user,
        conversationId,
        h: 'h',
        v: 'v',
        e: 0,
        tokens,
      } as never);

    it('requires every word set, bounds its hits and never returns another user', async () => {
      await insertTitle(USER, 'both', ['a', 'b']);
      await insertTitle(USER, 'one', ['a']);
      await insertTitle(OTHER, 'theirs', ['a', 'b']);

      const rows = await methods.readConversationRecords(
        { user: USER, allOf: [['a'], ['b', 'c']], limit: 10 },
        READ,
      );

      expect(rows).toEqual([{ conversationId: 'both' }]);
      expect(finds('csearch')[0]).toMatchObject({
        singleBatch: true,
        batchSize: 10 + DRIVER_BATCH_MARGIN,
        limit: 10,
        maxTimeMS: 5000,
        hint: { user: 1, tokens: 1 },
      });
    });
  });

  describe('source reads', () => {
    const insertMessage = (fields: Record<string, unknown>) =>
      database.connection.db!.collection('messages').insertOne({
        _id: objectId(),
        user: USER,
        conversationId: 'convo',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...fields,
      } as never);

    const insertConvo = (fields: Record<string, unknown>) =>
      database.connection.db!.collection('conversations').insertOne({
        _id: objectId(),
        user: USER,
        title: 'title',
        model: 'model',
        ...fields,
      } as never);

    describe('readMessageTexts', () => {
      it('reads canonical text fields only, for the session user', async () => {
        await insertMessage({
          messageId: 'm',
          text: 'plain',
          content: [{ type: 'text', text: 'body', extra: 'private' }],
          contextMeta: { secret: true },
          summary: 'private',
        });
        await insertMessage({ user: OTHER, messageId: 'x', text: 'theirs' });

        const rows = await methods.readMessageTexts({ user: USER, messageIds: ['m', 'x'] }, READ);

        expect(rows).toEqual([
          { messageId: 'm', text: 'plain', content: [{ type: 'text', text: 'body' }] },
        ]);
      });
    });

    describe('messages larger than one batch together', () => {
      const ids = Array.from({ length: 25 }, (_, index) => `large-${index}`);
      const oneMegabyte = 'x'.repeat(1024 * 1024);

      beforeEach(async () => {
        for (const messageId of ids) {
          await insertMessage({
            messageId,
            text: 't',
            content: [{ type: 'text', text: oneMegabyte }],
          });
        }
      });

      it('getSearchableMessages returns every one', async () => {
        const rows = await methods.getSearchableMessages(USER, ids, READ);
        expect(rows.map(({ messageId }) => messageId).sort()).toEqual([...ids].sort());
      });

      it('readMessageTexts returns every one', async () => {
        const rows = await methods.readMessageTexts({ user: USER, messageIds: ids }, READ);
        expect(rows.map(({ messageId }) => messageId).sort()).toEqual([...ids].sort());
      });

      it('stops when the rest are really absent', async () => {
        const rows = await methods.getSearchableMessages(USER, [...ids, 'absent'], READ);
        expect(rows).toHaveLength(ids.length);
      });
    });

    describe('getSearchableMessages', () => {
      it('drops temporary, subagent, unfinished and expired messages', async () => {
        const later = new Date(Date.now() + 3_600_000);
        const earlier = new Date(Date.now() - 3_600_000);
        await insertMessage({ messageId: 'kept', isTemporary: false, expiredAt: null, text: 't' });
        await insertMessage({ messageId: 'legacy', text: 't' });
        await insertMessage({ messageId: 'retained', isTemporary: false, expiredAt: later });
        await insertMessage({ messageId: 'temporary', isTemporary: true, expiredAt: later });
        await insertMessage({ messageId: 'subagent', subagentTask: { attemptKey: 'k' } });
        await insertMessage({ messageId: 'unfinished', unfinished: true });
        await insertMessage({ messageId: 'expired', isTemporary: false, expiredAt: earlier });
        await insertMessage({ messageId: 'theirs', user: OTHER });

        const rows = await methods.getSearchableMessages(
          USER,
          [
            'kept',
            'legacy',
            'retained',
            'temporary',
            'subagent',
            'unfinished',
            'expired',
            'theirs',
          ],
          READ,
        );

        expect(rows.map(({ messageId }) => messageId).sort()).toEqual([
          'kept',
          'legacy',
          'retained',
        ]);
      });

      it('leaves out private fields', async () => {
        await insertMessage({
          messageId: 'kept',
          text: 'visible',
          contextMeta: { secret: true },
          summary: 'private',
          clientId: 'private',
          _meiliIndex: true,
        });

        const [row] = await methods.getSearchableMessages(USER, ['kept'], READ);

        expect(row).toMatchObject({ messageId: 'kept', text: 'visible' });
        for (const field of ['_id', 'user', 'contextMeta', 'summary', 'clientId', '_meiliIndex']) {
          expect(row).not.toHaveProperty(field);
        }
        expect(finds('messages')[0]).toMatchObject({ maxTimeMS: 5000 });
      });
    });

    describe('getSearchHitConversations', () => {
      it('applies both visibility filters and reads only what the route needs', async () => {
        const earlier = new Date(Date.now() - 3_600_000);
        await insertConvo({ conversationId: 'kept', isTemporary: false, expiredAt: null });
        await insertConvo({ conversationId: 'temporary', isTemporary: true });
        await insertConvo({ conversationId: 'expired', isTemporary: false, expiredAt: earlier });
        await insertConvo({ conversationId: 'thread', subagentThread: { parent: 'p' } });
        await insertConvo({ conversationId: 'theirs', user: OTHER });

        const rows = await methods.getSearchHitConversations(
          USER,
          ['kept', 'temporary', 'expired', 'thread', 'theirs'],
          READ,
        );

        expect(rows).toEqual([{ conversationId: 'kept', title: 'title', model: 'model' }]);
        expect(finds('conversations')[0]).toMatchObject({ maxTimeMS: 5000 });
      });
    });
  });

  describe('readSearchState', () => {
    it('answers null for an absent key', async () => {
      expect(await methods.readSearchState('verification', READ)).toBeNull();
    });

    it('answers the stored document', async () => {
      await database.models.SearchState.create({ _id: 'verification', status: 'passed' });
      expect(await methods.readSearchState('verification', READ)).toEqual({
        _id: 'verification',
        status: 'passed',
      });
    });
  });

  describe('scoping', () => {
    it.each([
      [
        'readRecordWindow',
        () => methods.readRecordWindow({ user: '', tokens: ['a'], limit: 1 }, READ),
      ],
      [
        'readRecordWindow with a non-string',
        () =>
          methods.readRecordWindow(
            { user: { $ne: null } as unknown as string, tokens: ['a'], limit: 1 },
            READ,
          ),
      ],
      [
        'readRecordTokens',
        () => methods.readRecordTokens({ user: '', ids: [String(objectId())] }, READ),
      ],
      [
        'readConversationRecords',
        () => methods.readConversationRecords({ user: '', allOf: [['a']], limit: 1 }, READ),
      ],
      ['readMessageTexts', () => methods.readMessageTexts({ user: '', messageIds: ['m'] }, READ)],
      ['getSearchableMessages', () => methods.getSearchableMessages('', ['m'], READ)],
      ['getSearchHitConversations', () => methods.getSearchHitConversations('', ['c'], READ)],
    ])('%s throws a coded error with no user, before any read', async (_name, read) => {
      await expect(read()).rejects.toMatchObject({ code: 'search_failed' });
      expect(commands.filter(({ find }) => find != null)).toHaveLength(0);
    });
  });
});
