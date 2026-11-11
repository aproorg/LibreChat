import { fold, FOLD_RULE_VERSION } from './fold';

describe('fold', () => {
  it.each([
    ['Þjónustuver', 'thjonustuver'],
    ['ÐÆÖ', 'daeo'],
    ['ÁÉÍÓÚÝ', 'aeiouy'],
    ['øœßđł', 'ooessdl'],
    ['Crème Brûlée', 'creme brulee'],
    ['plain', 'plain'],
    ['2024', '2024'],
    ['', ''],
  ])('folds %s to %s', (input, expected) => {
    expect(fold(input)).toBe(expected);
  });

  it('treats decomposed and composed text the same', () => {
    expect(fold('Þjónusta'.normalize('NFD'))).toBe(fold('Þjónusta'));
  });

  it('is idempotent', () => {
    expect(fold(fold('Þjónustuverið æðri'))).toBe(fold('Þjónustuverið æðri'));
  });

  it('exports its rule version', () => {
    expect(FOLD_RULE_VERSION).toEqual(expect.any(Number));
  });
});
