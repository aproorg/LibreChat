import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { buildFoldTableBytes } from '../__tests__/helpers/foldTableBytes';
import { FoldTable } from './foldTable';

const ENTRIES: ReadonlyArray<readonly [string, string[]]> = [
  ['alpha', ['alph']],
  ['bravo', ['brav', 'bravura']],
  ['charlie', ['charl']],
  ['zulu', ['zul']],
  ['ünder', ['und']],
];

describe('FoldTable', () => {
  const table = FoldTable.fromBytes(buildFoldTableBytes(ENTRIES));

  it.each(ENTRIES)('finds %s, wherever it falls in the search', (form, lemmas) => {
    expect(table.lookup(form)).toEqual(lemmas);
  });

  it('counts its forms', () => {
    expect(table.size()).toBe(ENTRIES.length);
  });

  it.each(['', 'alph', 'alphaa', 'aaaa', 'zzzz', 'constructor', '__proto__'])(
    'answers nothing for the unknown form %p',
    (form) => {
      expect(table.lookup(form)).toEqual([]);
    },
  );

  it('answers nothing from an empty table', () => {
    expect(FoldTable.fromBytes(buildFoldTableBytes([])).lookup('alpha')).toEqual([]);
  });

  it('keeps its bytes off the heap, in a Buffer', () => {
    expect(Buffer.isBuffer(table.bytes())).toBe(true);
  });

  it('refuses bytes too short for the count they declare', () => {
    const bytes = buildFoldTableBytes(ENTRIES);

    expect(() => FoldTable.fromBytes(bytes.subarray(0, 8))).toThrow('fold table');
    expect(() => FoldTable.fromBytes(Buffer.alloc(2))).toThrow('fold table');
  });

  it('stops at a record that lacks its separators, instead of running on', () => {
    const corrupt = buildFoldTableBytes([['alpha', ['alph']]]);
    corrupt.fill(0x41, 8);

    expect(FoldTable.fromBytes(corrupt).lookup('alpha')).toEqual([]);
  });

  it('loads from a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'search-fold-'));
    const file = join(dir, 'table.bin');
    await writeFile(file, buildFoldTableBytes(ENTRIES));

    try {
      const loaded = await FoldTable.load(file);
      expect(loaded.lookup('bravo')).toEqual(['brav', 'bravura']);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
