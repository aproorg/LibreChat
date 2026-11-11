import { deflateRawSync } from 'node:zlib';
import { createCipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { SearchCursor } from './cursor';
import type { PlannedWord } from './plan';
import {
  createSearchCursorCodec,
  CURSOR_QUERY_CHARS,
  hashId,
  isSearchCursor,
  SEARCH_CURSOR_PREFIX,
} from './cursor';
import { PLAN_BUDGET_BYTES, planBytes } from './frozen';
import { WINDOW_OVERFLOW_FACTOR } from './page';
import { fitPrefix } from './plan';

const SECRET = 'cursor-spec-secret';
const USER = '0123456789abcdef01234567';
const QUERY = 'blorgum kvartana';
const RANK_WINDOW = 200;
const PAGE = 25;
/** nginx's default request line is 8 KB; the contract keeps the URL under this (R-06). */
const MAX_URL_BYTES = 7500;

const word = (exact: string, fields: Partial<PlannedWord> = {}): PlannedWord => ({
  exact,
  lemmas: [`${exact}lemma`],
  parts: [`~${exact}`, `~${exact}lemma`],
  df: 12,
  partDf: 3,
  ...fields,
});

const cursor = (fields: Partial<SearchCursor> = {}): SearchCursor => ({
  anchor: Date.UTC(2026, 5, 1),
  plan: { words: [word('blorgum'), word('kvartana', { prefix: ['kvartanaxyz'] })], common: [] },
  stage: 0,
  tier: 1,
  job: 0,
  mode: 'window',
  before: null,
  floor: Date.UTC(2026, 4, 1),
  tieDate: null,
  tieAfter: null,
  first: new Set(['a', 'b', 'c'].map(hashId)),
  seen: new Set(['d', 'e'].map(hashId)),
  carry: new Set(),
  carryFloor: null,
  sequential: false,
  ...fields,
});

/** Seals any payload as the codec does, so a test can hold a field the codec would never write. */
function seal(payload: unknown, user = USER, secret = SECRET): string {
  const key = Buffer.from(
    hkdfSync('sha256', secret, Buffer.alloc(0), 'librechat:search:cursor:v1', 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(user, 'utf8'));
  const sealed = Buffer.concat([
    cipher.update(deflateRawSync(JSON.stringify(payload))),
    cipher.final(),
  ]);
  return (
    SEARCH_CURSOR_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url')
  );
}

const queryHash = (query: string) =>
  createHash('sha256')
    .update(query.normalize('NFC').slice(0, CURSOR_QUERY_CHARS))
    .digest()
    .subarray(0, 8)
    .toString('base64url');

/** A well-formed payload, field for field what the codec writes. */
const payload = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  b: 'search',
  q: queryHash(QUERY),
  a: Date.UTC(2026, 5, 1),
  p: { w: [['blorgum', ['blorg'], 12, 3, 0, 0]], c: [] },
  s: 0,
  t: 0,
  j: 0,
  m: 0,
  u: null,
  f: null,
  d: null,
  i: null,
  x: '',
  n: '',
  k: '',
  l: null,
  o: 0,
  ...overrides,
});

describe('search cursor', () => {
  const codec = createSearchCursorCodec(SECRET);
  const scope = { user: USER, query: QUERY };
  const invalid = expect.objectContaining({ code: 'search_cursor_invalid' });

  it('round-trips every field', () => {
    const original = cursor({
      mode: 'tie',
      tieDate: Date.UTC(2026, 3, 1),
      tieAfter: 'ffffffffffffffffffffffff',
      before: Date.UTC(2026, 4, 15),
      carry: new Set(['x', 'y'].map(hashId)),
      carryFloor: Date.UTC(2026, 2, 1),
      sequential: true,
      plan: {
        words: [
          word('blorgum', { typos: ['blorgun'] }),
          word('kvartana', { prefix: ['kvartanas'] }),
        ],
        common: ['kvartanas'],
      },
    });

    expect(codec.decode(codec.encode(original, scope), scope)).toEqual(original);
  });

  it('carries the marker the Meilisearch branch refuses', () => {
    const encoded = codec.encode(cursor(), scope);

    expect(encoded.startsWith('s1.')).toBe(true);
    expect(isSearchCursor(encoded)).toBe(true);
    expect(isSearchCursor('2026-01-01T00:00:00.000Z')).toBe(false);
    expect(isSearchCursor(undefined)).toBe(false);
  });

  it('reveals no token to whoever holds it', () => {
    const encoded = codec.encode(cursor(), scope);
    const bytes = Buffer.from(encoded.slice(SEARCH_CURSOR_PREFIX.length), 'base64url');

    for (const token of ['blorgum', 'kvartana', 'kvartanaxyz', 'lemma']) {
      expect(encoded).not.toContain(token);
      expect(bytes.includes(token)).toBe(false);
      expect(bytes.includes(deflateRawSync(token).subarray(0, -1))).toBe(false);
    }
    /* Two cursors for one position differ, so nothing can be learned by comparing them. */
    expect(codec.encode(cursor(), scope)).not.toBe(encoded);
  });

  it('refuses a tampered cursor', () => {
    const encoded = codec.encode(cursor(), scope);
    const bytes = Buffer.from(encoded.slice(SEARCH_CURSOR_PREFIX.length), 'base64url');

    for (const at of [0, 13, 30, bytes.length - 1]) {
      const changed = Buffer.from(bytes);
      changed[at] ^= 1;
      expect(() =>
        codec.decode(SEARCH_CURSOR_PREFIX + changed.toString('base64url'), scope),
      ).toThrow(invalid);
    }
    expect(() => codec.decode(encoded.slice(0, -4), scope)).toThrow(invalid);
  });

  it("refuses another user's cursor, another query's, and another secret's", () => {
    const encoded = codec.encode(cursor(), scope);

    expect(() => codec.decode(encoded, { ...scope, user: 'fedcba9876543210fedcba98' })).toThrow(
      invalid,
    );
    expect(() => codec.decode(encoded, { ...scope, query: 'blorgum kvartur' })).toThrow(invalid);
    expect(() => createSearchCursorCodec('rotated').decode(encoded, scope)).toThrow(invalid);
  });

  it('refuses anything that is not a new-search cursor', () => {
    for (const value of [
      undefined,
      null,
      7,
      {},
      '',
      'abc',
      '2026-01-01T00:00:00.000Z',
      's1.',
      's1.!!',
    ]) {
      expect(() => codec.decode(value, scope)).toThrow(invalid);
    }
  });

  it('accepts a well-formed sealed payload, so the refusals below are about the field', () => {
    expect(codec.decode(seal(payload()), scope)).toMatchObject({ stage: 0, mode: 'fresh' });
  });

  it('refuses a cursor from another backend or another cursor version', () => {
    expect(() => codec.decode(seal(payload({ b: 'meilisearch' })), scope)).toThrow(invalid);
    expect(() => codec.decode(seal(payload({ v: 2 })), scope)).toThrow(invalid);
  });

  it.each([
    ['anchor', { a: '2026-01-01' }],
    ['anchor as an operator', { a: { $gt: 0 } }],
    ['plan', { p: 'plan' }],
    ['plan with no words', { p: { w: [], c: [] } }],
    ['plan word shape', { p: { w: [['blorgum', ['blorg'], 12, 3]], c: [] } }],
    ['plan token as an operator', { p: { w: [[{ $ne: '' }, [], 1, 0, 0, 0]], c: [] } }],
    ['plan lemmas', { p: { w: [['blorgum', [{ $ne: '' }], 1, 0, 0, 0]], c: [] } }],
    ['plan prefix', { p: { w: [['blorgum', [], 1, 0, [7], 0]], c: [] } }],
    ['plan counts', { p: { w: [['blorgum', [], -1, 0, 0, 0]], c: [] } }],
    ['plan common', { p: { w: [['blorgum', [], 1, 0, 0, 0]], c: [{ $ne: '' }] } }],
    ['stage past the plan', { s: 1 }],
    ['stage', { s: '0' }],
    ['tier past the last', { t: 5 }],
    ['tier', { t: -1 }],
    ['job', { j: 1.5 }],
    ['mode', { m: 3 }],
    ['before', { u: { $gt: 0 } }],
    ['floor', { f: 'yesterday' }],
    ['tie date', { d: [] }],
    ['tie position as an operator', { i: { $gt: '' } }],
    ['first', { x: ['aaaaaaa'] }],
    ['seen of a broken length', { n: 'AAAA' }],
    ['carry', { k: 5 }],
    ['carry floor', { l: 'never' }],
    ['query hash', { q: 5 }],
  ])('refuses a bad %s', (_name, fields) => {
    expect(() => codec.decode(seal(payload(fields)), scope)).toThrow(invalid);
  });

  it('refuses a sealed payload that is not an object, and one too large to be a cursor', () => {
    expect(() => codec.decode(seal(null), scope)).toThrow(invalid);
    expect(() => codec.decode(seal('text'), scope)).toThrow(invalid);
    expect(() => codec.decode(seal(payload({ x: 'A'.repeat(200_000) })), scope)).toThrow(invalid);
  });

  it('hashes the query as the client sends it on page 2: NFC, first 256 characters', () => {
    const composed = `${'þjóðarbókhlöðu '.repeat(40)}síðasta`;
    const pasted = composed.normalize('NFD');
    expect(pasted.length).toBeGreaterThan(composed.length);
    expect(composed.length).toBeGreaterThan(CURSOR_QUERY_CHARS);

    const encoded = codec.encode(cursor(), { user: USER, query: pasted });
    const sent = pasted.normalize('NFC').slice(0, CURSOR_QUERY_CHARS);

    expect(() => codec.decode(encoded, { user: USER, query: sent })).not.toThrow();
    expect(() =>
      codec.decode(encoded, { user: USER, query: sent.slice(0, CURSOR_QUERY_CHARS - 1) }),
    ).toThrow(invalid);
  });

  describe('size', () => {
    /** Incompressible, as real word-list tokens nearly are once deflated together. */
    const token = (seed: number, length = 24) =>
      createHash('sha256').update(String(seed)).digest('hex').slice(0, length);

    const worstPlan = () => {
      const words = Array.from({ length: 10 }, (_, index) =>
        word(token(index, 12), { lemmas: [token(100 + index, 12)], df: 400, partDf: 400 }),
      );
      const expansion = Array.from({ length: 204 }, (_, index) => token(1000 + index));
      const df = new Map(expansion.map((entry, index) => [entry, index < 4 ? 5000 - index : 200]));
      words[9].prefix = fitPrefix(words, 9, { tokens: expansion, df }, new Map());
      words[0].typos = Array.from({ length: 8 }, (_, index) => token(2000 + index, 48));
      return { words, common: expansion.slice(0, 4).reverse(), expansion };
    };

    it('stops prefix expansions at 1.5 KB of deflated plan, most frequent first', () => {
      const { words, expansion } = worstPlan();
      const kept = words[9].prefix ?? [];

      expect(kept.length).toBeGreaterThan(20);
      expect(kept.length).toBeLessThan(expansion.length);
      expect(kept).toEqual(expansion.slice(0, kept.length));
      const withoutTypos = words.map(({ typos: _typos, ...rest }) => rest);
      expect(
        planBytes({ words: withoutTypos, common: expansion.slice(0, 4).reverse() }),
      ).toBeLessThanOrEqual(PLAN_BUDGET_BYTES);
    });

    it('keeps every expansion when the plan fits', () => {
      const words = [word('blorgum')];
      const tokens = ['blorgums', 'blorgumz'];

      expect(fitPrefix(words, 0, { tokens, df: new Map() }, new Map())).toEqual(tokens);
    });

    it('keeps the worst-case URL within 7.5 KB, with the longest allowed query', () => {
      const { words, common } = worstPlan();
      const hashes = (count: number, seed: string) =>
        new Set(Array.from({ length: count }, (_, index) => hashId(`${seed}-${index}`)));
      /* A window holds fewer rows than its overflow bound, and one page adds to what it served. */
      const mostSeen = Math.floor(RANK_WINDOW * WINDOW_OVERFLOW_FACTOR) + PAGE;
      const largest = (fields: Partial<SearchCursor>) =>
        codec.encode(
          cursor({
            plan: { words, common },
            stage: 9,
            tier: 4,
            job: 204,
            before: Date.UTC(2026, 4, 15, 12, 30, 15, 123),
            floor: Date.UTC(2026, 4, 1, 1, 2, 3, 456),
            carryFloor: Date.UTC(2026, 3, 1, 1, 2, 3, 456),
            tieDate: Date.UTC(2026, 4, 1, 1, 2, 3, 456),
            tieAfter: 'f'.repeat(24),
            first: hashes(PAGE, 'first'),
            ...fields,
          }),
          scope,
        );
      /* Three bytes a character, the most a letter of the basic plane costs percent-encoded. */
      const query = '漢'.repeat(400).normalize('NFC').slice(0, CURSOR_QUERY_CHARS);
      const url = (encoded: string) =>
        `/api/messages?search=${encodeURIComponent(query)}&cursor=${encodeURIComponent(encoded)}`;

      const ranked = url(largest({ seen: hashes(mostSeen, 'seen') }));
      const sequential = url(
        largest({ carry: hashes(mostSeen, 'carry'), seen: new Set(), sequential: true }),
      );

      expect(Buffer.byteLength(ranked)).toBeLessThanOrEqual(MAX_URL_BYTES);
      expect(Buffer.byteLength(sequential)).toBeLessThanOrEqual(MAX_URL_BYTES);
    });
  });
});
