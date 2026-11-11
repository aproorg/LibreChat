import { describePackContract } from './helpers/contract';
import { createEnPack, EN_PACK_ID } from '../en';

describePackContract({
  name: 'en',
  create: () => createEnPack(),
  createBroken: () =>
    createEnPack({
      importStemmer: () => Promise.reject(new Error('stemmer is missing')),
    }),
});

describe('en pack', () => {
  it('loads nothing until load is called', () => {
    const importStemmer = jest.fn(() => Promise.reject(new Error('unused')));
    const pack = createEnPack({ importStemmer });

    expect(pack.id).toBe(EN_PACK_ID);
    expect(pack.kind).toBe('stemmer');
    expect(pack.stopWords.has('the')).toBe(true);
    expect(importStemmer).not.toHaveBeenCalled();
  });

  it('imports the stemmer once, however often it loads', async () => {
    const stem = jest.fn((word: string) => word);
    const importStemmer = jest.fn(async () => ({ newStemmer: () => ({ stem }) }));
    const pack = createEnPack({ importStemmer });

    await Promise.all([pack.load?.(), pack.load?.()]);
    await pack.load?.();

    expect(importStemmer).toHaveBeenCalledTimes(1);
  });

  it('can load again after a failure', async () => {
    const importStemmer = jest
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValue({ newStemmer: () => ({ stem: (word: string) => word }) });
    const pack = createEnPack({ importStemmer });

    await expect(pack.load?.()).rejects.toMatchObject({ code: 'pack_load_failed' });
    await expect(pack.load?.()).resolves.toBeUndefined();
    expect(pack.lemmas('word')).toEqual(['word']);
  });

  it('never carries the cause of a failed load in its message', async () => {
    const pack = createEnPack({
      importStemmer: () => Promise.reject(new Error('sentinel-detail')),
    });

    await expect(pack.load?.()).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('sentinel-detail') }),
    );
  });

  it('stems with Snowball, so used, using and use meet', async () => {
    const pack = createEnPack();
    await pack.load?.();

    expect(pack.lemmas('used')).toEqual(pack.lemmas('using'));
    expect(pack.lemmas('used')).toEqual(pack.lemmas('use'));
    expect(pack.lemmas('dashboards')).toEqual(['dashboard']);
  });

  it('holds the English stop list as given by the reference', () => {
    const { stopWords } = createEnPack();

    expect(stopWords.size).toBe(106);
    for (const word of ['the', 'how', 'further', 'mine', 'whom']) {
      expect(stopWords.has(word)).toBe(true);
    }
  });
});
