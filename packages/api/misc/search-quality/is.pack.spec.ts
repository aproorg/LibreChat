import { appendFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createIsPack, hashDeliveredData, IS_ATTRIBUTION } from '~/search/languages/is';
import { STUB_LISTS, writeStubData } from './stubData';
import type { StubData } from './stubData';

/** The pack's logic over invented words. Needs no private data. */
describe('is pack over a stub library', () => {
  let stub: StubData;
  let pack: ReturnType<typeof createIsPack>;

  beforeAll(async () => {
    stub = await writeStubData();
    pack = createIsPack({ languageDataDir: stub.dir, expectedSha512: stub.sha512 });
    await pack.load?.();
  });

  afterAll(async () => {
    await rm(stub.dir, { recursive: true });
  });

  describe('load', () => {
    it('imports through the file URL under this runner', () => {
      expect(pack.knows?.('blorg')).toBe(true);
    });

    it('fails on a wrong checksum, without a partial pack', async () => {
      const wrong = createIsPack({ languageDataDir: stub.dir, expectedSha512: 'a'.repeat(128) });

      await expect(wrong.load?.()).rejects.toMatchObject({ code: 'pack_data_checksum' });
      expect(wrong.stopWords.size).toBe(0);
      expect(() => wrong.lemmas('blorg')).toThrow(
        expect.objectContaining({ code: 'pack_not_loaded' }),
      );
    });

    it('checks the delivered bytes, not what the manifest says of them', async () => {
      const tampered = await writeStubData();
      await appendFile(join(tampered.dir, 'fold-table.bin'), 'x');
      const loaded = createIsPack({
        languageDataDir: tampered.dir,
        expectedSha512: tampered.sha512,
      });

      await expect(loaded.load?.()).rejects.toMatchObject({ code: 'pack_data_checksum' });
      await rm(tampered.dir, { recursive: true });
    });

    it('notices a file added to the delivery', async () => {
      const added = await writeStubData();
      await writeFile(join(added.dir, 'lemma-is/dist/extra.mjs'), 'export {};');
      const loaded = createIsPack({ languageDataDir: added.dir, expectedSha512: added.sha512 });

      await expect(loaded.load?.()).rejects.toMatchObject({ code: 'pack_data_checksum' });
      await rm(added.dir, { recursive: true });
    });

    it('refuses a link in the delivery', async () => {
      const linked = await writeStubData();
      await symlink(join(linked.dir, 'fold-table.bin'), join(linked.dir, 'linked.bin'));
      const loaded = createIsPack({ languageDataDir: linked.dir, expectedSha512: linked.sha512 });

      await expect(loaded.load?.()).rejects.toMatchObject({ code: 'pack_data_checksum' });
      await rm(linked.dir, { recursive: true });
    });

    it('fails on a list of the wrong shape, as a pack failure', async () => {
      const bad = await writeStubData({ ...STUB_LISTS, 'stop-lemma.json': { not: 'a list' } });
      const loaded = createIsPack({ languageDataDir: bad.dir, expectedSha512: bad.sha512 });

      await expect(loaded.load?.()).rejects.toMatchObject({ code: 'pack_load_failed' });
      await rm(bad.dir, { recursive: true });
    });

    it('fails on a missing library file, as a pack failure naming no path', async () => {
      const gone = await writeStubData();
      await rm(join(gone.dir, 'lemma-is/dist/index.mjs'));
      const sha512 = await hashDeliveredData(gone.dir);
      await writeFile(join(gone.dir, 'manifest.json'), JSON.stringify({ sha512 }));
      const loaded = createIsPack({ languageDataDir: gone.dir, expectedSha512: sha512 });

      const failure = await loaded.load?.().catch((error: Error) => error);
      expect(failure).toMatchObject({ code: 'pack_load_failed' });
      expect((failure as Error).message).not.toContain(gone.dir);
      await rm(gone.dir, { recursive: true });
    });

    it('is idempotent', async () => {
      const again = createIsPack({ languageDataDir: stub.dir, expectedSha512: stub.sha512 });

      await Promise.all([again.load?.(), again.load?.()]);
      await expect(again.load?.()).resolves.toBeUndefined();
    });
  });

  describe('knows and claims', () => {
    it('knows the core only', () => {
      expect(pack.knows?.('blorgum')).toBe(true);
      expect(pack.knows?.('tablerform')).toBe(false);
    });

    it('claims by the letter test', () => {
      for (const word of ['þ', 'ð', 'æ', 'ö', 'á', 'é', 'í', 'ó', 'ú', 'ý']) {
        expect(pack.claims?.(`x${word}`)).toBe(true);
      }
      expect(pack.claims?.('plain')).toBe(false);
    });
  });

  describe('lemmas', () => {
    it('answers a known word from the core, without the table', () => {
      expect(pack.lemmas('blorgum')).toEqual(['blorg']);
    });

    it('filters stop lemmas from the core', () => {
      expect(pack.lemmas('stoplemmaform')).toEqual(['keptlemma']);
    });

    it('answers an unknown word from the table, filtering stop lemmas', () => {
      expect(pack.lemmas('tablerform')).toEqual(['tablelemma']);
    });

    it('filters a table lemma by the folded stop lemma', () => {
      expect(pack.lemmas('thrun')).toEqual(['tablelemma']);
    });

    it('guesses only for a word with the letters, keeping stop lemmas and itself out', () => {
      expect(pack.lemmas('gloði')).toEqual(['glo']);
      expect(pack.lemmas('rans')).toEqual([]);
    });
  });

  describe('queryLemmas', () => {
    it('reads the table', () => {
      expect(pack.queryLemmas?.('tablemal')).toEqual(['tablelemma']);
      expect(pack.queryLemmas?.('nothing')).toEqual([]);
    });

    it('filters by the unfolded stop lemma, as the reference does', () => {
      expect(pack.queryLemmas?.('tablerform')).toEqual(['tablelemma']);
      expect(pack.queryLemmas?.('thrun')).toEqual(['throun', 'tablelemma']);
    });
  });

  describe('parts', () => {
    it('answers noun parts, leaving out the word itself', () => {
      expect(pack.parts?.('blorgkvart')).toEqual(['blorg', 'kvart']);
    });

    it('guards prototype keys, which the library would throw on', () => {
      expect(pack.parts?.('constructor')).toEqual([]);
      expect(pack.parts?.('__proto__')).toEqual([]);
    });

    it('drops the function-verb block list', () => {
      expect(pack.parts?.('blorgblocked')).toEqual(['blorg']);
    });

    it('drops its own stop words, parts that are not nouns, and short parts', () => {
      expect(pack.parts?.('blorgzogzog')).toEqual(['blorg']);
      expect(pack.parts?.('blorgvbonly')).toEqual(['blorg']);
      expect(pack.parts?.('blorgabab')).toEqual(['blorg']);
    });

    it('does not split a short word', () => {
      expect(pack.parts?.('blorgab')).toEqual([]);
    });
  });

  describe('stopWords and attribution', () => {
    it('joins the library list and the additions, as NFC', () => {
      expect([...pack.stopWords].sort()).toEqual(['zog', 'ðox', 'extrastop', 'éxtra'].sort());
    });

    it('carries the attribution', () => {
      expect(pack.attribution).toEqual(IS_ATTRIBUTION);
    });
  });
});
