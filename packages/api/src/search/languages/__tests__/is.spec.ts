import { createIsPack, IS_DATA_SHA512, IS_PACK_ID } from '../is';

/**
 * The rest of this pack runs in `misc/search-quality`, because it needs Node's VM modules
 * flag: over a stub library in public CI (`is.pack.spec.ts`), and over the private data
 * outside it (`is.data.spec.ts`).
 */
describe('is pack, unloaded', () => {
  it('holds a checksum, and imports no library or data on creation', () => {
    const pack = createIsPack({ languageDataDir: '/nonexistent' });

    expect(IS_DATA_SHA512).toMatch(/^[0-9a-f]{128}$/);
    expect(pack.id).toBe(IS_PACK_ID);
    expect(pack.kind).toBe('dictionary');
    expect(pack.stopWords.size).toBe(0);
  });

  it('refuses to answer before it loads', () => {
    const pack = createIsPack({ languageDataDir: '/nonexistent' });

    expect(() => pack.lemmas('word')).toThrow(
      expect.objectContaining({ code: 'pack_not_loaded', packId: IS_PACK_ID }),
    );
  });

  it.each(['', '/nonexistent'])('fails as a pack failure with the directory %p', async (dir) => {
    const pack = createIsPack({ languageDataDir: dir });

    await expect(pack.load?.()).rejects.toMatchObject({
      name: 'SearchPackError',
      code: 'pack_data_missing',
    });
  });

  it('versions by its data, so new data is a token change', () => {
    const version = createIsPack({ languageDataDir: '' }).version;
    const other = createIsPack({ languageDataDir: '', expectedSha512: 'f'.repeat(128) }).version;

    expect(version).not.toBe(other);
  });
});
