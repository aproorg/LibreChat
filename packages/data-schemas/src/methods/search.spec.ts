import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { SearchMethods, SearchStreamBatch } from './search';
import type { SearchPort } from '~/types/search';
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

    it('leaves out rows holding an excluded token, beside every required word set', async () => {
      await insertRecord(USER, 'word', 'plain', new Date('2026-01-01'));
      await insertRecord(USER, 'word', 'excluded', new Date('2026-01-02'));
      await database.connection
        .db!.collection('msearch')
        .updateOne({ messageId: 'excluded' }, { $push: { tokens: 'earlier' } } as never);

      const rows = await methods.readRecordWindow(
        { user: USER, tokens: ['word'], allOf: [['shared']], noneOf: ['earlier'], limit: 10 },
        READ,
      );

      expect(rows.map(({ messageId }) => messageId)).toEqual(['plain']);
      expect(finds('msearch')[0].filter).toEqual({
        user: USER,
        tokens: 'word',
        $and: [{ tokens: { $in: ['shared'] } }, { tokens: { $nin: ['earlier'] } }],
      });
    });

    it('bounds its dates: at or below the anchor, below `before`, above `after`', async () => {
      for (const day of [1, 2, 3, 4, 5]) {
        await insertRecord(USER, 'word', `day-${day}`, new Date(Date.UTC(2026, 0, day)));
      }
      const day = (value: number) => new Date(Date.UTC(2026, 0, value));
      const read = (range: Parameters<SearchMethods['readRecordWindow']>[0]['range']) =>
        methods
          .readRecordWindow({ user: USER, tokens: ['word'], range, limit: 10 }, READ)
          .then((rows) => rows.map(({ messageId }) => messageId));

      expect(await read({ upTo: day(4) })).toEqual(['day-4', 'day-3', 'day-2', 'day-1']);
      expect(await read({ before: day(4) })).toEqual(['day-3', 'day-2', 'day-1']);
      expect(await read({ upTo: day(5), after: day(2) })).toEqual(['day-5', 'day-4', 'day-3']);
      expect(await read({ before: day(4), after: day(1) })).toEqual(['day-3', 'day-2']);
      expect(finds('msearch').every(({ hint }) => hint === 'user_tokens_created')).toBe(true);
    });
  });

  describe('readRecordTies', () => {
    const AT = new Date('2026-01-01T00:00:00Z');
    /** A record's `_id` is its source's ObjectId, which is what a tie read pages by. */
    const insertTie = async (user: string, messageId: string, createdAt: Date) => {
      const { insertedId } = await insertRecord(user, 'word', messageId, createdAt);
      return String(insertedId);
    };

    it('pages one date in `_id` order, and never another user or another date', async () => {
      const ids: string[] = [];
      for (const messageId of ['a', 'b', 'c', 'd']) {
        ids.push(await insertTie(USER, messageId, AT));
      }
      await insertTie(USER, 'other-date', new Date('2026-01-02T00:00:00Z'));
      await insertTie(OTHER, 'theirs', AT);

      const first = await methods.readRecordTies(
        { user: USER, tokens: ['word'], at: AT, limit: 3 },
        READ,
      );
      const second = await methods.readRecordTies(
        { user: USER, tokens: ['word'], at: AT, afterId: first[2]._id, limit: 3 },
        READ,
      );

      expect(first.map(({ _id }) => _id)).toEqual([...ids].sort().slice(0, 3));
      expect(second.map(({ _id }) => _id)).toEqual([...ids].sort().slice(3));
      expect(first[0]).not.toHaveProperty('tokens');
    });

    it('sends singleBatch, the limit, maxTimeMS, the index hint and an `_id` sort', async () => {
      await insertRecord(USER, 'word', 'one', AT);

      await methods.readRecordTies(
        { user: USER, tokens: ['word', 'other'], noneOf: ['earlier'], at: AT, limit: 5 },
        READ,
      );

      expect(finds('msearch')[0]).toMatchObject({
        filter: {
          user: USER,
          tokens: { $in: ['word', 'other'] },
          $and: [{ tokens: { $nin: ['earlier'] } }],
          createdAt: AT,
        },
        singleBatch: true,
        batchSize: 5 + DRIVER_BATCH_MARGIN,
        limit: 5,
        maxTimeMS: 5000,
        hint: 'user_tokens_created',
      });
      expect(finds('msearch')[0].sort).toEqual(new Map([['_id', 1]]));
      expect(commands.filter(({ getMore }) => getMore != null)).toHaveLength(0);
    });

    it('requires a user, and reads nothing for no tokens', async () => {
      await expect(
        methods.readRecordTies({ user: '', tokens: ['word'], at: AT, limit: 1 }, READ),
      ).rejects.toThrow();
      expect(
        await methods.readRecordTies({ user: USER, tokens: [], at: AT, limit: 1 }, READ),
      ).toEqual([]);
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
      /* The second chunk gets what is left of the same budget, never a fresh one. */
      expect(finds('msearch')[1].maxTimeMS).toBeLessThanOrEqual(5000);
    });

    it('stops before a later chunk once the time for the whole read is gone', async () => {
      const mine: string[] = [];
      for (let index = 0; index < 51; index += 1) {
        const { insertedId } = await insertRecord(USER, 'word', `m${index}`, new Date());
        mine.push(String(insertedId));
      }
      const find = jest.spyOn(database.models.MessageSearch, 'find').mockImplementationOnce(
        () =>
          ({
            lean: () => new Promise((resolve) => setTimeout(() => resolve([]), 60)),
          }) as never,
      );

      await expect(
        methods.readRecordTokens({ user: USER, ids: mine }, { maxTimeMS: 30 }),
      ).rejects.toMatchObject({ code: 'search_busy' });

      expect(find).toHaveBeenCalledTimes(1);
      find.mockRestore();
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

describe('search job methods', () => {
  let server: MongoMemoryServer;
  let database: mongoose.Mongoose;
  let methods: SearchMethods;

  const record = (id: string, e = 0, tenantId?: string) => ({
    _id: id,
    user: 'user-a',
    conversationId: 'convo-a',
    messageId: `m-${id}`,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    n: 1,
    h: `h-${e}`,
    v: 'v1',
    e,
    tokens: ['kerfi'],
    ...(tenantId ? { tenantId } : {}),
  });
  const ID_A = '000000000000000000000a01';
  const ID_B = '000000000000000000000a02';
  const collection = (name: string) => database.connection.db!.collection(name);

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    database = new mongoose.Mongoose();
    database.set('autoIndex', false);
    /* As `api/db/connect.js` sets it, which strips any filter field a schema does not declare. */
    database.set('strictQuery', true);
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
    await methods.ensureSearchCollections();
  });

  describe('lease', () => {
    const claim = (holder: string, offset = 30_000) => ({
      holder,
      until: new Date(Date.now() + offset),
      now: new Date(),
    });

    it('one holder at a time, however many ask at once', async () => {
      const results = await Promise.all(
        ['a', 'b', 'c'].map((h) => methods.acquireSearchLease(claim(h))),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.find(Boolean)).toEqual({ epoch: 1 });
    });

    it('an expired lease is taken over with a higher epoch, and the old holder cannot renew', async () => {
      await methods.acquireSearchLease(claim('a', -1000));

      expect(await methods.acquireSearchLease(claim('b'))).toEqual({ epoch: 2 });
      expect(
        await methods.renewSearchLease({
          holder: 'a',
          epoch: 1,
          until: new Date(Date.now() + 1000),
        }),
      ).toBe(false);
      expect(
        await methods.renewSearchLease({
          holder: 'b',
          epoch: 2,
          until: new Date(Date.now() + 1000),
        }),
      ).toBe(true);
    });

    it('a released lease is free at once, and its epoch never goes back', async () => {
      await methods.acquireSearchLease(claim('a'));
      await methods.releaseSearchLease({ holder: 'a', epoch: 1 });

      expect(await methods.acquireSearchLease(claim('b'))).toEqual({ epoch: 2 });
    });

    it('a stale holder cannot release the current lease', async () => {
      await methods.acquireSearchLease(claim('a', -1000));
      await methods.acquireSearchLease(claim('b'));
      await methods.releaseSearchLease({ holder: 'a', epoch: 1 });

      expect(await methods.acquireSearchLease(claim('c'))).toBeNull();
    });
  });

  describe('state', () => {
    it('merges fields and lists only job requests, oldest first', async () => {
      await methods.writeSearchState('chain', { step: 'backfill' });
      await methods.writeSearchState('chain', { requestId: 'r' });
      await methods.writeSearchState('jobRequest:b', { job: 'pause', requestedAt: new Date(2000) });
      await methods.writeSearchState('jobRequest:a', {
        job: 'resume',
        requestedAt: new Date(3000),
      });
      await methods.writeSearchState('jobRequestx', { job: 'not-one' });
      await methods.writeSearchState('jobRequest;', { job: 'not-one' });

      expect(await methods.readSearchState('chain', { maxTimeMS: 1000 })).toEqual({
        _id: 'chain',
        step: 'backfill',
        requestId: 'r',
      });
      const requests = await methods.listSearchJobRequests();
      expect(requests.map(({ _id }) => _id)).toEqual(['jobRequest:b', 'jobRequest:a']);

      await methods.deleteSearchState('jobRequest:b');
      expect(await methods.listSearchJobRequests()).toHaveLength(1);
    });

    it('says whether search_state exists, and creates nothing by asking', async () => {
      expect(await methods.searchStateExists()).toBe(true);
      await database.connection.db!.dropDatabase();
      expect(await methods.searchStateExists()).toBe(false);
      expect(await methods.searchStateExists()).toBe(false);
    });
  });

  describe('records', () => {
    it('insert keeps what is there, and a batch with a duplicate still writes the rest', async () => {
      await methods.insertSearchRecords('messages', [record(ID_A, 5)]);

      const result = await methods.insertSearchRecords('messages', [record(ID_A), record(ID_B)]);

      expect(result).toEqual({ written: 1, duplicates: 1 });
      expect(await collection('msearch').countDocuments()).toBe(2);
      expect(await collection('msearch').findOne({ h: 'h-5' })).not.toBeNull();
    });

    it('insert rethrows a failure that is not a duplicate', async () => {
      await expect(
        methods.insertSearchRecords('messages', [{ ...record(ID_A), user: undefined as never }]),
      ).rejects.toThrow();
    });

    it('replace is guarded by epoch, and a whole-document write keeps tenantId', async () => {
      await methods.replaceSearchRecords('messages', [record(ID_A, 3, 'tenant-one')]);

      const older = await methods.replaceSearchRecords('messages', [record(ID_A, 2, 'tenant-one')]);
      expect(older).toEqual({ written: 0, duplicates: 1 });
      expect(await collection('msearch').findOne({})).toMatchObject({
        e: 3,
        tenantId: 'tenant-one',
      });

      await methods.replaceSearchRecords('messages', [record(ID_A, 4, 'tenant-one')]);
      expect(await collection('msearch').findOne({})).toMatchObject({
        e: 4,
        tenantId: 'tenant-one',
      });
    });

    it('reads IDs and tokens in order within a range, and deletes by ID', async () => {
      await methods.insertSearchRecords('messages', [record(ID_B), record(ID_A)]);
      const params = { collection: 'messages' as const, limit: 10 };

      expect(await methods.readSearchRecordIds(params)).toEqual([ID_A, ID_B]);
      expect(await methods.readSearchRecordIds({ ...params, afterId: ID_A })).toEqual([ID_B]);
      expect(await methods.readSearchRecordIds({ ...params, upToId: ID_A })).toEqual([ID_A]);
      expect(await methods.readSearchRecordIdsIn('messages', [ID_B])).toEqual([ID_B]);
      expect(await methods.readSearchRecordTokenBatch({ ...params, afterId: ID_A })).toEqual([
        { _id: ID_B, tokens: ['kerfi'] },
      ]);

      expect(await methods.deleteSearchRecords('messages', [ID_A])).toBe(1);
      expect(await methods.deleteSearchRecords('messages', [])).toBe(0);
      expect(await methods.readSearchRecordIds(params)).toEqual([ID_B]);
    });
  });

  describe('sources', () => {
    const store = (rows: object[]) =>
      collection('messages').insertMany(
        rows.map((row) => ({
          user: 'user-a',
          conversationId: 'convo-a',
          createdAt: new Date(),
          ...row,
        })) as never[],
      );
    const objectId = (id: string) => new mongoose.Types.ObjectId(id);

    it('a walk never enters a row whose _id is not an ObjectId', async () => {
      await store([
        { _id: 'ext-1', messageId: 'outside' },
        { _id: objectId(ID_A), messageId: 'a' },
        { _id: objectId(ID_B), messageId: 'b' },
      ]);

      const first = await methods.readSearchSources({ collection: 'messages', limit: 1 });
      expect(first.map(({ _id }) => _id)).toEqual([ID_A]);
      const rest = await methods.readSearchSources({
        collection: 'messages',
        afterId: first[0]._id,
        limit: 5,
      });
      expect(rest.map(({ _id }) => _id)).toEqual([ID_B]);
    });

    it('a state read sees the select:false subagent field and holds no text', async () => {
      await store([
        {
          _id: objectId(ID_A),
          messageId: 'a',
          text: 'SENTINEL',
          subagentTask: { id: 'task' },
          contextMeta: 'SENTINEL',
        },
      ]);

      const [row] = await methods.readSearchSources({ collection: 'messages', limit: 5 });

      expect(row).toMatchObject({ _id: ID_A, subagentTask: { id: 'task' } });
      expect(JSON.stringify(row)).not.toContain('SENTINEL');
      const [byId] = await methods.readSearchSourcesById('messages', [ID_A]);
      expect(byId.subagentTask).toEqual({ id: 'task' });
    });

    it('a text read adds only canonical text fields', async () => {
      await store([
        {
          _id: objectId(ID_A),
          messageId: 'a',
          text: 'kept',
          contextMeta: 'SENTINEL',
          content: [{ type: 'text', text: 'part', tool_call: { output: 'SENTINEL' } }],
        },
      ]);

      const [row] = await methods.readSearchSources({
        collection: 'messages',
        limit: 5,
        withText: true,
      });

      expect(row).toMatchObject({ text: 'kept', content: [{ type: 'text', text: 'part' }] });
      expect(JSON.stringify(row)).not.toContain('SENTINEL');
    });

    it('pages by _id within a range, across tenants, and estimates a total', async () => {
      await store([
        { _id: objectId(ID_B), messageId: 'b', tenantId: 'tenant-two' },
        { _id: objectId(ID_A), messageId: 'a', tenantId: 'tenant-one' },
      ]);
      const params = { collection: 'messages' as const, limit: 1 };

      const first = await methods.readSearchSources(params);
      expect(first.map(({ _id }) => _id)).toEqual([ID_A]);
      const next = await methods.readSearchSources({ ...params, afterId: ID_A });
      expect(next.map(({ _id }) => _id)).toEqual([ID_B]);
      expect(await methods.readSearchSources({ ...params, afterId: ID_B })).toEqual([]);
      expect(await methods.readSearchSources({ ...params, limit: 5, upToId: ID_A })).toHaveLength(
        1,
      );
      expect(await methods.countSearchSources('messages')).toBe(2);
      expect((await methods.readSearchSourceTenants()).sort()).toEqual([
        'tenant-one',
        'tenant-two',
      ]);
    });
  });

  describe('word list', () => {
    it('adds to dfNext without touching df, then settles', async () => {
      await collection('search_vocab').insertOne({ _id: 'old', df: 7 } as never);

      await methods.incrementSearchVocabNext({
        counts: [
          ['old', 2],
          ['new', 1],
        ],
        run: 3,
      });
      await methods.incrementSearchVocabNext({ counts: [['old', 1]], run: 3 });

      const rows = await methods.readSearchVocabBatch({ limit: 10 });
      expect(rows).toEqual([
        { token: 'new', df: 0, dfNext: 1, r: 3 },
        { token: 'old', df: 7, dfNext: 3, r: 3 },
      ]);
      expect(await methods.readSearchVocabBatch({ afterId: 'new', limit: 10 })).toHaveLength(1);

      await collection('search_vocab').insertMany([
        { _id: 'gone', df: 4, r: 2 },
        { _id: 'never', df: 5 },
        { _id: 'writer', df: 1, r: 3 },
        { _id: 'zlater', df: 6 },
      ] as never[]);

      await methods.settleSearchVocab({
        copy: [
          { token: 'new', df: 1 },
          { token: 'old', df: 3 },
        ],
        range: { upToId: 'writer' },
        run: 3,
      });

      expect(await methods.readSearchVocabBatch({ limit: 10 })).toEqual([
        { token: 'new', df: 1, r: 3 },
        { token: 'old', df: 3, r: 3 },
        { token: 'writer', df: 1, r: 3 },
        { token: 'zlater', df: 6 },
      ]);
    });

    it('settles only inside its range, in one write', async () => {
      await collection('search_vocab').insertMany([
        { _id: 'a', df: 1 },
        { _id: 'b', df: 1 },
        { _id: 'c', df: 1 },
      ] as never[]);
      const bulkWrite = jest.spyOn(database.models.SearchVocab, 'bulkWrite');

      await methods.settleSearchVocab({ copy: [], range: { afterId: 'a', upToId: 'b' }, run: 1 });

      expect(bulkWrite).toHaveBeenCalledTimes(1);
      expect(bulkWrite.mock.calls[0][1]).toMatchObject({ ordered: false });
      expect((await methods.readSearchVocabBatch({ limit: 10 })).map(({ token }) => token)).toEqual(
        ['a', 'c'],
      );
      bulkWrite.mockRestore();
    });
  });

  describe('dropSearchCollections', () => {
    it('removes the four search collections and leaves every other one', async () => {
      await methods.ensureSearchCollections();
      await collection('messages').insertOne({ messageId: 'kept' } as never);
      await collection('search_other').insertOne({ kept: true } as never);

      expect((await methods.dropSearchCollections()).sort()).toEqual(
        [...SEARCH_COLLECTIONS].sort(),
      );

      const names = (await database.connection.db!.listCollections().toArray()).map(
        ({ name }) => name,
      );
      expect(names).toEqual(expect.arrayContaining(['messages', 'search_other']));
      for (const name of SEARCH_COLLECTIONS) {
        expect(names).not.toContain(name);
      }
      expect(await collection('messages').countDocuments()).toBe(1);
    });

    it('answers nothing when no search collection exists, creating none', async () => {
      await methods.dropSearchCollections();

      expect(await methods.dropSearchCollections()).toEqual([]);

      const names = (await database.connection.db!.listCollections().toArray()).map(
        ({ name }) => name,
      );
      for (const name of SEARCH_COLLECTIONS) {
        expect(names).not.toContain(name);
      }
    });
  });
});

describe('watchSearchSources batches', () => {
  let server: MongoMemoryServer;
  let database: mongoose.Mongoose;
  let methods: SearchMethods;
  let abort: AbortController;

  const change = (at: Date | null) => {
    const _id = new mongoose.Types.ObjectId();
    return {
      operationType: 'insert',
      ns: { coll: 'messages' },
      documentKey: { _id },
      fullDocument: { _id, messageId: String(_id) },
      ...(at ? { wallTime: at } : {}),
    };
  };

  /** A change stream whose `tryNext` is scripted, so batching is tested without a server. */
  const streamOf = (tryNext: () => Promise<unknown>) =>
    jest.spyOn(database.connection.db!, 'watch').mockReturnValue({
      tryNext,
      close: async () => undefined,
      resumeToken: { _data: 'token' },
    } as never);

  const firstBatch = async (): Promise<SearchStreamBatch> => {
    const batches = methods.watchSearchSources({ resumeToken: null, signal: abort.signal });
    const { value } = await batches.next();
    abort.abort();
    await batches.return(undefined);
    if (!value) {
      throw new Error('The stream ended before its first batch');
    }
    return value;
  };

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    database = new mongoose.Mongoose();
    await database.connect(server.getUri());
    createModels(database);
    methods = createSearchMethods(database);
  });

  afterAll(async () => {
    await database.disconnect();
    await server.stop();
  });

  beforeEach(() => {
    abort = new AbortController();
  });

  it('closes a batch under steady traffic, and promises catch-up to its last change', async () => {
    const times: Date[] = [];
    streamOf(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      times.push(new Date(Date.UTC(2026, 0, 1) + times.length * 1000));
      return change(times[times.length - 1]);
    });

    const batch = await firstBatch();

    /* A change every 10 ms never leaves a quiet moment, and 500 of them would take 5 s. */
    expect(batch.events.length).toBeGreaterThan(0);
    expect(batch.events.length).toBeLessThan(500);
    expect(batch.caughtUpTo).toBe(times[batch.events.length - 1].getTime());
    expect(batch.position).toEqual({ scope: 'database', tokens: { database: { _data: 'token' } } });
  });

  it('ignores a change to a row whose _id is not an ObjectId', async () => {
    const pending = [
      { ...change(new Date(Date.UTC(2026, 0, 1))), documentKey: { _id: 'ext-1' } },
      change(new Date(Date.UTC(2026, 0, 1))),
    ];
    streamOf(async () => pending.shift() ?? null);

    const batch = await firstBatch();

    expect(batch.events.map(({ type }) => type)).toEqual(['ignored', 'upsert']);
  });

  it('promises nothing from such a batch when its changes carry no server time', async () => {
    streamOf(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return change(null);
    });

    const batch = await firstBatch();

    expect(batch.events.length).toBeGreaterThan(0);
    expect(batch.caughtUpTo).toBeNull();
  });

  it('promises catch-up to the start of the read once the server has nothing more', async () => {
    const before = Date.now();
    const pending = [change(new Date(Date.UTC(2026, 0, 1)))];
    streamOf(async () => pending.shift() ?? null);

    const batch = await firstBatch();

    expect(batch.events).toHaveLength(1);
    expect(batch.caughtUpTo).toBeGreaterThanOrEqual(before);
    expect(batch.caughtUpTo).toBeLessThanOrEqual(Date.now());
  });
});
