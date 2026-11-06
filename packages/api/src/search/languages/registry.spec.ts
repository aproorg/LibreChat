import { isRegisteredSearchPack, resolveSearchPacks } from './registry';

describe('resolveSearchPacks', () => {
  it('builds each registered pack without loading anything', () => {
    const result = resolveSearchPacks(['is', 'en'], { languageDataDir: '' });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) {
      throw new Error('expected packs');
    }
    expect(result.packs.map(({ id }) => id)).toEqual(['is', 'en']);
    expect(result.packs.map(({ kind }) => kind)).toEqual(['dictionary', 'stemmer']);
  });

  it.each(['xx', 'constructor', '__proto__', ''])(
    'answers a pack failure for the unregistered id %p, rather than throwing',
    (id) => {
      expect(resolveSearchPacks(['en', id], { languageDataDir: '' })).toEqual({
        ok: false,
        error: { code: 'pack_unregistered', id },
      });
      expect(isRegisteredSearchPack(id)).toBe(false);
    },
  );
});
