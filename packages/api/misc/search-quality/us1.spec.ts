import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { ConditionRow, QualityManifest } from './conditions';
import type { Analyzer } from '~/search/analyzer/analyze';
import type { QualityDatabase } from './database';
import { loadSearchRecords } from '~/search/__tests__/helpers/loader';
import { computeAnalyzerVersion } from '~/search/analyzer/version';
import { loadCondition, readQualityJson } from './conditions';
import { requireQualityEnv } from './env';
import { connectQualityDatabase } from './database';
import { loadQualityAnalyzer } from './analyzer';
import { rankedMessageIds } from './reads';

const USER = 'us1-user';
const SIDEBAR_LIMITS = [200, 1000];
const FIRST_PAGE = 25;
/** Crowds the page, so a miss on tier or rank shows. It uses none of the words searched. */
const PADDING_MESSAGES = 60;

/**
 * US1's scenarios on a small fixture with the real `is` pack. Needs only the language
 * data. It proves routing and ranking on these words, not SC-001's padded-corpus numbers.
 */
describe('US1 scenarios on a small fixture', () => {
  let server: MongoMemoryServer;
  let database: mongoose.Mongoose;
  let analyzer: Analyzer;
  let methods: ReturnType<typeof createMethods>;

  const message = (messageId: string, text: string, createdAt = '2026-01-01') => ({
    _id: new mongoose.Types.ObjectId().toString(),
    user: USER,
    conversationId: `convo-${messageId}`,
    messageId,
    text,
    createdAt: new Date(createdAt),
  });

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    database = new mongoose.Mongoose();
    await database.connect(server.getUri());
    const models = createModels(database);
    methods = createMethods(database);
    await methods.ensureSearchCollections();
    await methods.ensureSearchIndexes();
    analyzer = await loadQualityAnalyzer(requireQualityEnv('SEARCH_LANGUAGE_DATA_DIR'));
    await loadSearchRecords(models, {
      analyzer,
      version: computeAnalyzerVersion(analyzer.packs),
      messages: [
        message('hestinum', 'Hann gaf hestinum hey'),
        message('tekjuskattur', 'Reikna þarf tekjuskattur af laununum', '2026-06-01'),
        message('skattur', 'Skattur er hár', '2025-01-01'),
        message('bornum', 'Við lásum fyrir börnum'),
        message('thjonustuver', 'Hringdu í þjónustuver bankans'),
        message('ver', 'Hann fór í ver við ströndina'),
        message('fyrirtaeki', 'Þetta fyrirtæki er gamalt'),
        message('tekur', 'Hún tekur bókina með sér'),
        ...Array.from({ length: PADDING_MESSAGES }, (_, index) =>
          message(`padding-${index}`, 'Veðrið var gott í dag og sólin skein'),
        ),
        { ...message('other-user', 'hestinum tekjuskattur börnum'), user: 'someone-else' },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await database?.disconnect();
    await server?.stop();
  });

  const search = (query: string, sidebarLimit = 200) =>
    rankedMessageIds(methods, analyzer, USER, query, sidebarLimit);

  describe.each(SIDEBAR_LIMITS)('through the shared read at limit %i', (limit) => {
    it.each([
      ['scenario 1: hestur reaches hestinum', 'hestur', 'hestinum'],
      ['scenario 2: skattur reaches tekjuskattur', 'skattur', 'tekjuskattur'],
      ['scenario 3: bornum reaches börnum', 'bornum', 'bornum'],
    ])('%s on the first page', async (_name, query, expected) => {
      const { firstPage, top } = await search(query, limit);
      expect(firstPage).toContain(expected);
      expect(firstPage.length).toBeLessThanOrEqual(FIRST_PAGE);
      expect(top).toContain(expected);
    });

    it('scenario 4: þjónustuver does not reach ver', async () => {
      const { firstPage, top } = await search('þjónustuver', limit);
      expect(firstPage).toContain('thjonustuver');
      expect(top).not.toContain('ver');
    });

    it('scenario 5: taka does not reach fyrirtæki', async () => {
      const { top } = await search('taka', limit);
      expect(top).toContain('tekur');
      expect(top).not.toContain('fyrirtaeki');
    });

    it('scenario 6: a compound-only match ranks below the word itself', async () => {
      const { firstPage } = await search('skattur', limit);
      expect(firstPage).toEqual(expect.arrayContaining(['skattur', 'tekjuskattur']));
      expect(firstPage.indexOf('skattur')).toBeLessThan(firstPage.indexOf('tekjuskattur'));
    });

    it('holds isolation in every query', async () => {
      for (const query of ['hestur', 'skattur', 'bornum']) {
        expect((await search(query, limit)).top).not.toContain('other-user');
      }
    });
  });
});

/** `SEARCH_QUALITY_DIR/us1-scenarios.json`, from T016: IDs chosen by reading the reference's tokens. */
interface Us1Scenarios {
  user: string;
  onFirstPage: Array<{ scenario: number; query: string; anyHolding: string[] }>;
  notMatched: Array<{ scenario: number; query: string; matched: string[]; notMatched: string[] }>;
  ranked: { scenario: number; query: string; direct: string[]; partOnly: string[] };
}

/**
 * What US1 owes on condition P, the padded corpus, where crowding is real. SC-001's
 * numbers need US2's tiers and stay with T076; `measure.spec.ts` reports them meanwhile.
 */
describe('US1 scenarios on the padded corpus', () => {
  let database: QualityDatabase;
  let analyzer: Analyzer;
  let scenarios: Us1Scenarios;
  let methods: ReturnType<typeof createMethods>;
  let rows: Map<string, ConditionRow>;

  beforeAll(async () => {
    scenarios = await readQualityJson<Us1Scenarios>('us1-scenarios.json');
    const manifest = await readQualityJson<QualityManifest>('queries.json');
    analyzer = await loadQualityAnalyzer(requireQualityEnv('SEARCH_LANGUAGE_DATA_DIR'));
    database = await connectQualityDatabase(
      requireQualityEnv('SEARCH_QUALITY_MONGO_URI'),
      'search_quality_us1',
    );
    methods = createMethods(database.connection);
    ({ rows } = await loadCondition(database, analyzer, manifest, 'P'));
  }, 1_800_000);

  afterAll(async () => {
    await database?.close();
  });

  const search = (query: string, limit: number) =>
    rankedMessageIds(methods, analyzer, scenarios.user, query, limit);

  describe.each(SIDEBAR_LIMITS)('through the shared read at limit %i', (limit) => {
    it('scenarios 1 to 3: every message holding the form is on the first page', async () => {
      expect(scenarios.onFirstPage.map(({ scenario }) => scenario)).toEqual([1, 2, 3]);
      for (const { query, anyHolding } of scenarios.onFirstPage) {
        expect(anyHolding.length).toBeGreaterThan(0);
        const { firstPage, top } = await search(query, limit);
        expect(firstPage.length).toBeLessThanOrEqual(FIRST_PAGE);
        expect(firstPage).toEqual(expect.arrayContaining(anyHolding));
        expect(top).toEqual(expect.arrayContaining(anyHolding));
      }
    });

    it('scenarios 4 and 5: a message without the word does not match', async () => {
      expect(scenarios.notMatched.map(({ scenario }) => scenario)).toEqual([4, 5]);
      for (const { query, matched, notMatched } of scenarios.notMatched) {
        expect(matched.length).toBeGreaterThan(0);
        expect(notMatched.length).toBeGreaterThan(0);
        const { top } = await search(query, limit);
        expect(top.length).toBeGreaterThan(0);
        expect(top.filter((id) => notMatched.includes(id))).toEqual([]);
        expect(top.filter((id) => !matched.includes(id))).toEqual([]);
      }
    });

    it('scenario 6: every compound-only match ranks below the word itself', async () => {
      const { query, direct, partOnly } = scenarios.ranked;
      expect(direct.length).toBeGreaterThan(0);
      expect(partOnly.length).toBeGreaterThan(0);
      const { top } = await search(query, limit);
      const ranks = (ids: string[]) => ids.map((id) => top.indexOf(id));
      expect(ranks(direct)).not.toContain(-1);
      expect(ranks(partOnly)).not.toContain(-1);
      expect(Math.max(...ranks(direct))).toBeLessThan(Math.min(...ranks(partOnly)));
    });

    it('holds isolation in these queries', async () => {
      const queries = [
        ...scenarios.onFirstPage.map(({ query }) => query),
        ...scenarios.notMatched.map(({ query }) => query),
      ];
      for (const query of queries) {
        const { top } = await search(query, limit);
        expect(
          top.filter((id) => rows.get(id)?.user !== scenarios.user || !rows.get(id)?.indexable),
        ).toEqual([]);
      }
    });
  });
});
