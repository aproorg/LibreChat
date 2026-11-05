/* eslint-disable jest/no-export -- a shared suite each pack's own spec file runs */
import type { LanguagePack } from '../../pack';
import { computeAnalyzerVersion } from '../../../analyzer/version';

export interface PackContractOptions {
  name: string;
  /** A fresh, unloaded pack. */
  create: () => LanguagePack;
  /** A pack whose load fails, so a failure is seen to surface as a pack error. */
  createBroken: () => LanguagePack;
  /** Time allowed for a load, in milliseconds. */
  loadTimeoutMs?: number;
}

const HOSTILE = [
  'constructor',
  '__proto__',
  'prototype',
  'hasOwnProperty',
  'tostring',
  'valueof',
  '',
  '0',
  '1234567890',
  'þjónusta'.normalize('NFD'),
  'x́',
  'a'.repeat(48),
  'þ'.repeat(48),
];

/** The suite every language pack runs. See `contracts/language-pack.md`. */
export function describePackContract(options: PackContractOptions): void {
  const { name, create, createBroken, loadTimeoutMs = 15000 } = options;

  describe(`language pack contract: ${name}`, () => {
    let pack: LanguagePack;

    beforeAll(async () => {
      pack = create();
      await pack.load?.();
    }, loadTimeoutMs);

    it.each(HOSTILE)('never throws for %p', (word) => {
      expect(() => pack.lemmas(word)).not.toThrow();
      expect(() => pack.parts?.(word)).not.toThrow();
      expect(() => pack.queryLemmas?.(word)).not.toThrow();
      expect(() => pack.knows?.(word)).not.toThrow();
      expect(() => pack.claims?.(word)).not.toThrow();
    });

    it.each(HOSTILE)('answers strings with no part marker for %p', (word) => {
      const outputs = [
        ...pack.lemmas(word),
        ...(pack.parts?.(word) ?? []),
        ...(pack.queryLemmas?.(word) ?? []),
      ];
      for (const output of outputs) {
        expect(typeof output).toBe('string');
        expect(output).not.toContain('~');
      }
    });

    it('keeps its own stop words out of parts', () => {
      for (const word of pack.stopWords) {
        expect(pack.parts?.(word) ?? []).not.toContain(word);
        expect(pack.parts?.(`${word}${word}${word}`) ?? []).not.toContain(word);
      }
    });

    it('holds stop words as NFC, lowercase and unfolded', () => {
      expect(pack.stopWords.size).toBeGreaterThan(0);
      for (const word of pack.stopWords) {
        expect(word).toBe(word.normalize('NFC'));
        expect(word).toBe(word.toLowerCase());
      }
      const claimed = [...pack.stopWords].filter((word) => pack.claims?.(word));
      expect(pack.claims == null || claimed.length > 0).toBe(true);
    });

    it('has a version, and changing it changes the analyzer version', () => {
      expect(pack.version.length).toBeGreaterThan(0);
      const { id, version, stopWords } = pack;
      expect(computeAnalyzerVersion([{ id, version: `${version}.next`, stopWords }])).not.toBe(
        computeAnalyzerVersion([{ id, version, stopWords }]),
      );
    });

    it(
      'loads idempotently',
      async () => {
        const fresh = create();
        await Promise.all([fresh.load?.(), fresh.load?.()]);
        const before = [...fresh.stopWords].sort();
        await fresh.load?.();
        expect([...fresh.stopWords].sort()).toEqual(before);
      },
      loadTimeoutMs,
    );

    it(
      'surfaces a failed load as a pack error, not a partial pack',
      async () => {
        const broken = createBroken();
        await expect(broken.load?.()).rejects.toMatchObject({
          name: 'SearchPackError',
          code: expect.stringMatching(/^pack_/),
          packId: broken.id,
        });
        expect(() => broken.lemmas('word')).toThrow(
          expect.objectContaining({ name: 'SearchPackError', code: 'pack_not_loaded' }),
        );
      },
      loadTimeoutMs,
    );
  });
}
