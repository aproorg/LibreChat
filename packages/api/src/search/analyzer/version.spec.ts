import { ANALYZER_CAPS, computeAnalyzerVersion } from './version';
import { FOLD_RULE_VERSION } from './fold';

const pack = (id: string, version: string, stop: string[]) => ({
  id,
  version,
  stopWords: new Set(stop),
});

describe('computeAnalyzerVersion', () => {
  const base = [pack('a', '1', ['x', 'y']), pack('b', '1', ['z'])];
  const baseVersion = computeAnalyzerVersion(base);

  it('is stable, whatever order packs and stop words arrive in', () => {
    expect(computeAnalyzerVersion(base)).toBe(baseVersion);
    expect(computeAnalyzerVersion([pack('b', '1', ['z']), pack('a', '1', ['y', 'x'])])).toBe(
      baseVersion,
    );
  });

  it('changes when a pack is enabled or removed', () => {
    expect(computeAnalyzerVersion([base[0]])).not.toBe(baseVersion);
    expect(computeAnalyzerVersion([...base, pack('c', '1', [])])).not.toBe(baseVersion);
  });

  it('changes with a pack version', () => {
    expect(computeAnalyzerVersion([pack('a', '2', ['x', 'y']), base[1]])).not.toBe(baseVersion);
  });

  it('changes with a stop list', () => {
    expect(computeAnalyzerVersion([pack('a', '1', ['x']), base[1]])).not.toBe(baseVersion);
  });

  it('keeps stop lists apart from one another', () => {
    const moved = [pack('a', '1', ['x', 'y', 'z']), pack('b', '1', [])];
    expect(computeAnalyzerVersion(moved)).not.toBe(baseVersion);
  });

  it('changes with the fold rule version', () => {
    expect(computeAnalyzerVersion(base, { foldRuleVersion: FOLD_RULE_VERSION + 1 })).not.toBe(
      baseVersion,
    );
  });

  it('changes with each cap', () => {
    const { wordLength, docTokens } = ANALYZER_CAPS;
    expect(
      computeAnalyzerVersion(base, { caps: { wordLength: wordLength + 1, docTokens } }),
    ).not.toBe(baseVersion);
    expect(
      computeAnalyzerVersion(base, { caps: { wordLength, docTokens: docTokens + 1 } }),
    ).not.toBe(baseVersion);
  });
});
