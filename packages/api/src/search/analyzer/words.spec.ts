import { MAX_WORD_LENGTH, words } from './words';

describe('words', () => {
  it('lowercases and splits on everything but letters, digits and marks', () => {
    expect(words('Hello, WORLD! v2.0 node_modules .NET')).toEqual([
      'hello',
      'world',
      'v2',
      '0',
      'node',
      'modules',
      'net',
    ]);
  });

  it('normalizes to NFC first, so decomposed text does not split at a mark', () => {
    expect(words('Þjónusta'.normalize('NFD'))).toEqual(['þjónusta']);
  });

  it('keeps a combining mark NFC leaves over', () => {
    expect(words('x́y')).toEqual(['x́y']);
  });

  it('keeps a word of exactly 48 characters and drops one over it', () => {
    expect(MAX_WORD_LENGTH).toBe(48);
    const exact = 'a'.repeat(48);
    expect(words(`${exact} ${'b'.repeat(49)} ok`)).toEqual([exact, 'ok']);
  });

  it('returns nothing for text without words', () => {
    expect(words('  ... !?')).toEqual([]);
    expect(words('')).toEqual([]);
  });
});
