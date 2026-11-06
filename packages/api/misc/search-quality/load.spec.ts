import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createAnalyzer } from '~/search/analyzer/analyze';
import { createEnPack } from '~/search/languages/en';
import { connectQualityDatabase, loadQualityCorpus } from './database';
import { corpusConversations, corpusMessages } from './corpus';
import { requireQualityEnv } from './env';

const lines = (rows: object[]): Buffer =>
  gzipSync(rows.map((row) => JSON.stringify(row)).join('\n'));

/** The load path over a tiny invented corpus shaped like `gen.mjs`'s, in a database of its own. */
describe('loading a corpus for the quality suite', () => {
  it('loads sample users, taking the word list from the file, with indexes built', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'search-corpus-'));
    const base = { conversationId: 'c1', createdAt: 1_700_000_000_000, isTemporary: false };
    await writeFile(
      join(dir, 'messages-0000.ndjson.gz'),
      lines([
        { ...base, messageId: 'm1', user: 'sample', text: 'running dashboards', _indexable: true },
        { ...base, messageId: 'm2', user: 'other', text: 'running', _indexable: true },
        {
          ...base,
          messageId: 'm3',
          user: 'sample',
          text: 'hidden',
          isTemporary: true,
          _indexable: false,
        },
      ]),
    );
    await writeFile(
      join(dir, 'convos-0000.ndjson.gz'),
      lines([{ conversationId: 'c1', user: 'sample', title: 'plans', tags: [] }]),
    );
    const vocabFile = join(dir, 'vocab.ndjson.gz');
    await writeFile(vocabFile, lines([{ t: 'corpuswide', df: 1000 }]));

    const en = createEnPack();
    await en.load?.();
    const analyzer = createAnalyzer({ packs: [en], cacheWords: 100 });
    const database = await connectQualityDatabase(
      requireQualityEnv('SEARCH_QUALITY_MONGO_URI'),
      'search_quality_load',
    );

    try {
      const loaded = await loadQualityCorpus(database, {
        analyzer,
        messages: corpusMessages(dir),
        conversations: corpusConversations(dir),
        vocabFile,
        users: new Set(['sample']),
      });

      expect(loaded).toEqual({ messages: 1, conversations: 1, vocab: 1 });
      expect((await database.models.SearchVocab.findById('corpuswide').lean())?.df).toBe(1000);
      const indexes = await database.models.MessageSearch.collection.indexes();
      expect(indexes.map(({ name }) => name)).toContain('user_tokens_created');
    } finally {
      await database.connection.connection.dropDatabase();
      await database.close();
      await rm(dir, { recursive: true });
    }
  });
});
