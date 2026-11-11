import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Types } from 'mongoose';
import { createMethods } from '@librechat/data-schemas';
import type { MessageSearchRecord } from '@librechat/data-schemas';
import type { QualityCondition, QualityManifest } from './conditions';
import type { Analyzer } from '~/search/analyzer/analyze';
import type { SearchCursor } from '~/search/read/cursor';
import type { FrozenPlan } from '~/search/read/plan';
import type { QualityDatabase } from './database';
import { createReadGate, createReadRunner } from '~/search/read/retry';
import { firstCursor, walkPage } from '~/search/read/page';
import { loadCondition, readQualityJson } from './conditions';
import { analyzeQuery } from '~/search/analyzer/query';
import { createSearchMetrics } from '~/search/metrics';
import { readSearchPlan } from '~/search/read/plan';
import { derivePage } from '~/search/read/window';
import { requireQualityEnv } from './env';
import { connectQualityDatabase } from './database';
import { loadQualityAnalyzer } from './analyzer';
import { rankedMessageIds } from './reads';

const PAGE = 25;
const RANK_WINDOW = 200;
const READ_CONCURRENCY = 2;
const SINGLE_WORD_QUERIES = 8;
const PREFIX_BUDGET = { maxCommonReads: 4, maxRareTokens: 200, maxVocabRows: 50_000 };
const TYPO_BUDGET = { maxCorrections: 8, maxVocabRows: 50_000 };
const quiet = { info: () => undefined, warn: () => undefined };

interface Paged {
  ids: string[];
  pages: number;
  anchor: number;
  /** The plan as the last page left it, with any expansion the walk froze. */
  plan: FrozenPlan;
}

/**
 * Load-more on the padded corpus (R-07's test): every match reached once, against a deep
 * read made without the plan, with and without writes and a word list flush between
 * pages. It also records how far the concatenated pages differ from the ranked read,
 * which is a guard and not a gate (R-13). Results go out of tree, as a row names a query.
 */
describe('load-more on the padded corpus', () => {
  let database: QualityDatabase;
  let analyzer: Analyzer;
  let manifest: QualityManifest;
  let condition: QualityCondition;
  let methods: ReturnType<typeof createMethods>;

  const runner = () =>
    createReadRunner({
      surface: 'messages',
      signal: new AbortController().signal,
      deadline: Date.now() + 120_000,
      gate: createReadGate(READ_CONCURRENCY),
      metrics: createSearchMetrics(quiet),
      logger: quiet,
    });

  const collection = () =>
    database.connection.connection.db!.collection<MessageSearchRecord>('msearch');

  /** Proximity text for the few rows that need it: only records are loaded. */
  const texts = new Map<string, string>();
  const reads = () => ({
    ...methods,
    readMessageTexts: async ({ messageIds }: { messageIds: readonly string[] }) =>
      messageIds.map((messageId) => ({ messageId, text: texts.get(messageId) ?? '' })),
  });

  const paginate = async (query: string, between?: () => Promise<void>): Promise<Paged | null> => {
    const analyzed = analyzeQuery(analyzer, query, { queryWordLimit: 10 });
    if (analyzed.status !== 'ok') {
      return null;
    }
    const run = runner();
    const read = await readSearchPlan({
      user: condition.user,
      words: analyzed.words,
      need: PAGE,
      window: RANK_WINDOW,
      readConcurrency: READ_CONCURRENCY,
      methods,
      run,
      prefix: PREFIX_BUDGET,
      typo: TYPO_BUDGET,
    });
    const { hits, more } = await derivePage(
      read,
      { limit: PAGE, rankWindow: RANK_WINDOW, lengthBucket: true },
      { user: condition.user, run, methods: reads(), analyzer },
    );
    const ids = hits.map(({ _id }) => _id);
    let plan = read.plan;
    let pages = 1;
    await between?.();
    for (let cursor: SearchCursor | null = more ? firstCursor(read, hits) : null; cursor; ) {
      if (pages > 5000) {
        throw new Error('The walk did not end');
      }
      const walked = await walkPage({
        user: condition.user,
        cursor,
        pageSize: PAGE,
        rankWindow: RANK_WINDOW,
        lengthBucket: true,
        prefix: PREFIX_BUDGET,
        run: runner(),
        methods,
      });
      ids.push(...walked.rows.map(({ _id }) => _id));
      plan = walked.cursor?.plan ?? plan;
      cursor = walked.cursor;
      pages += 1;
    }
    return { ids, pages, anchor: read.startedAt, plan };
  };

  /** Every record the first word reaches at any tier: the union over word sets (R-07). */
  const deepRead = async ({ plan, anchor }: Pick<Paged, 'plan' | 'anchor'>): Promise<string[]> => {
    const { exact, lemmas, parts, prefix, typos } = plan.words[0];
    const tokens = [
      exact,
      ...lemmas,
      ...parts,
      ...(plan.words.length === 1 ? (prefix ?? []) : []),
      ...(typos ?? []),
    ];
    const rows = await collection()
      .find({
        user: condition.user,
        tokens: { $in: tokens },
        createdAt: { $lte: new Date(anchor) },
      })
      .project<{ _id: string }>({ _id: 1 })
      .toArray();
    return rows.map(({ _id }) => String(_id));
  };

  const compare = (paged: Paged, deep: readonly string[]) => {
    const seen = new Set(paged.ids);
    const expected = new Set(deep);
    return {
      pages: paged.pages,
      seen: seen.size,
      deep: deep.length,
      dupes: paged.ids.length - seen.size,
      missing: deep.filter((id) => !seen.has(id)).length,
      extra: paged.ids.filter((id) => !expected.has(id)).length,
    };
  };

  const queries = () => [
    ...manifest.queries.filter(({ words }) => words === 1).slice(0, SINGLE_WORD_QUERIES),
    ...manifest.queries.filter(({ words }) => words > 1),
  ];

  beforeAll(async () => {
    manifest = await readQualityJson<QualityManifest>('queries.json');
    analyzer = await loadQualityAnalyzer(requireQualityEnv('SEARCH_LANGUAGE_DATA_DIR'));
    database = await connectQualityDatabase(
      requireQualityEnv('SEARCH_QUALITY_MONGO_URI'),
      'search_quality_paging',
    );
    methods = createMethods(database.connection);
    const loaded = await loadCondition(database, analyzer, manifest, 'P');
    condition = loaded.condition;
    for (const [messageId, { text }] of loaded.rows) {
      texts.set(messageId, text);
    }
  }, 1_800_000);

  afterAll(async () => {
    await database?.close();
  });

  it('reaches every match once, for single and multi-word queries', async () => {
    const rows = [];
    for (const { query, words } of queries()) {
      const paged = await paginate(query);
      if (!paged) {
        continue;
      }
      const ranked = await rankedMessageIds(reads(), analyzer, condition.user, query, RANK_WINDOW);
      const firstPages = new Set(paged.ids.slice(0, RANK_WINDOW));
      rows.push({
        query,
        words,
        ...compare(paged, await deepRead(paged)),
        /* The guard: load-more's order is not the ranked read's, and this says by how much. */
        rankedTopInFirstPages: ranked.top.filter((id) => firstPages.has(id)).length,
        rankedTop: ranked.top.length,
      });
    }
    const dir = join(requireQualityEnv('SEARCH_QUALITY_DIR'), 'results');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'paging-P.json'), JSON.stringify(rows, null, 1));

    expect(rows.length).toBeGreaterThan(SINGLE_WORD_QUERIES);
    expect(rows.filter(({ pages }) => pages > 2).length).toBeGreaterThan(0);
    expect(rows.filter(({ dupes, missing, extra }) => dupes + missing + extra > 0)).toEqual([]);
  }, 3_600_000);

  it('holds through a write above the anchor, one below it, and a word list flush', async () => {
    const failures = [];
    let checked = 0;
    for (const { query } of queries()) {
      const before = await paginate(query);
      if (!before || before.pages < 2) {
        continue;
      }
      const original = await deepRead(before);
      /* Records keep their source's ObjectId, which the plain record type states as a string. */
      const records = database.connection.connection.db!.collection('msearch');
      const sample = await records.findOne({ _id: new Types.ObjectId(original[0]) } as never);
      if (!sample) {
        throw new Error('A record of the deep read is gone');
      }
      const above = new Types.ObjectId();
      const below = new Types.ObjectId();
      const copies = [
        {
          ...sample,
          _id: above,
          messageId: 'paging-above',
          createdAt: new Date(Date.now() + 86_400_000),
        },
        { ...sample, _id: below, messageId: 'paging-below' },
      ];
      const flushed = before.plan.words.map(({ exact }) => exact);
      try {
        const paged = await paginate(query, async () => {
          await records.insertMany(copies as never[]);
          await database.models.SearchVocab.updateMany(
            { _id: { $in: flushed } },
            { $inc: { df: 100_000 } },
          );
        });
        if (!paged) {
          continue;
        }
        checked += 1;
        const seen = new Set(paged.ids);
        const result = {
          query,
          dupes: paged.ids.length - seen.size,
          missing: original.filter((id) => !seen.has(id)).length,
          leakedAbove: seen.has(String(above)),
        };
        if (result.dupes > 0 || result.missing > 0 || result.leakedAbove) {
          failures.push(result);
        }
      } finally {
        await records.deleteMany({ _id: { $in: [above, below] } } as never);
        await database.models.SearchVocab.updateMany(
          { _id: { $in: flushed } },
          { $inc: { df: -100_000 } },
        );
      }
    }

    expect(checked).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  }, 3_600_000);
});
