import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gradeTexts, judgePage, reciprocalRank, scoreAt, stripCondition } from './scoring';

describe('scoring, as final/relevance.mjs defines it', () => {
  const query = { query: 'word', expected: ['a', 'b'] };

  it('passes only with every expected message in the top k', () => {
    expect(scoreAt(query, ['gold-a', 'x', 'gold-b'], 3)).toEqual({ found: 2, of: 2, pass: true });
    expect(scoreAt(query, ['gold-a', 'x', 'gold-b'], 2)).toEqual({ found: 1, of: 2, pass: false });
  });

  it('fails on an avoided message', () => {
    const avoiding = { ...query, avoid: ['c'] };

    expect(scoreAt(avoiding, ['gold-a', 'gold-b', 'gold-c'], 3).pass).toBe(false);
    expect(scoreAt(avoiding, ['gold-a', 'gold-b', 'gold-c'], 2).pass).toBe(true);
  });

  it('fails when a named first result is not first', () => {
    const topped = { ...query, top: 'b' };

    expect(scoreAt(topped, ['gold-a', 'gold-b'], 2).pass).toBe(false);
    expect(scoreAt(topped, ['gold-b', 'gold-a'], 2).pass).toBe(true);
  });

  it('passes a query expecting nothing when nothing avoided came back', () => {
    expect(scoreAt({ query: 'x', expected: [] }, [], 25)).toEqual({ found: 0, of: 0, pass: true });
  });

  it('ranks by the first expected message', () => {
    expect(reciprocalRank(query, ['x', 'y', 'gold-b'])).toBeCloseTo(1 / 3);
    expect(reciprocalRank(query, ['x'])).toBe(0);
    expect(reciprocalRank({ query: 'x', expected: [] }, ['x'])).toBeNull();
  });

  it('tallies a first page of grades, ignoring anything past it', () => {
    expect(judgePage([2, 1, 0])).toEqual({ rel: 2, strict: 1, of: 3 });
    expect(judgePage([])).toBeNull();
    expect(judgePage(new Array(30).fill(2))).toEqual({ rel: 25, strict: 25, of: 25 });
  });

  it('strips a condition prefix', () => {
    expect(stripCondition('P-gold-g01')).toBe('gold-g01');
    expect(stripCondition('gold-g01')).toBe('gold-g01');
  });
});

describe('gradeTexts', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'search-grader-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  const writeGrader = (body: string) => writeFile(join(dir, 'grade.mjs'), body);

  it('sends the query and texts to the grader process and reads its grades', async () => {
    await writeGrader(`
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      const { query, texts } = JSON.parse(input);
      console.log(JSON.stringify(texts.map((text) => (text.includes(query) ? 2 : 0))));
    `);

    await expect(gradeTexts(dir, 'word', ['a word', 'none'])).resolves.toEqual([2, 0]);
  });

  it('rejects when the grader fails', async () => {
    await writeGrader('process.exit(3);');

    await expect(gradeTexts(dir, 'word', ['text'])).rejects.toThrow('exited with 3');
  });

  it('rejects an answer of the wrong length', async () => {
    await writeGrader('console.log("[2, 2]");');

    await expect(gradeTexts(dir, 'word', ['text'])).rejects.toThrow('wrong number');
  });
});
