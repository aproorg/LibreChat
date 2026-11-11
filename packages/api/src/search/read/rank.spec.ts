import type { TieredRow } from './rank';
import { lengthBucket, rankHits, TIER_WEIGHT } from './rank';

const row = (messageId: string, fields: Partial<TieredRow> = {}): TieredRow => ({
  _id: messageId,
  messageId,
  conversationId: 'c',
  createdAt: new Date('2026-01-01'),
  n: 1,
  tier: 'exact',
  ...fields,
});
const ids = (rows: TieredRow[]) => rows.map(({ messageId }) => messageId);
const word = { exact: 'w', lemmas: [], parts: [], df: 10, partDf: 0 };

describe('rankHits', () => {
  it('orders tiers by their weight', () => {
    expect(TIER_WEIGHT.exact).toBeGreaterThan(TIER_WEIGHT.lemma);
    expect(TIER_WEIGHT.lemma).toBeGreaterThan(TIER_WEIGHT.part);

    const ranked = rankHits(
      [row('part', { tier: 'part' }), row('lemma', { tier: 'lemma' }), row('exact')],
      [word],
      { lengthBucket: true },
    );
    expect(ids(ranked)).toEqual(['exact', 'lemma', 'part']);
  });

  it('puts tier ahead of length and date', () => {
    const ranked = rankHits(
      [
        row('short-new-lemma', { tier: 'lemma', n: 1, createdAt: new Date('2026-09-01') }),
        row('long-old-exact', { n: 3000, createdAt: new Date('2020-01-01') }),
      ],
      [word],
      { lengthBucket: true },
    );
    expect(ids(ranked)).toEqual(['long-old-exact', 'short-new-lemma']);
  });

  it('puts the shorter bucket ahead of the newer message', () => {
    const ranked = rankHits(
      [
        row('long-new', { n: 500, createdAt: new Date('2026-09-01') }),
        row('short-old', { n: 2, createdAt: new Date('2026-01-01') }),
      ],
      [word],
      { lengthBucket: true },
    );
    expect(ids(ranked)).toEqual(['short-old', 'long-new']);
  });

  it('leaves recency to decide inside a bucket', () => {
    const ranked = rankHits(
      [
        row('old', { n: 40, createdAt: new Date('2026-01-01') }),
        row('new', { n: 50, createdAt: new Date('2026-09-01') }),
      ],
      [word],
      { lengthBucket: true },
    );
    expect(lengthBucket(40)).toBe(lengthBucket(50));
    expect(ids(ranked)).toEqual(['new', 'old']);
  });

  it('with rank.lengthBucket false, goes straight to newest', () => {
    const ranked = rankHits(
      [
        row('short-old', { n: 2, createdAt: new Date('2026-01-01') }),
        row('long-new', { n: 500, createdAt: new Date('2026-09-01') }),
      ],
      [word],
      { lengthBucket: false },
    );
    expect(ids(ranked)).toEqual(['long-new', 'short-old']);
  });

  it('caps the bucket, as the reference does', () => {
    expect(lengthBucket(0)).toBe(0);
    expect(lengthBucket(3)).toBe(1);
    expect(lengthBucket(15)).toBe(2);
    expect(lengthBucket(3000)).toBe(4);
    expect(lengthBucket(1_000_000)).toBe(4);
  });

  it('does not reorder its input', () => {
    const input = [row('a', { tier: 'part' }), row('b')];
    rankHits(input, [word], { lengthBucket: true });
    expect(ids(input)).toEqual(['a', 'b']);
  });
});
