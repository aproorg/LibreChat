import { createFakeDictionaryPack } from '../languages/__tests__/helpers/fakeDictionary';
import { createAnalyzer, MAX_DOC_TOKENS } from './analyze';
import { createSearchMetrics } from '../metrics';
import { createEnPack } from '../languages/en';

const loaded = async () => {
  const fake = createFakeDictionaryPack();
  const en = createEnPack();
  await Promise.all([fake.load?.(), en.load?.()]);
  return { fake, en };
};

const silentLogger = { info: jest.fn(), warn: jest.fn() };

describe('analyzer', () => {
  describe('routing', () => {
    it('adds a known word its surface and lemmas, and no stem', async () => {
      const { fake, en } = await loaded();
      const analyzer = createAnalyzer({ packs: [fake, en], cacheWords: 100 });

      expect(analyzer.analyzeWord('blorgum')).toEqual(['blorgum', 'blorg']);
    });

    it('folds a lemma', async () => {
      const { fake, en } = await loaded();
      const analyzer = createAnalyzer({ packs: [fake, en], cacheWords: 100 });

      expect(analyzer.analyzeWord('bláfum')).toEqual(['blafum', 'blafur']);
    });

    it('adds a word no dictionary knows or claims its stem', async () => {
      const { fake, en } = await loaded();
      const analyzer = createAnalyzer({ packs: [fake, en], cacheWords: 100 });

      expect(analyzer.analyzeWord('running')).toEqual(['running', 'run']);
    });

    it('stems the folded surface', async () => {
      const { en } = await loaded();
      const lemmas = jest.spyOn(en, 'lemmas');
      const analyzer = createAnalyzer({ packs: [en], cacheWords: 100 });

      analyzer.analyzeWord('naïves');

      expect(lemmas).toHaveBeenCalledWith('naives');
    });

    it('keeps a claimed word from stemmers, with its fallback lemma', async () => {
      const { fake, en } = await loaded();
      const lemmas = jest.spyOn(en, 'lemmas');
      const analyzer = createAnalyzer({ packs: [fake, en], cacheWords: 100 });

      expect(analyzer.analyzeWord('gloði')).toEqual(['glodi', 'glo']);
      expect(lemmas).not.toHaveBeenCalled();
    });

    it('stems a word with those letters when no pack claims it', async () => {
      const { en } = await loaded();
      const analyzer = createAnalyzer({ packs: [en], cacheWords: 100 });

      expect(analyzer.analyzeWord('gloðing')).toEqual(['gloding', 'glode']);
    });

    it('stops at the surface for an all-digit word', async () => {
      const { fake, en } = await loaded();
      const lemmas = jest.spyOn(en, 'lemmas');
      const parts = jest.spyOn(fake, 'parts');
      const analyzer = createAnalyzer({ packs: [fake, en], cacheWords: 100 });

      expect(analyzer.analyzeWord('2024')).toEqual(['2024']);
      expect(lemmas).not.toHaveBeenCalled();
      expect(parts).not.toHaveBeenCalled();
    });

    it('marks compound parts and folds them', async () => {
      const { fake, en } = await loaded();
      const analyzer = createAnalyzer({ packs: [fake, en], cacheWords: 100 });

      const tokens = analyzer.analyzeWord('blorgkvartana');

      expect(tokens[0]).toBe('blorgkvartana');
      expect(tokens.slice(-2)).toEqual(['~blorg', '~kvart']);
    });

    it('drops a compound part in the combined stop list', async () => {
      const { fake, en } = await loaded();
      const analyzer = createAnalyzer({ packs: [fake, en], cacheWords: 100 });
      const tokens = analyzer.analyzeWord('blorgwith');

      expect(tokens).toContain('~blorg');
      expect(tokens).not.toContain('~with');
    });
  });

  describe('text the reference guards against', () => {
    it('does not throw for constructor and prototype keys', async () => {
      const { fake, en } = await loaded();
      const analyzer = createAnalyzer({ packs: [fake, en], cacheWords: 100 });

      expect(analyzer.docTokens('constructor __proto__ prototype')).toEqual(
        expect.arrayContaining(['constructor', 'proto', 'prototyp']),
      );
    });

    it('splits node_modules and .NET at their punctuation', async () => {
      const { fake, en } = await loaded();
      const analyzer = createAnalyzer({ packs: [fake, en], cacheWords: 100 });

      expect(analyzer.docTokens('node_modules .NET')).toEqual(
        expect.arrayContaining(['node', 'modules', 'modul', 'net']),
      );
    });

    it('gives decomposed text the tokens of composed text', async () => {
      const { fake, en } = await loaded();
      const analyzer = createAnalyzer({ packs: [fake, en], cacheWords: 100 });

      expect(analyzer.docTokens('bláfum'.normalize('NFD'))).toEqual(['blafum', 'blafur']);
    });

    it('drops stop words on the unfolded surface', async () => {
      const { fake, en } = await loaded();
      const analyzer = createAnalyzer({ packs: [fake, en], cacheWords: 100 });

      expect(analyzer.analyzeWord('for')).toEqual([]);
      expect(analyzer.analyzeWord('fór')).toEqual(['for']);
      expect(analyzer.analyzeWord('ðox')).toEqual([]);
      expect(analyzer.analyzeWord('dox')).toContain('dox');
    });

    it('handles a message mixing languages, word by word', async () => {
      const { fake, en } = await loaded();
      const analyzer = createAnalyzer({ packs: [fake, en], cacheWords: 100 });

      expect(analyzer.docTokens('The blorgum were running')).toEqual([
        'blorgum',
        'blorg',
        'running',
        'run',
      ]);
    });

    it('neither indexes nor counts a word over 48 characters', async () => {
      const { fake, en } = await loaded();
      const analyzer = createAnalyzer({ packs: [fake, en], cacheWords: 100 });

      expect(analyzer.docTokens(`${'x'.repeat(49)} blorg`)).toEqual(['blorg']);
    });
  });

  describe('the token cap', () => {
    const longText = Array.from({ length: MAX_DOC_TOKENS + 500 }, (_, i) => `w${i}x`).join(' ');

    it('stops a long message at the cap', async () => {
      const { fake, en } = await loaded();
      const analyzer = createAnalyzer({ packs: [fake, en], cacheWords: 100 });

      expect(MAX_DOC_TOKENS).toBe(3000);
      expect(analyzer.docTokens(longText)).toHaveLength(3000);
    });

    it('counts tokens per message and messages at the cap', async () => {
      const { fake, en } = await loaded();
      const metrics = createSearchMetrics(silentLogger);
      const addMessage = jest.spyOn(metrics.realtext, 'addMessage');
      const analyzer = createAnalyzer({
        packs: [fake, en],
        cacheWords: 100,
        realtext: metrics.realtext,
      });

      analyzer.analyzeMessage('blorgum');
      analyzer.analyzeMessage(longText);

      expect(addMessage).toHaveBeenNthCalledWith(1, 2, false);
      expect(addMessage).toHaveBeenNthCalledWith(2, 3000, true);
    });

    it('does not count a title as a message', async () => {
      const { fake, en } = await loaded();
      const metrics = createSearchMetrics(silentLogger);
      const addMessage = jest.spyOn(metrics.realtext, 'addMessage');
      const analyzer = createAnalyzer({
        packs: [fake, en],
        cacheWords: 100,
        realtext: metrics.realtext,
      });

      analyzer.docTokens('blorgum');

      expect(addMessage).not.toHaveBeenCalled();
    });
  });

  describe('the word cache', () => {
    it('stays within its bound and gives the same answer after eviction', async () => {
      const { fake, en } = await loaded();
      const lemmas = jest.spyOn(fake, 'lemmas');
      const analyzer = createAnalyzer({ packs: [fake, en], cacheWords: 2 });

      const first = analyzer.analyzeWord('blorgum');
      analyzer.analyzeWord('blorgum');
      expect(lemmas).toHaveBeenCalledTimes(1);

      analyzer.analyzeWord('blorg');
      analyzer.analyzeWord('kvartana');
      expect(analyzer.analyzeWord('blorgum')).toEqual(first);
      expect(lemmas).toHaveBeenCalledTimes(4);
      expect(analyzer.cacheSize()).toBe(2);
    });

    it('evicts the least recently used word', async () => {
      const { fake, en } = await loaded();
      const lemmas = jest.spyOn(fake, 'lemmas');
      const analyzer = createAnalyzer({ packs: [fake, en], cacheWords: 2 });

      analyzer.analyzeWord('blorgum');
      analyzer.analyzeWord('blorg');
      analyzer.analyzeWord('blorgum');
      analyzer.analyzeWord('kvartana');
      lemmas.mockClear();

      analyzer.analyzeWord('blorgum');
      expect(lemmas).not.toHaveBeenCalled();
    });
  });
});
