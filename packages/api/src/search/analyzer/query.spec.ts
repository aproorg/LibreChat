import { createFakeDictionaryPack } from '../languages/__tests__/helpers/fakeDictionary';
import { analyzeQuery, queryWord } from './query';
import { createSearchMetrics } from '../metrics';
import { createEnPack } from '../languages/en';
import { createAnalyzer } from './analyze';

const build = async () => {
  const fake = createFakeDictionaryPack();
  const en = createEnPack();
  await Promise.all([fake.load?.(), en.load?.()]);
  return createAnalyzer({ packs: [fake, en], cacheWords: 100 });
};

describe('queryWord', () => {
  it('does not expand a word with the letters through its folded form', async () => {
    const analyzer = await build();

    expect(queryWord(analyzer, 'mál').lemmas).not.toContain('malur');
    expect(queryWord(analyzer, 'mál').exact).toBe('mal');
  });

  it('expands a word typed without the letters through its folded form', async () => {
    const analyzer = await build();

    expect(queryWord(analyzer, 'mal').lemmas).toContain('malur');
    expect(queryWord(analyzer, 'blafum').lemmas).toContain('blafur');
  });

  it('never splits the query word: parts are the marked surface and lemmas', async () => {
    const analyzer = await build();
    const word = queryWord(analyzer, 'blorgum');

    expect(word).toEqual({
      raw: 'blorgum',
      exact: 'blorgum',
      lemmas: ['blorg'],
      parts: ['~blorgum', '~blorg'],
      stop: false,
    });
    expect(queryWord(analyzer, 'blorgkvartana').parts).not.toContain('~kvart');
  });

  it('leaves the surface out of the lemmas', async () => {
    const analyzer = await build();

    expect(queryWord(analyzer, 'blorg').lemmas).toEqual([]);
  });

  it('stems an unclaimed word, and normalizes its input', async () => {
    const analyzer = await build();

    expect(queryWord(analyzer, 'RUNNING')).toMatchObject({
      raw: 'running',
      exact: 'running',
      lemmas: ['run'],
    });
    expect(queryWord(analyzer, 'BLÁFUM'.normalize('NFD')).exact).toBe('blafum');
  });

  it('adds no lemma to an all-digit word from routing', async () => {
    const analyzer = await build();

    expect(queryWord(analyzer, '2024').lemmas).toEqual([]);
  });

  it('flags a stop word on its unfolded surface', async () => {
    const analyzer = await build();

    expect(queryWord(analyzer, 'for').stop).toBe(true);
    expect(queryWord(analyzer, 'fór').stop).toBe(false);
  });
});

describe('analyzeQuery', () => {
  it('treats marks alone as no word, so an emoji is not a search', async () => {
    const en = createEnPack();
    await en.load?.();
    const analyzer = createAnalyzer({ packs: [en], cacheWords: 10 });

    expect(analyzeQuery(analyzer, '\u2764\uFE0F', { queryWordLimit: 10 }).status).toBe('no_words');
    expect(
      analyzeQuery(analyzer, 'word \u2600\uFE0F', { queryWordLimit: 10 }).words.map(
        ({ exact }) => exact,
      ),
    ).toEqual(['word']);
    expect(analyzer.docTokens('\u2764\uFE0F')).toEqual([]);
  });

  const limit = { queryWordLimit: 10 };

  it('tells no usable words from only stop words', async () => {
    const analyzer = await build();

    expect(analyzeQuery(analyzer, ' ... ', limit)).toEqual({
      status: 'no_words',
      words: [],
      dropped: [],
    });
    expect(analyzeQuery(analyzer, 'the and', limit)).toEqual({
      status: 'only_stop_words',
      words: [],
      dropped: ['the', 'and'],
    });
  });

  it('removes stop words before the last word is chosen', async () => {
    const analyzer = await build();
    const result = analyzeQuery(analyzer, 'blorgum running the', limit);

    expect(result.status).toBe('ok');
    expect(result.words.map(({ raw }) => raw)).toEqual(['blorgum', 'running']);
    expect(result.dropped).toEqual(['the']);
  });

  it('applies the word limit after stop-word removal, keeping the first words', async () => {
    const analyzer = await build();
    const query = 'the aaax and bbbx or cccx dddx eeex';
    const result = analyzeQuery(analyzer, query, { queryWordLimit: 3 });

    expect(result.words.map(({ raw }) => raw)).toEqual(['aaax', 'bbbx', 'cccx']);
  });

  it('analyzes only the words it will use, however long the query', async () => {
    const analyzer = await build();
    const lemmas = jest.spyOn(analyzer.packs[0], 'lemmas');
    const query = Array.from({ length: 500 }, (_, index) => `word${index}x`).join(' ');

    const result = analyzeQuery(analyzer, `the ${query}`, { queryWordLimit: 3 });

    expect(result.words.map(({ raw }) => raw)).toEqual(['word0x', 'word1x', 'word2x']);
    expect(result.dropped).toEqual(['the']);
    /* Three words go through the packs, not five hundred. */
    expect(new Set(lemmas.mock.calls.map(([word]) => word)).size).toBeLessThanOrEqual(3);
    lemmas.mockRestore();
  });

  it('ignores a word over 48 characters', async () => {
    const analyzer = await build();

    expect(analyzeQuery(analyzer, 'x'.repeat(49), limit).status).toBe('no_words');
  });

  it('counts queries typed without the letters and queries of only stop words', async () => {
    const analyzer = await build();
    const metrics = createSearchMetrics({ info: jest.fn(), warn: jest.fn() });
    const noLetter = jest.spyOn(metrics.realtext, 'addNoLetterQuery');
    const stopOnly = jest.spyOn(metrics.realtext, 'addStopOnlyQuery');
    const options = { ...limit, realtext: metrics.realtext };

    analyzeQuery(analyzer, 'running blorg', options);
    expect(noLetter).toHaveBeenCalledTimes(1);

    analyzeQuery(analyzer, 'running mál', options);
    expect(noLetter).toHaveBeenCalledTimes(1);

    analyzeQuery(analyzer, 'the and', options);
    expect(stopOnly).toHaveBeenCalledTimes(1);
    expect(noLetter).toHaveBeenCalledTimes(1);
  });
});
