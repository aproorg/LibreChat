import { analyzeQuery } from '~/search/analyzer/query';
import type { Analyzer } from '~/search/analyzer/analyze';
import { requireQualityEnv } from './env';
import { loadQualityAnalyzer } from './analyzer';

/**
 * The spec's accepted gaps for queries typed without Icelandic letters, pinned so a
 * change in either direction is noticed. They are gaps, not bugs: a stop word is judged
 * on the unfolded word (FR-005), which is what keeps `fór` and `ís` searchable.
 */
describe('accepted gaps for queries typed without Icelandic letters', () => {
  let analyzer: Analyzer;
  const analyze = (query: string) => analyzeQuery(analyzer, query, { queryWordLimit: 10 });

  beforeAll(async () => {
    analyzer = await loadQualityAnalyzer(requireQualityEnv('SEARCH_LANGUAGE_DATA_DIR'));
  }, 180_000);

  it('gives `for` the stop-word hint, though `fór` was meant', () => {
    expect(analyze('for').status).toBe('only_stop_words');
    expect(analyze('fór').status).toBe('ok');
  });

  it('does not recognize `hvad` as a stop word, so the query keeps a word that can cost results', () => {
    const typed = analyze('hvad kostadi radgjafinn');
    const spelled = analyze('hvað kostaði ráðgjafinn');

    expect(spelled.dropped).toContain('hvað');
    expect(typed.dropped).toEqual([]);
    expect(typed.words.map(({ raw }) => raw)).toContain('hvad');
    expect(typed.words.length).toBe(spelled.words.length + 1);
  });
});
