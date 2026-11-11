import type { MessageSearchRecord } from '@librechat/data-schemas';
import type { SearchHarness } from '../__tests__/helpers/harness';
import type { SearchSource } from '../sync/extract';
import type { SearchCursor } from './cursor';
import type { PlanRead } from './plan';
import { firstCursor, MAX_WALK_READS, walkPage, WINDOW_OVERFLOW_FACTOR } from './page';
import { createSearchHarness, sourceMessage } from '../__tests__/helpers/harness';
import { computeAnalyzerVersion } from '../analyzer/version';
import { createReadGate, createReadRunner } from './retry';
import { buildMessageRecord } from '../sync/record';
import { fitPrefix, readSearchPlan } from './plan';
import { createSearchCursorCodec } from './cursor';
import { analyzeQuery } from '../analyzer/query';
import { endOfPrefix, RARE_DF } from './tiers';
import { derivePage } from './window';

const PAGE = 5;
const WINDOW = 10;
const ANCHOR = new Date('2026-06-01T00:00:00Z').getTime();
const BUDGETS = {
  prefix: { maxCommonReads: 4, maxRareTokens: 200, maxVocabRows: 50_000 },
  typo: { maxCorrections: 8, maxVocabRows: 50_000 },
};

const minute = (index: number) => new Date(Date.UTC(2026, 0, 1, 0, index));

describe('load-more paging (R-06, R-07)', () => {
  let harness: SearchHarness;
  const codec = createSearchCursorCodec('page-spec-secret');

  const runner = () =>
    createReadRunner({
      surface: 'messages',
      signal: new AbortController().signal,
      deadline: Date.now() + 30_000,
      gate: createReadGate(2),
      metrics: harness.metrics,
      logger: harness.logger,
    });

  const records = () =>
    harness.database.connection
      .db!.collection<MessageSearchRecord>('msearch')
      .find({ user: 'user-a' })
      .toArray();

  /** Writes records as sync would, leaving the word list as it was seeded. */
  const addRecords = async (sources: SearchSource[]) => {
    const built = sources.map((source) =>
      buildMessageRecord(source, {
        analyzer: harness.analyzer,
        version: computeAnalyzerVersion(harness.packs),
      }),
    );
    await harness.models.MessageSearch.insertMany(built.filter(Boolean));
  };

  const setDf = (token: string, df: number) =>
    harness.models.SearchVocab.updateOne({ _id: token }, { $set: { df } }, { upsert: true });

  /** Page 1 as the service derives it, and the cursor it would hand out. */
  const firstPage = async (query: string) => {
    const run = runner();
    const words = analyzeQuery(harness.analyzer, query, { queryWordLimit: 10 }).words;
    const read = await readSearchPlan({
      user: 'user-a',
      words,
      need: PAGE,
      window: WINDOW,
      readConcurrency: 2,
      run,
      methods: harness.methods,
      ...BUDGETS,
      now: () => ANCHOR,
    });
    const { hits, more } = await derivePage(
      read,
      { limit: PAGE, rankWindow: WINDOW, lengthBucket: true },
      { user: 'user-a', run, methods: harness.methods, analyzer: harness.analyzer },
    );
    return { read, ids: hits.map(({ _id }) => _id), cursor: more ? firstCursor(read, hits) : null };
  };

  /** Through the codec each time, as a request would carry it. */
  const nextPage = async (cursor: SearchCursor, query: string) => {
    const scope = { user: 'user-a', query };
    const walked = await walkPage({
      user: 'user-a',
      cursor: codec.decode(codec.encode(cursor, scope), scope),
      pageSize: PAGE,
      rankWindow: WINDOW,
      lengthBucket: true,
      prefix: BUDGETS.prefix,
      run: runner(),
      methods: harness.methods,
    });
    expect(walked.rows.length).toBeLessThanOrEqual(PAGE);
    expect(walked.reads).toBeLessThanOrEqual(MAX_WALK_READS + 1);
    return walked;
  };

  /** Every page to the end. `between` runs after each page, with its number, from 1. */
  const paginate = async (query: string, between?: (page: number) => Promise<void>) => {
    const first = await firstPage(query);
    const ids = [...first.ids];
    const cursors: SearchCursor[] = [];
    let cursor = first.cursor;
    await between?.(1);
    for (let page = 2; cursor !== null; page += 1) {
      expect(page).toBeLessThan(500);
      const walked = await nextPage(cursor, query);
      ids.push(...walked.rows.map(({ _id }) => _id));
      cursor = walked.cursor;
      if (cursor) {
        cursors.push(cursor);
      }
      await between?.(page);
    }
    return { ids, read: first.read, cursors };
  };

  /**
   * What load-more owes, computed without the plan's reads: every record at or below
   * the anchor holding the first word at any tier. Later word sets only narrow the
   * earlier pages, so the union over stages is the first word's matches (R-07). The
   * last word's prefix expansions come from the word list under the same budgets.
   */
  const oracle = async (query: string, read: PlanRead) => {
    const words = analyzeQuery(harness.analyzer, query, { queryWordLimit: 10 }).words;
    const { exact, lemmas, parts } = words[0];
    const tokens = new Set([exact, ...lemmas, ...parts, ...(read.plan.words[0].typos ?? [])]);
    if (words.length === 1) {
      const vocab = await harness.models.SearchVocab.find({
        _id: { $gte: exact, $lt: endOfPrefix(exact) },
      }).lean<Array<{ _id: string; df: number }>>();
      const others = vocab.filter(({ _id }) => _id !== exact).sort((a, b) => b.df - a.df);
      const expansion = [
        ...others.filter(({ df }) => df > RARE_DF).slice(0, BUDGETS.prefix.maxCommonReads),
        ...others.filter(({ df }) => df <= RARE_DF).slice(0, BUDGETS.prefix.maxRareTokens),
      ];
      const planned = [{ exact, lemmas, parts, df: 0, partDf: 0 }];
      const budgeted = fitPrefix(
        planned,
        0,
        {
          tokens: expansion.map(({ _id }) => _id),
          df: new Map(expansion.map(({ _id, df }) => [_id, df])),
        },
        new Map(),
      );
      for (const token of budgeted) {
        tokens.add(token);
      }
    }
    return (await records())
      .filter((record) => record.createdAt.getTime() <= ANCHOR)
      .filter((record) => record.tokens.some((token) => tokens.has(token)))
      .map(({ _id }) => String(_id));
  };

  const expectComplete = (ids: string[], expected: string[]) => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(expected.filter((id) => !ids.includes(id))).toEqual([]);
  };

  const many = (count: number, text: string, from = 0, fields: Record<string, unknown> = {}) =>
    Array.from({ length: count }, (_, index) =>
      sourceMessage({ text, createdAt: minute(from + index), ...fields }),
    );

  beforeAll(async () => {
    harness = await createSearchHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  it('reaches every match of one word across tiers and windows, once each', async () => {
    await harness.seed({
      messages: [
        ...many(37, 'blorgum inflected'),
        ...many(13, 'blorg the lemma', 100),
        ...many(8, 'blorgkvartana compound', 200),
        ...many(4, 'unrelated words', 300),
        ...many(3, 'blorgum for another user', 400, { user: 'user-b' }),
      ],
    });

    const { ids, read, cursors } = await paginate('blorgum');

    const expected = await oracle('blorgum', read);
    expect(expected).toHaveLength(58);
    expectComplete(ids, expected);
    expect(ids).toHaveLength(58);
    expect(cursors.some(({ mode, seen }) => mode === 'window' && seen.size > 0)).toBe(true);
    expect(new Set(cursors.map(({ tier }) => tier)).size).toBeGreaterThan(2);
  });

  it('reaches every match of several words: all words, then each dropped-word set', async () => {
    await harness.seed({
      messages: [
        ...many(14, 'blorg horses together'),
        ...many(17, 'blorg alone', 100),
        ...many(6, 'horses alone', 200),
      ],
    });

    const { ids, read } = await paginate('blorg horses');

    const expected = await oracle('blorg horses', read);
    expect(expected).toHaveLength(31);
    expectComplete(ids, expected);
    expect(ids).toHaveLength(31);
    /* Fuller matches come first: no all-words row follows a row holding only the first. */
    const all = new Set(
      (await records())
        .filter(({ tokens }) => tokens.includes('hors'))
        .map(({ _id }) => String(_id)),
    );
    const lastFull = Math.max(...ids.map((id, index) => (all.has(id) ? index : -1)));
    expect(lastFull).toBe(13);
  });

  it('walks a same-date run that starts inside one window and outlasts the next', async () => {
    const sameDate = minute(50);
    await harness.seed({
      messages: [
        ...many(7, 'blorgum newer', 60),
        ...Array.from({ length: 34 }, () =>
          sourceMessage({ text: 'blorgum same date', createdAt: sameDate }),
        ),
        ...many(9, 'blorgum older', 0),
      ],
    });

    const { ids, read, cursors } = await paginate('blorgum');

    const expected = await oracle('blorgum', read);
    expect(expected).toHaveLength(50);
    expectComplete(ids, expected);
    expect(ids).toHaveLength(50);
    expect(
      cursors.filter(({ mode, tieAfter }) => mode === 'tie' && tieAfter).length,
    ).toBeGreaterThan(2);
  });

  it('lets nothing newer than the anchor in, and neither repeats nor loses a row for a write below it', async () => {
    await harness.seed({ messages: many(42, 'blorgum original') });
    const original = (await records()).map(({ _id }) => String(_id));
    const above = sourceMessage({ text: 'blorgum above', createdAt: new Date(ANCHOR + 60_000) });
    const below = sourceMessage({ text: 'blorgum below', createdAt: minute(3) });

    const { ids } = await paginate('blorgum', async (page) => {
      if (page === 2) {
        await addRecords([above, below]);
      }
    });

    expectComplete(ids, original);
    expect(ids).not.toContain(above._id);
    expect(ids.filter((id) => id === below._id).length).toBeLessThanOrEqual(1);
  });

  it('keeps every row when late records land in the window being served', async () => {
    await harness.seed({ messages: many(40, 'blorgum original') });
    const original = (await records()).map(({ _id }) => String(_id));
    /* Few enough that the window, with them, stays under its overflow bound. */
    const late = Array.from({ length: 2 }, (_, index) =>
      sourceMessage({
        text: 'blorgum late',
        createdAt: new Date(minute(22 + index).getTime() + 1),
      }),
    );

    const { ids, cursors } = await paginate('blorgum', async (page) => {
      if (page === 3) {
        await addRecords(late);
      }
    });
    const midWindow = cursors[1];

    /* Page 3 left its window part served, and the late dates fall inside it. */
    expect(midWindow).toMatchObject({ mode: 'window', floor: minute(20).getTime() });
    expect(midWindow.seen.size).toBe(PAGE);
    expectComplete(ids, original);
    expect(cursors.some(({ sequential }) => sequential)).toBe(false);
    expect(ids.filter((id) => late.some(({ _id }) => _id === id))).toHaveLength(late.length);
  });

  it('goes on newest first, with nothing repeated or lost, when more late rows land than a window holds', async () => {
    await harness.seed({ messages: many(40, 'blorgum original') });
    const original = (await records()).map(({ _id }) => String(_id));
    const flood = Array.from({ length: WINDOW * WINDOW_OVERFLOW_FACTOR + 8 }, (_, index) =>
      sourceMessage({
        text: 'blorgum flood',
        createdAt: new Date(minute(22).getTime() + 1 + index),
      }),
    );

    const { ids, cursors } = await paginate('blorgum', async (page) => {
      if (page === 3) {
        await addRecords(flood);
      }
    });

    expect(cursors[1]).toMatchObject({ mode: 'window', sequential: false });
    expect(cursors.some(({ sequential, carry }) => sequential && carry.size === PAGE)).toBe(true);
    expectComplete(ids, original);
  });

  it('never shows a message deleted or edited away between pages, and still reaches the rest', async () => {
    await harness.seed({ messages: many(36, 'blorgum original') });
    const all = await records();
    const deleted = String(all[4]._id);
    const edited = String(all[9]._id);

    let servedBeforeChange: string[] = [];
    const first = await firstPage('blorgum');
    servedBeforeChange = [...first.ids];
    await harness.models.MessageSearch.deleteOne({ _id: deleted });
    await harness.models.MessageSearch.updateOne(
      { _id: edited },
      { $set: { tokens: ['unrelated'], h: 'edited' } },
    );
    const ids = [...first.ids];
    for (let cursor = first.cursor; cursor !== null; ) {
      const walked = await nextPage(cursor, 'blorgum');
      ids.push(...walked.rows.map(({ _id }) => _id));
      cursor = walked.cursor;
    }

    const gone = [deleted, edited].filter((id) => !servedBeforeChange.includes(id));
    expect(ids.filter((id) => gone.includes(id))).toEqual([]);
    expectComplete(
      ids,
      all.map(({ _id }) => String(_id)).filter((id) => id !== deleted && id !== edited),
    );
  });

  it('keeps the frozen plan when a word list flush would move the driver', async () => {
    await harness.seed({
      messages: [
        ...many(12, 'blorg horses together'),
        ...many(15, 'blorg alone', 100),
        ...many(20, 'horses alone', 200),
      ],
    });

    const { ids, read } = await paginate('blorg horses', async (page) => {
      if (page === 1) {
        /* `blorg` drove page 1. Now it would be the commoner word, and common enough to split. */
        await setDf('blorg', RARE_DF * 10);
        await setDf('hors', 1);
      }
    });

    const expected = await oracle('blorg horses', read);
    expect(expected).toHaveLength(27);
    expectComplete(ids, expected);
    expect(ids).toHaveLength(27);
  });

  it('serves an exact match that appears after a page of corrections', async () => {
    await harness.seed({ messages: many(18, 'blorgum corrected to') });
    const first = await firstPage('blorgun');
    expect(first.read.plan.words[0].typos).toEqual(['blorgum']);
    expect(first.ids).toHaveLength(PAGE);

    const exact = sourceMessage({ text: 'blorgun itself', createdAt: minute(5) });
    await addRecords([exact]);
    const ids = [...first.ids];
    for (let cursor = first.cursor; cursor !== null; ) {
      const walked = await nextPage(cursor, 'blorgun');
      ids.push(...walked.rows.map(({ _id }) => _id));
      cursor = walked.cursor;
    }

    expect(ids.filter((id) => id === exact._id)).toHaveLength(1);
    expectComplete(ids, await oracle('blorgun', first.read));
    expect(ids).toHaveLength(19);
  });

  it('reaches the prefix tier from a common word, and freezes its expansions', async () => {
    await harness.seed({
      messages: [
        ...many(23, 'snidur itself'),
        ...many(6, 'snidurfoo longer', 100),
        ...many(4, 'snidurbar longer still', 200),
      ],
    });
    await setDf('snidur', RARE_DF + 50);

    const first = await firstPage('snidur');
    expect(first.read.plan.words[0].prefix).toBeUndefined();
    const { ids, read } = await paginate('snidur');

    const expected = await oracle('snidur', read);
    expect(expected).toHaveLength(33);
    expectComplete(ids, expected);
    expect(ids).toHaveLength(33);
  });

  it('walks several common tokens as separate jobs without repeating a row that holds two', async () => {
    await harness.seed({
      messages: [
        ...many(16, 'kvartana'),
        ...many(9, 'kvartur plain', 100),
        ...many(7, 'kvart plain', 200),
      ],
    });
    for (const token of ['kvartana', 'kvartur', 'kvart']) {
      await setDf(token, RARE_DF + 20);
    }

    const { ids, read } = await paginate('kvartana');

    expect(read.plan.common).toEqual(expect.arrayContaining(['kvartur', 'kvart']));
    const expected = await oracle('kvartana', read);
    expect(expected).toHaveLength(32);
    expectComplete(ids, expected);
    expect(ids).toHaveLength(32);
  });

  it('pages through rows at the token cap', async () => {
    const long = (seed: number) =>
      `blorgum ${Array.from({ length: 3200 }, (_, index) => `w${seed}x${index}`).join(' ')}`;
    await harness.seed({
      messages: Array.from({ length: 8 }, (_, index) =>
        sourceMessage({ text: long(index), createdAt: minute(index) }),
      ),
    });
    expect((await records())[0].tokens).toHaveLength(3000);

    const { ids, read } = await paginate('blorgum');

    expectComplete(ids, await oracle('blorgum', read));
    expect(ids).toHaveLength(8);
  }, 120_000);

  it('ends with no cursor, and hands none out when page 1 holds everything', async () => {
    await harness.seed({ messages: many(3, 'blorgum few') });

    const first = await firstPage('blorgum');

    expect(first.ids).toHaveLength(3);
    expect(first.cursor).toBeNull();
  });
});
