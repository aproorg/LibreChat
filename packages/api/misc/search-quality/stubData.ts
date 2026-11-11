import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildFoldTableBytes } from '~/search/languages/__tests__/helpers/foldTableBytes';
import { hashDeliveredData } from '~/search/languages/is';

/**
 * A language data directory of invented words behind a stub library, so the pack's
 * loading and filters are provable without naming anything from the private data.
 */
const LIBRARY = `
const CORE = new Map([
  ['blorgum', [{ lemma: 'blorg', pos: 'no' }]],
  ['blorg', [{ lemma: 'blorg', pos: 'no' }]],
  ['kvart', [{ lemma: 'kvart', pos: 'no' }]],
  ['grumpa', [{ lemma: 'grumpa', pos: 'so' }]],
  ['nouna', [{ lemma: 'nouna', pos: 'no' }]],
  ['vbonly', [{ lemma: 'vbonly', pos: 'so' }]],
  ['stoplemmaform', [{ lemma: 'stoplemma', pos: 'no' }, { lemma: 'keptlemma', pos: 'no' }]],
]);
const SPLITS = new Map([
  ['blorgkvart', ['blorg', 'kvart']],
  ['blorgblocked', ['blorg', 'blocked']],
  ['blorgvbonly', ['blorg', 'vbonly']],
  ['blorgzogzog', ['blorg', 'zog']],
  ['blorgab', ['blorg', 'ab']],
  ['blorgabab', ['blorg', 'ab']],
]);
export const STOPWORDS_IS = new Set(['zog', 'ðox']);
export class BinaryLemmatizer {
  static loadFromBuffer() { return new BinaryLemmatizer(); }
  isKnown(word) { return CORE.has(word); }
  lemmatize(word) {
    const known = CORE.get(word);
    if (known) return known.map(({ lemma }) => lemma);
    if (word.endsWith('ði')) return [word.slice(0, -2), 'stoplemma', word];
    return [word.replace(/s$/, '')];
  }
  lemmatizeWithPOS(word) { return CORE.get(word) ?? []; }
  getAllLemmas() { return ['blorg']; }
}
export class CompoundSplitter {
  split(word) {
    if (word === 'constructor') throw new Error('library reads a plain object');
    const parts = SPLITS.get(word);
    return parts ? { isCompound: true, parts: [...parts, word] } : { isCompound: false, parts: [word] };
  }
}
export const createKnownLemmaFilter = () => () => true;
`;

export const STUB_LISTS = {
  'stop-lemma.json': ['stoplemma', 'þróun'],
  'stop-extra.json': ['extrastop', 'éxtra'.normalize('NFD')],
  'function-verbs.json': ['blocked'],
};

export interface StubData {
  dir: string;
  sha512: string;
}

/** Lists can be replaced, to test a delivery of the wrong shape. */
export async function writeStubData(
  lists: Record<string, unknown> = STUB_LISTS,
): Promise<StubData> {
  const dir = await mkdtemp(join(tmpdir(), 'search-language-stub-'));
  const files: Record<string, string | Buffer> = {
    'lemma-is/dist/index.mjs': LIBRARY,
    'lemma-is/data-dist/lemma-is.core.bin': Buffer.from([1, 2, 3, 4]),
    'fold-table.bin': buildFoldTableBytes([
      ['tablerform', ['tablelemma', 'stoplemma']],
      ['thraun', ['thraun']],
      ['tablemal', ['tablelemma']],
      ['thrun', ['stoplemma', 'throun', 'tablelemma']],
    ]),
    ...Object.fromEntries(
      Object.entries(lists).map(([name, list]) => [`lists/${name}`, JSON.stringify(list)]),
    ),
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  const sha512 = await hashDeliveredData(dir);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ sha512 }));
  return { dir, sha512 };
}
