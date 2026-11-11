import { resolve } from 'path';
import { load } from 'js-yaml';
import { readFileSync } from 'fs';
import { loadSearchConfig } from '@librechat/data-schemas';
import { searchConfigSchema } from 'librechat-data-provider';
import type { ConversationSearchConfig } from 'librechat-data-provider';
import { createSearchConfigSnapshot, isSearchServing, isSearchDataOn } from './config';

const configured = (search: Partial<ConversationSearchConfig>): ConversationSearchConfig => ({
  ...searchConfigSchema.parse({}),
  ...search,
});

describe('createSearchConfigSnapshot', () => {
  it('takes the search block from the base config', () => {
    const search = configured({ data: true, backend: 'search' });
    const snapshot = createSearchConfigSnapshot({ search });
    expect(snapshot.data).toBe(true);
    expect(snapshot.backend).toBe('search');
  });

  it('gives the defaults when the app config has no search block', () => {
    expect(createSearchConfigSnapshot({})).toEqual(loadSearchConfig({}));
  });

  it('is frozen at every level', () => {
    const snapshot = createSearchConfigSnapshot({ search: configured({}) });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.languages)).toBe(true);
    expect(Object.isFrozen(snapshot.jobs)).toBe(true);
    expect(Object.isFrozen(snapshot.typo)).toBe(true);
  });

  it('does not change when the source does, and leaves the source unfrozen', () => {
    const search = configured({ languages: ['en'] });
    const snapshot = createSearchConfigSnapshot({ search });

    search.backend = 'search';
    search.languages.push('xx');
    search.jobs.batchSize = 1;

    expect(snapshot.backend).toBe('meilisearch');
    expect(snapshot.languages).toEqual(['en']);
    expect(snapshot.jobs.batchSize).toBe(200);
    expect(Object.isFrozen(search)).toBe(false);
  });
});

describe('snapshot helpers', () => {
  const snapshot = (search: Partial<ConversationSearchConfig>) =>
    createSearchConfigSnapshot({ search: configured(search) });

  it('stays off by default', () => {
    const defaults = createSearchConfigSnapshot({});
    expect(isSearchDataOn(defaults)).toBe(false);
    expect(isSearchServing(defaults)).toBe(false);
  });

  it.each([
    [{ data: false, backend: 'meilisearch' }, false],
    [{ data: true, backend: 'meilisearch' }, false],
    [{ data: true, backend: 'search' }, true],
  ] as const)('%j serves %s', (search, serving) => {
    expect(isSearchServing(snapshot(search))).toBe(serving);
  });

  it('routes backend search with data off to the search service, whose reads then fail', () => {
    expect(isSearchServing(snapshot({ data: false, backend: 'search' }))).toBe(true);
  });
});

describe('librechat.example.yaml', () => {
  it('documents every field with its default', () => {
    const example = readFileSync(
      resolve(__dirname, '../../../../librechat.example.yaml'),
      'utf8',
    ).split('\n');
    const start = example.indexOf('# search:');
    expect(start).toBeGreaterThan(-1);
    const end = example.findIndex((line, index) => index > start && !line.startsWith('#'));
    const block = example
      .slice(start, end)
      .map((line) => line.replace(/^# ?/, ''))
      .join('\n');

    const { search } = load(block) as { search: unknown };

    expect(searchConfigSchema.strict().parse(search)).toEqual(searchConfigSchema.parse({}));
    expect(search).toEqual(searchConfigSchema.parse({}));
  });
});
