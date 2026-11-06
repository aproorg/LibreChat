import { SEARCH_ERROR_CODES } from 'librechat-data-provider';
import { SearchError, isSearchError } from './searchError';

describe('SearchError', () => {
  it.each(SEARCH_ERROR_CODES)('carries the stable code %s and no other text', (code) => {
    const error = new SearchError(code);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SearchError');
    expect(error.code).toBe(code);
    expect(error.message).toBe(code);
    expect(isSearchError(error)).toBe(true);
  });

  it('is recognized across bundle copies, by name and a known code', () => {
    const copy = Object.assign(new Error('search_busy'), {
      name: 'SearchError',
      code: 'search_busy',
    });
    expect(isSearchError(copy)).toBe(true);
  });

  it.each([
    ['a plain error', new Error('search_busy')],
    ['an error with only a code', Object.assign(new Error('x'), { code: 'search_busy' })],
    [
      'a named error with an unknown code',
      Object.assign(new Error('x'), { name: 'SearchError', code: 'other' }),
    ],
    ['a plain object', { name: 'SearchError', code: 'search_busy' }],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'search_busy'],
  ])('rejects %s', (_label, value) => {
    expect(isSearchError(value)).toBe(false);
  });
});
