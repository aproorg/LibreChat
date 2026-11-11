import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createIsPack, IS_DATA_SHA512 } from '~/search/languages/is';
import { fold } from '~/search/analyzer/fold';
import { requireQualityEnv } from './env';

const readList = async (dir: string, name: string): Promise<string[]> =>
  JSON.parse(await readFile(join(dir, 'lists', name), 'utf8'));

/** The real delivery. A missing directory fails, so this cannot pass unnoticed. */
describe('is pack over the private data', () => {
  const dir = requireQualityEnv('SEARCH_LANGUAGE_DATA_DIR');
  let pack: ReturnType<typeof createIsPack>;

  beforeAll(async () => {
    pack = createIsPack({ languageDataDir: dir });
    await pack.load?.();
  });

  it('matches the checksum in code, which is also in the manifest', async () => {
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));

    expect(manifest.sha512).toBe(IS_DATA_SHA512);
  });

  it('holds every addition in its stop list', async () => {
    for (const word of await readList(dir, 'stop-extra.json')) {
      expect(pack.stopWords.has(word.normalize('NFC'))).toBe(true);
    }
  });

  it('never answers a stop lemma for that lemma itself', async () => {
    for (const lemma of await readList(dir, 'stop-lemma.json')) {
      expect(pack.lemmas(lemma)).not.toContain(lemma);
      expect(pack.lemmas(lemma)).not.toContain(fold(lemma));
    }
  });

  it('never answers a blocked verb as a part', async () => {
    const blocked = await readList(dir, 'function-verbs.json');
    const split = blocked.filter((verb) => (pack.parts?.(`hús${verb}`) ?? []).length > 0);
    /* A word the library never splits would pass whatever the filter does. */
    expect(split.length).toBeGreaterThan(0);
    for (const verb of blocked) {
      expect(pack.parts?.(`hús${verb}`) ?? []).not.toContain(verb);
    }
  });

  it('fails on a wrong checksum with the real directory', async () => {
    const wrong = createIsPack({ languageDataDir: dir, expectedSha512: 'a'.repeat(128) });

    await expect(wrong.load?.()).rejects.toMatchObject({ code: 'pack_data_checksum' });
  });
});

/** The production path: the build keeps `import()`, and a CommonJS bundle reaches the ESM library. */
describe('the built package', () => {
  const dir = requireQualityEnv('SEARCH_LANGUAGE_DATA_DIR');
  const distPath = join(__dirname, '../../dist/index.cjs');
  const SCRIPT = `
    const { resolveSearchPacks, createAnalyzer, computeAnalyzerVersion } = require(process.argv[1]);
    (async () => {
      const resolved = resolveSearchPacks(['is', 'en'], { languageDataDir: process.argv[2] });
      if (!resolved.ok) throw new Error(resolved.error.code);
      await Promise.all(resolved.packs.map((pack) => pack.load()));
      const analyzer = createAnalyzer({ packs: resolved.packs, cacheWords: 10 });
      console.log(JSON.stringify({
        stop: analyzer.stopWords.size,
        running: analyzer.docTokens('running'),
        version: computeAnalyzerVersion(resolved.packs),
      }));
      process.exit(0);
    })().catch((error) => { console.error(error.code ?? error.message); process.exit(2); });
  `;

  it('imports the library from dist/index.cjs under this runner', async () => {
    const dist = jest.requireActual(distPath) as typeof import('~/search');
    const resolved = dist.resolveSearchPacks(['is', 'en'], { languageDataDir: dir });
    if (!resolved.ok) {
      throw new Error(resolved.error.code);
    }

    await Promise.all(resolved.packs.map((pack) => pack.load?.()));

    const analyzer = dist.createAnalyzer({ packs: resolved.packs, cacheWords: 10 });
    expect(analyzer.stopWords.size).toBeGreaterThan(0);
    expect(analyzer.docTokens('running')).toEqual(['running', 'run']);
  });

  it('imports the library from dist/index.cjs under plain Node', () => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, ['-e', SCRIPT, distPath, dir], {
      encoding: 'utf8',
      env,
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout.trim().split('\n').pop() as string);
    expect(output.running).toEqual(['running', 'run']);
    expect(output.stop).toBeGreaterThan(0);
  });

  it('reports a pack failure from dist/index.cjs with no directory', () => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, ['-e', SCRIPT, distPath, '/nonexistent'], {
      encoding: 'utf8',
      env,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('pack_data_missing');
  });
});
