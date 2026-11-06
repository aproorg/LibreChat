import mongoose from 'mongoose';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createModels } from '@librechat/data-schemas';
import { ContentTypes } from 'librechat-data-provider';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createFakeDictionaryPack } from '../languages/__tests__/helpers/fakeDictionary';
import { buildConversationRecord, buildMessageRecord } from './record';
import { loadSearchRecords } from '../__tests__/helpers/loader';
import { computeAnalyzerVersion } from '../analyzer/version';
import { createAnalyzer } from '../analyzer/analyze';
import { createEnPack } from '../languages/en';

const SENTINEL = 'sentinelhidden';
const VERSION = 'version-1';

const build = async () => {
  const fake = createFakeDictionaryPack();
  const en = createEnPack();
  await Promise.all([fake.load?.(), en.load?.()]);
  return createAnalyzer({ packs: [fake, en], cacheWords: 100 });
};

const message = (fields: Record<string, unknown> = {}) => ({
  _id: new mongoose.Types.ObjectId('65a000000000000000000001'),
  messageId: 'message-1',
  user: 'user-1',
  conversationId: 'conversation-1',
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  sender: SENTINEL,
  text: 'blorgum running',
  isTemporary: false,
  ...fields,
});

const conversation = (fields: Record<string, unknown> = {}) => ({
  _id: new mongoose.Types.ObjectId('65a000000000000000000002'),
  conversationId: 'conversation-1',
  user: 'user-1',
  title: 'blorgum plans',
  tags: ['running'],
  isTemporary: false,
  ...fields,
});

describe('buildMessageRecord', () => {
  it('builds a record of tokens, holding no text', async () => {
    const analyzer = await build();
    const record = buildMessageRecord(message({ tenantId: 'tenant-1' }), {
      analyzer,
      version: VERSION,
    });

    expect(record).toEqual({
      _id: '65a000000000000000000001',
      user: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      n: 4,
      h: expect.stringMatching(/^[0-9a-f]+$/),
      v: VERSION,
      e: 0,
      tokens: ['blorgum', 'blorg', 'running', 'run'],
      tenantId: 'tenant-1',
    });
    expect(JSON.stringify(record)).not.toContain('blorgum running');
  });

  it('carries the writer epoch and leaves tenantId off when the source has none', async () => {
    const analyzer = await build();
    const record = buildMessageRecord(message(), { analyzer, version: VERSION, epoch: 7 });

    expect(record?.e).toBe(7);
    expect(record).not.toHaveProperty('tenantId');
  });

  it('matches nothing on sender, user or ID fields', async () => {
    const analyzer = await build();
    const record = buildMessageRecord(
      message({
        sender: 'sendertoken',
        user: 'usertoken',
        conversationId: 'convotoken',
        messageId: 'messagetoken',
      }),
      { analyzer, version: VERSION },
    );

    expect(record?.tokens).toEqual(['blorgum', 'blorg', 'running', 'run']);
  });

  it('keeps context and tool output out of tokens, and thinking and steer text in', async () => {
    const analyzer = await build();
    const record = buildMessageRecord(
      message({
        contextMeta: { note: SENTINEL },
        content: [
          { type: ContentTypes.THINK, think: 'thinkword' },
          { type: ContentTypes.STEER, steer: 'steerword' },
          { type: ContentTypes.TOOL_CALL, tool_call: { name: 'x', output: SENTINEL } },
        ],
      }),
      { analyzer, version: VERSION },
    );

    expect(record?.tokens).toEqual(expect.arrayContaining(['thinkword', 'steerword']));
    expect(record?.tokens.join(' ')).not.toContain(SENTINEL);
  });

  it.each([
    ['temporary', { isTemporary: true }],
    ['subagent', { subagentTask: { parentRunId: 'run-1' } }],
    ['unfinished', { unfinished: true }],
    ['expired', { isTemporary: false, expiredAt: new Date(1000) }],
  ])('builds no record for a %s message', async (_kind, fields) => {
    const analyzer = await build();

    expect(buildMessageRecord(message(fields), { analyzer, version: VERSION })).toBeNull();
  });
});

describe('buildConversationRecord', () => {
  it('builds tokens from title and tags', async () => {
    const analyzer = await build();
    const record = buildConversationRecord(conversation(), { analyzer, version: VERSION });

    expect(record).toEqual({
      _id: '65a000000000000000000002',
      user: 'user-1',
      conversationId: 'conversation-1',
      h: expect.any(String),
      v: VERSION,
      e: 0,
      tokens: expect.arrayContaining(['blorgum', 'blorg', 'plans', 'plan', 'running', 'run']),
    });
  });

  it('builds no record for a temporary or subagent conversation', async () => {
    const analyzer = await build();
    const options = { analyzer, version: VERSION };

    expect(buildConversationRecord(conversation({ isTemporary: true }), options)).toBeNull();
    expect(
      buildConversationRecord(conversation({ subagentThread: { parentRunId: 'x' } }), options),
    ).toBeNull();
  });
});

describe('loadSearchRecords', () => {
  let server: MongoMemoryServer;
  let database: mongoose.Mongoose;
  let models: ReturnType<typeof createModels>;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    database = new mongoose.Mongoose();
    await database.connect(server.getUri());
    models = createModels(database);
  });

  afterAll(async () => {
    await database.disconnect();
    await server.stop();
  });

  beforeEach(async () => {
    await database.connection.db!.dropDatabase();
  });

  it('loads records and seeds the word list from them by default', async () => {
    const analyzer = await build();

    const loaded = await loadSearchRecords(models, {
      analyzer,
      version: VERSION,
      messages: [
        message(),
        message({ _id: new mongoose.Types.ObjectId(), messageId: 'message-2', isTemporary: true }),
        message({
          _id: new mongoose.Types.ObjectId(),
          messageId: 'message-3',
          text: 'blorg',
        }),
      ],
      conversations: [conversation()],
    });

    expect(loaded).toMatchObject({ messages: 2, conversations: 1, vocab: expect.any(Number) });
    expect(await models.MessageSearch.countDocuments()).toBe(2);
    expect(await models.ConversationSearch.countDocuments()).toBe(1);
    const row = await models.SearchVocab.findById('blorg').lean();
    expect(row?.df).toBe(3);
  });

  it('seeds the word list from a named file instead, when given one', async () => {
    const analyzer = await build();
    const dir = await mkdtemp(join(tmpdir(), 'search-vocab-'));
    const vocabFile = join(dir, 'vocab.ndjson.gz');
    const lines = [
      { t: 'alpha', df: 9 },
      { t: '~beta', df: 2 },
    ].map((row) => JSON.stringify(row));
    await writeFile(vocabFile, gzipSync(lines.join('\n')));

    try {
      await loadSearchRecords(models, {
        analyzer,
        version: VERSION,
        messages: [message()],
        vocabFile,
      });
    } finally {
      await rm(dir, { recursive: true });
    }

    expect(await models.SearchVocab.countDocuments()).toBe(2);
    expect((await models.SearchVocab.findById('alpha').lean())?.df).toBe(9);
    expect(await models.SearchVocab.findById('blorg').lean()).toBeNull();
  });

  it('can seed a passed verification record', async () => {
    const analyzer = await build();
    await loadSearchRecords(models, {
      analyzer,
      version: VERSION,
      messages: [],
      verificationPassed: true,
    });

    const state = await models.SearchState.findById('verification').lean();
    expect(state).toMatchObject({ status: 'passed' });
  });

  it('seeds no verification record unless asked', async () => {
    const analyzer = await build();
    await loadSearchRecords(models, { analyzer, version: VERSION, messages: [] });

    expect(await models.SearchState.findById('verification').lean()).toBeNull();
  });

  it('stamps the analyzer version from the packs it is handed', async () => {
    const analyzer = await build();
    const version = computeAnalyzerVersion(analyzer.packs);
    await loadSearchRecords(models, { analyzer, version, messages: [message()] });

    expect((await models.MessageSearch.findOne().lean())?.v).toBe(version);
  });
});
