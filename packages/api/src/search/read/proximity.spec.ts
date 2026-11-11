import type { SearchHarness } from '../__tests__/helpers/harness';
import type { PlannedWord } from './plan';
import type { TieredRow } from './rank';
import { createSearchHarness, sourceMessage } from '../__tests__/helpers/harness';
import { NO_SPAN, readProximity, wordSpan } from './proximity';
import { createReadGate, createReadRunner } from './retry';
import { derivePage, SEARCH_PAGE_SIZE } from './window';
import { analyzeQuery } from '../analyzer/query';
import { readSearchPlan } from './plan';
import { rankHits } from './rank';

const BUDGETS = {
  prefix: { maxCommonReads: 4, maxRareTokens: 200, maxVocabRows: 50_000 },
  typo: { maxCorrections: 8, maxVocabRows: 50_000 },
};

describe('proximity', () => {
  let harness: SearchHarness;

  const at = (day: number) => new Date(Date.UTC(2026, 0, day));

  const planned = (query: string, extra: Partial<PlannedWord>[] = []): PlannedWord[] =>
    analyzeQuery(harness.analyzer, query, { queryWordLimit: 10 }).words.map(
      ({ exact, lemmas, parts }, index) => ({
        exact,
        lemmas,
        parts,
        df: 1,
        partDf: 0,
        ...extra[index],
      }),
    );

  const span = (text: string, query: string, extra?: Partial<PlannedWord>[]) =>
    wordSpan(text, planned(query, extra), harness.analyzer);

  const runner = () =>
    createReadRunner({
      surface: 'messages',
      signal: new AbortController().signal,
      deadline: Date.now() + 10_000,
      gate: createReadGate(2),
      metrics: harness.metrics,
      logger: harness.logger,
    });

  const row = (messageId: string, fields: Partial<TieredRow> = {}): TieredRow => ({
    _id: messageId,
    messageId,
    conversationId: 'convo-a',
    createdAt: at(1),
    n: 3,
    tier: 'exact',
    stage: 0,
    ...fields,
  });

  beforeAll(async () => {
    harness = await createSearchHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  describe('wordSpan', () => {
    it('is the distance in words between the closest pair', () => {
      expect(span('grumtak vindra', 'grumtak vindra')).toBe(1);
      expect(span('grumtak one two vindra', 'grumtak vindra')).toBe(3);
      expect(span('grumtak one two three vindra then vindra grumtak', 'grumtak vindra')).toBe(1);
    });

    it('ignores the order of the words', () => {
      expect(span('vindra grumtak', 'grumtak vindra')).toBe(1);
    });

    it('covers every word of a longer query', () => {
      expect(span('grumtak a vindra b zarnok', 'grumtak vindra zarnok')).toBe(4);
      expect(span('grumtak vindra', 'grumtak vindra zarnok')).toBe(NO_SPAN);
    });

    it('is zero for a single word that the text holds', () => {
      expect(span('one grumtak two', 'grumtak')).toBe(0);
    });

    it('has no span when a word is missing, or the text is empty', () => {
      expect(span('grumtak alone', 'grumtak vindra')).toBe(NO_SPAN);
      expect(span('', 'grumtak vindra')).toBe(NO_SPAN);
    });

    it('counts an inflected form, a compound and a folded spelling in the text', () => {
      expect(span('blorgum vindra', 'blorg vindra')).toBe(1);
      expect(span('snidrum vindra', 'snidur vindra')).toBe(1);
      expect(span('blorgkvartana vindra', 'blorg vindra')).toBe(1);
      expect(span('Bláfum vindra', 'blafum vindra')).toBe(1);
    });

    it('counts a prefix expansion and a correction the plan holds', () => {
      expect(span('grumtak kerpilon', 'grumtak kerpil')).toBe(NO_SPAN);
      expect(span('grumtak kerpilon', 'grumtak kerpil', [{}, { prefix: ['kerpilon'] }])).toBe(1);
      expect(span('plomkit grumtak', 'plomkat grumtak', [{ typos: ['plomkit'] }])).toBe(1);
    });

    it('counts a stop word in the text as a position', () => {
      expect(span('grumtak the zog vindra', 'grumtak vindra')).toBe(3);
    });
  });

  describe('readProximity', () => {
    it('scores each row by its text, higher for closer, and last without text', async () => {
      await harness.seed({
        messages: [
          sourceMessage({ text: 'grumtak vindra', messageId: 'close' }),
          sourceMessage({ text: 'grumtak one two three vindra', messageId: 'far' }),
          sourceMessage({ text: 'grumtak vindra', messageId: 'theirs', user: 'user-b' }),
        ],
      });

      const proximity = await readProximity({
        user: 'user-a',
        rows: [row('close'), row('far'), row('gone'), row('theirs')],
        words: planned('grumtak vindra'),
        analyzer: harness.analyzer,
        run: runner(),
        methods: harness.methods,
      });

      expect([...proximity]).toEqual([
        ['close', -1],
        ['far', -4],
        ['gone', -NO_SPAN],
        ['theirs', -NO_SPAN],
      ]);
    });

    it('reads all rows in one read', async () => {
      const read = jest.spyOn(harness.methods, 'readMessageTexts');

      await readProximity({
        user: 'user-a',
        rows: [row('a'), row('b')],
        words: planned('grumtak vindra'),
        analyzer: harness.analyzer,
        run: runner(),
        methods: harness.methods,
      });

      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(
        { user: 'user-a', messageIds: ['a', 'b'] },
        expect.anything(),
      );
    });
  });

  describe('in rankHits', () => {
    const words = [{ df: 5 }, { df: 5 }];
    const ranked = (rows: TieredRow[], proximity: Map<string, number>) =>
      rankHits(rows, words, { lengthBucket: true, proximity }).map(({ _id }) => _id);

    it('puts closer words first among equal matches, before length and recency', () => {
      const rows = [
        row('far-new-short', { createdAt: at(9), n: 2 }),
        row('close-old-long', { createdAt: at(1), n: 60 }),
      ];
      const proximity = new Map([
        ['far-new-short', -7],
        ['close-old-long', -1],
      ]);

      expect(ranked(rows, proximity)).toEqual(['close-old-long', 'far-new-short']);
    });

    it('never lifts a row over one that matched more words', () => {
      const rows = [
        row('fewer-close', { stage: 1, createdAt: at(9) }),
        row('all-far', { stage: 0, createdAt: at(1) }),
      ];
      const proximity = new Map([
        ['fewer-close', -1],
        ['all-far', -9],
      ]);

      expect(ranked(rows, proximity)).toEqual(['all-far', 'fewer-close']);
    });

    it('sorts a row with no text last among equal matches', () => {
      const rows = [row('gone', { createdAt: at(9) }), row('far', { createdAt: at(1) })];
      const proximity = new Map([
        ['gone', -NO_SPAN],
        ['far', -40],
      ]);

      expect(ranked(rows, proximity)).toEqual(['far', 'gone']);
    });

    it('leaves a single word to length and recency', () => {
      const rows = [row('older', { createdAt: at(1) }), row('newer', { createdAt: at(9) })];
      const proximity = new Map([
        ['older', -1],
        ['newer', -9],
      ]);

      expect(
        rankHits(rows, [{ df: 5 }], { lengthBucket: true, proximity }).map(({ _id }) => _id),
      ).toEqual(['newer', 'older']);
    });
  });

  describe('on the first page of a multi-word search', () => {
    const page = async (query: string) => {
      const run = runner();
      const read = await readSearchPlan({
        user: 'user-a',
        words: analyzeQuery(harness.analyzer, query, { queryWordLimit: 10 }).words,
        need: SEARCH_PAGE_SIZE,
        window: 200,
        readConcurrency: 2,
        run,
        methods: harness.methods,
        ...BUDGETS,
      });
      const { hits } = await derivePage(
        read,
        { limit: SEARCH_PAGE_SIZE, rankWindow: 200, lengthBucket: true },
        { user: 'user-a', run, methods: harness.methods, analyzer: harness.analyzer },
      );
      return hits.map(({ messageId }) => messageId);
    };

    it('ranks closer words first, over a newer message', async () => {
      await harness.seed({
        messages: [
          sourceMessage({ text: 'grumtak vindra', messageId: 'close', createdAt: at(1) }),
          sourceMessage({
            text: 'grumtak one two three vindra',
            messageId: 'far',
            createdAt: at(9),
          }),
        ],
      });

      expect(await page('grumtak vindra')).toEqual(['close', 'far']);
    });

    it('counts an inflected form in the text', async () => {
      await harness.seed({
        messages: [
          sourceMessage({ text: 'blorgum snidrum', messageId: 'close', createdAt: at(1) }),
          sourceMessage({
            text: 'blorgum one two three snidrum',
            messageId: 'far',
            createdAt: at(9),
          }),
        ],
      });

      expect(await page('blorgum snidrum')).toEqual(['close', 'far']);
    });

    it('sorts a message whose text is gone last', async () => {
      await harness.seed({
        messages: [
          sourceMessage({
            text: 'grumtak one two three vindra',
            messageId: 'far',
            createdAt: at(1),
          }),
          sourceMessage({ text: 'grumtak vindra', messageId: 'gone', createdAt: at(9) }),
        ],
      });
      await harness.database.connection.db!.collection('messages').deleteOne({ messageId: 'gone' });

      expect(await page('grumtak vindra')).toEqual(['far', 'gone']);
    });
  });
});
