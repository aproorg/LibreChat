import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { buildIndexableQuery } from './mongoMeili';
import { isIndexableSource } from './indexable';
import { createModels } from '~/models';

const DAY_MS = 24 * 60 * 60 * 1000;
const UNSET = Symbol('unset');

type IndexableSource = {
  collection: { name: string };
  schema: Parameters<typeof buildIndexableQuery>[0];
};

const compact = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== UNSET));

/** Every combination of the stored fields the predicate and the query read. */
const buildRows = (excludePath: string): Record<string, unknown>[] => {
  const now = Date.now();
  const rows: Record<string, unknown>[] = [];
  for (const isTemporary of [UNSET, null, false, true]) {
    for (const expiredAt of [
      UNSET,
      null,
      new Date(now - DAY_MS),
      new Date(now + DAY_MS),
      'not a date',
    ]) {
      for (const unfinished of [UNSET, null, false, true]) {
        for (const excluded of [UNSET, null, { status: 'running' }]) {
          rows.push(
            compact({
              _id: new mongoose.Types.ObjectId(),
              user: 'user',
              isTemporary,
              expiredAt,
              unfinished,
              [excludePath]: excluded,
            }),
          );
        }
      }
    }
  }
  return rows;
};

describe('isIndexableSource', () => {
  describe('agreement with the plugin query on stored rows', () => {
    let server: MongoMemoryServer;
    let database: mongoose.Mongoose;
    let models: ReturnType<typeof createModels>;

    beforeAll(async () => {
      server = await MongoMemoryServer.create();
      database = new mongoose.Mongoose();
      database.set('autoCreate', false);
      database.set('autoIndex', false);
      await database.connect(server.getUri());
      models = createModels(database);
    });

    afterAll(async () => {
      await database.disconnect();
      await server.stop();
    });

    const findDisagreements = async (model: IndexableSource, excludePath: string) => {
      const rows = buildRows(excludePath);
      const collection = database.connection.db!.collection(model.collection.name);
      await collection.insertMany(rows as never[]);

      const query = {
        $and: [buildIndexableQuery(model.schema, excludePath), { unfinished: { $ne: true } }],
      } as Record<string, unknown>;
      const matched = await collection.find(query).project({ _id: 1 }).toArray();
      const matchedIds = new Set(matched.map(({ _id }) => String(_id)));
      const stored = await collection.find({}).toArray();

      expect(stored).toHaveLength(rows.length);
      expect(matchedIds.size).toBeGreaterThan(0);
      expect(matchedIds.size).toBeLessThan(rows.length);
      return stored.filter(
        (row) => isIndexableSource(row, excludePath) !== matchedIds.has(String(row._id)),
      );
    };

    it('agrees for messages, excluding subagent tasks', async () => {
      const source = models.Message as unknown as IndexableSource;
      expect(await findDisagreements(source, 'subagentTask')).toEqual([]);
    });

    it('agrees for conversations, excluding subagent threads', async () => {
      const source = models.Conversation as unknown as IndexableSource;
      expect(await findDisagreements(source, 'subagentThread')).toEqual([]);
    });
  });

  it('treats a present null temporary flag like a missing one', () => {
    expect(isIndexableSource({ isTemporary: null }, 'subagentTask')).toBe(true);
    expect(isIndexableSource({}, 'subagentTask')).toBe(true);
  });

  it('keeps an explicit non-temporary row until it expires', () => {
    const now = Date.now();
    expect(isIndexableSource({ isTemporary: false }, 'x')).toBe(true);
    expect(isIndexableSource({ isTemporary: false, expiredAt: new Date(now + DAY_MS) }, 'x')).toBe(
      true,
    );
    expect(isIndexableSource({ isTemporary: false, expiredAt: new Date(now - DAY_MS) }, 'x')).toBe(
      false,
    );
  });

  it('excludes temporary, legacy expiring, unfinished and excluded rows', () => {
    expect(isIndexableSource({ isTemporary: true }, 'x')).toBe(false);
    expect(isIndexableSource({ expiredAt: new Date(Date.now() + DAY_MS) }, 'x')).toBe(false);
    expect(isIndexableSource({ isTemporary: false, unfinished: true }, 'x')).toBe(false);
    expect(isIndexableSource({ isTemporary: false, subagentTask: {} }, 'subagentTask')).toBe(false);
  });

  it('reads a nested exclusion path', () => {
    expect(isIndexableSource({ a: { b: 1 } }, 'a.b')).toBe(false);
    expect(isIndexableSource({ a: {} }, 'a.b')).toBe(true);
  });

  it('applies no exclusion without a path', () => {
    expect(isIndexableSource({ subagentTask: {} })).toBe(true);
  });

  it('takes the current time as an argument', () => {
    const expiredAt = new Date(1000);
    expect(isIndexableSource({ isTemporary: false, expiredAt }, 'x', 999)).toBe(true);
    expect(isIndexableSource({ isTemporary: false, expiredAt }, 'x', 1000)).toBe(false);
  });

  it.each([
    [{}],
    [Object.create(null)],
    [{ isTemporary: 'false' }],
    [{ expiredAt: 'tomorrow', isTemporary: false }],
    [{ expiredAt: new Date('invalid'), isTemporary: false }],
    [{ $isDefault: 'not a function', isTemporary: false }],
    [{ $locals: null }],
  ])('never throws on the plain object %j', (doc) => {
    expect(() => isIndexableSource(doc, 'subagentTask')).not.toThrow();
  });

  it.each([[null], [undefined], ['text'], [1]])('treats %j as not indexable', (doc) => {
    expect(isIndexableSource(doc as never, 'subagentTask')).toBe(false);
  });
});
