import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { SearchContext, SearchPort, SearchPortMatches } from '~/types/search';
import { createConversationMethods } from './conversation';
import { SearchError } from '~/utils/searchError';
import { createModels } from '~/models';

/** The search seam in `getConvosByCursor`. Today's path has its own tests in `conversation.*`. */
describe('getConvosByCursor search port', () => {
  const USER = 'user-a';
  const context: SearchContext = {
    user: USER,
    signal: new AbortController().signal,
    startedAt: Date.now(),
  };

  let server: MongoMemoryServer;
  let database: mongoose.Mongoose;
  let answer: () => Promise<SearchPortMatches | null>;
  let conversationMatches: jest.Mock;
  let searchMessages: jest.Mock;
  let meiliSearch: jest.Mock;
  let methods: ReturnType<typeof createConversationMethods>;

  const insertConvo = (conversationId: string, updatedAt: Date, fields = {}) =>
    database.connection.db!.collection('conversations').insertOne({
      _id: new database.Types.ObjectId(),
      user: USER,
      conversationId,
      title: conversationId,
      updatedAt,
      createdAt: updatedAt,
      ...fields,
    } as never);

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    database = new mongoose.Mongoose();
    await database.connect(server.getUri());
    createModels(database);
  });

  afterAll(async () => {
    await database.disconnect();
    await server.stop();
  });

  beforeEach(async () => {
    await database.connection.db!.collection('conversations').deleteMany({});
    answer = async () => null;
    conversationMatches = jest.fn(() => answer());
    const port: SearchPort = {
      conversationMatches,
      titleMatches: jest.fn(async () => null),
    };
    searchMessages = jest.fn(async () => ({ hits: [] }));
    meiliSearch = jest.fn(async () => ({ hits: [] }));
    (database.models.Conversation as unknown as { meiliSearch: jest.Mock }).meiliSearch =
      meiliSearch;
    methods = createConversationMethods(database, {
      searchMessages,
      getSearchPort: () => port,
    } as never);
  });

  it('narrows to the matches, sorted by last update, under the existing filters', async () => {
    await insertConvo('older', new Date('2026-01-01'));
    await insertConvo('newer', new Date('2026-02-01'));
    await insertConvo('unmatched', new Date('2026-03-01'));
    await insertConvo('archived', new Date('2026-04-01'), { isArchived: true });
    answer = async () => ({ conversationIds: ['older', 'newer', 'archived'] });

    const result = await methods.getConvosByCursor(USER, {
      search: 'word',
      searchContext: context,
    });

    expect(result.conversations.map(({ conversationId }) => conversationId)).toEqual([
      'newer',
      'older',
    ]);
    expect(conversationMatches).toHaveBeenCalledWith(context, 'word');
    expect(meiliSearch).not.toHaveBeenCalled();
    expect(searchMessages).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('partial');
    expect(result).not.toHaveProperty('reason');
  });

  it('never shows another user a match', async () => {
    await insertConvo('theirs', new Date(), { user: 'user-b' });
    answer = async () => ({ conversationIds: ['theirs'] });

    const result = await methods.getConvosByCursor(USER, {
      search: 'word',
      searchContext: context,
    });

    expect(result.conversations).toEqual([]);
  });

  it('passes partial and reason through', async () => {
    await insertConvo('title', new Date());
    answer = async () => ({ conversationIds: ['title'], partial: true });
    expect(
      await methods.getConvosByCursor(USER, { search: 'word', searchContext: context }),
    ).toMatchObject({ partial: true, conversations: [expect.anything()] });

    answer = async () => ({ conversationIds: [], reason: 'only_stop_words' });
    expect(
      await methods.getConvosByCursor(USER, { search: 'the', searchContext: context }),
    ).toEqual({ conversations: [], nextCursor: null, reason: 'only_stop_words' });

    answer = async () => ({ conversationIds: [], partial: true });
    expect(
      await methods.getConvosByCursor(USER, { search: 'word', searchContext: context }),
    ).toEqual({ conversations: [], nextCursor: null, partial: true });
  });

  it('rethrows a SearchError from the search catch', async () => {
    answer = async () => {
      throw new SearchError('search_busy');
    };
    await expect(
      methods.getConvosByCursor(USER, { search: 'word', searchContext: context }),
    ).rejects.toMatchObject({ name: 'SearchError', code: 'search_busy' });
  });

  it('still rewraps any other error, as today', async () => {
    answer = async () => {
      throw new Error('raw detail');
    };
    await expect(
      methods.getConvosByCursor(USER, { search: 'word', searchContext: context }),
    ).rejects.toThrow('Error during meiliSearch');
  });

  it('runs today code on a null answer, and adds no field', async () => {
    await insertConvo('hit', new Date());
    meiliSearch.mockResolvedValue({ hits: [{ conversationId: 'hit' }] });

    const result = await methods.getConvosByCursor(USER, {
      search: 'word',
      searchContext: context,
    });

    expect(meiliSearch).toHaveBeenCalled();
    expect(searchMessages).toHaveBeenCalled();
    expect(Object.keys(result).sort()).toEqual(['conversations', 'nextCursor']);
  });

  it('never asks the port without a search context', async () => {
    meiliSearch.mockResolvedValue({ hits: [] });
    await methods.getConvosByCursor(USER, { search: 'word' });
    expect(conversationMatches).not.toHaveBeenCalled();
    expect(meiliSearch).toHaveBeenCalled();
  });
});
