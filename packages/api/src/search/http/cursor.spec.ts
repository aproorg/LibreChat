import { SEARCH_CURSOR_HEADER } from 'librechat-data-provider';
import { readSearchCursor } from './cursor';

const req = (headers: Record<string, string>, query: { cursor?: unknown } = {}) => ({
  get: (name: string) => headers[name.toLowerCase()],
  query,
});
const header = SEARCH_CURSOR_HEADER.toLowerCase();

describe('readSearchCursor', () => {
  it('reads the header', () => {
    expect(readSearchCursor(req({ [header]: 's1.header' }))).toBe('s1.header');
  });

  it('prefers the header over the query parameter', () => {
    expect(readSearchCursor(req({ [header]: 's1.header' }, { cursor: 's1.query' }))).toBe(
      's1.header',
    );
  });

  it('falls back to the query parameter an older client sends', () => {
    expect(readSearchCursor(req({}, { cursor: 's1.query' }))).toBe('s1.query');
    expect(readSearchCursor(req({ [header]: '' }, { cursor: 's1.query' }))).toBe('s1.query');
  });

  it('is null with neither', () => {
    expect(readSearchCursor(req({}))).toBeNull();
  });
});
