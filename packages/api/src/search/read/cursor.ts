import { SearchError } from '@librechat/data-schemas';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { SEARCH_CURSOR_QUERY_CHARS } from 'librechat-data-provider';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { EncodedPlan, FrozenPlan, PlannedWord } from './frozen';
import { encodePlan, PLAN_SLOT_BYTES } from './frozen';
import { PART_MARKER } from '../analyzer/analyze';
import { READ_TIERS } from './tiers';

/** Marks a new-search cursor, so the Meilisearch branch can refuse one after a rollback. */
export const SEARCH_CURSOR_PREFIX = 's1.';
/** The client sends this much of the query with a cursor, and both sides hash the same (R-06). */
export const CURSOR_QUERY_CHARS = SEARCH_CURSOR_QUERY_CHARS;

const CURSOR_VERSION = 1;
const CURSOR_BACKEND = 'search';
const KEY_LABEL = 'librechat:search:cursor:v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ID_HASH_BYTES = 5;
const QUERY_HASH_BYTES = 8;
/** Bounds what a forged-but-authentic cursor could make a decode allocate. */
const MAX_INFLATED_BYTES = 64 * 1024;
const MAX_PLAN_WORDS = 64;
const PLAN_LENGTH_BYTES = 2;

export type CursorMode = 'fresh' | 'window' | 'tie';

/** Where load-more stands. Scope is never here: the user comes from the session. */
export interface SearchCursor {
  /** Upper date. Nothing newer enters the pagination. */
  anchor: number;
  plan: FrozenPlan;
  /** Position in word sets, tiers and jobs. */
  stage: number;
  tier: number;
  job: number;
  mode: CursorMode;
  /** The current window's dates: rows below `before`, above `floor`. */
  before: number | null;
  floor: number | null;
  /** Position inside a same-date run. */
  tieDate: number | null;
  tieAfter: string | null;
  /** Page 1's rows, kept for the whole pagination. */
  first: Set<string>;
  /** Rows served from the current window. */
  seen: Set<string>;
  /** Rows served before a window overflowed, skipped until the walk passes `carryFloor`. */
  carry: Set<string>;
  carryFloor: number | null;
  /** After an overflow the job is read newest first, which needs no `seen`. */
  sequential: boolean;
}

/** A row's ID as the cursor remembers it. A collision's only effect is one row not shown. */
export const hashId = (id: string): string =>
  createHash('sha256').update(id).digest().subarray(0, ID_HASH_BYTES).toString('base64url');

const queryHash = (query: string): string =>
  createHash('sha256')
    .update(query.normalize('NFC').slice(0, CURSOR_QUERY_CHARS))
    .digest()
    .subarray(0, QUERY_HASH_BYTES)
    .toString('base64url');

const packHashes = (hashes: ReadonlySet<string>): string =>
  Buffer.concat([...hashes].map((hash) => Buffer.from(hash, 'base64url'))).toString('base64url');

function unpackHashes(value: unknown): Set<string> {
  if (typeof value !== 'string') {
    throw new SearchError('search_cursor_invalid');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length % ID_HASH_BYTES !== 0) {
    throw new SearchError('search_cursor_invalid');
  }
  const hashes = new Set<string>();
  for (let start = 0; start < bytes.length; start += ID_HASH_BYTES) {
    hashes.add(bytes.subarray(start, start + ID_HASH_BYTES).toString('base64url'));
  }
  return hashes;
}

const invalid = (): never => {
  throw new SearchError('search_cursor_invalid');
};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isDate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const asString = (value: unknown): string => (typeof value === 'string' ? value : invalid());

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as string[])
    : invalid();

const asOptionalStrings = (value: unknown): string[] | undefined =>
  value === 0 ? undefined : asStrings(value);

function asOptionalDate(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  return isDate(value) ? value : invalid();
}

function decodePlan(value: unknown): FrozenPlan {
  const { w, c } = (value ?? {}) as Partial<EncodedPlan>;
  if (!Array.isArray(w) || w.length === 0 || w.length > MAX_PLAN_WORDS) {
    return invalid();
  }
  const words = w.map((entry): PlannedWord => {
    if (!Array.isArray(entry) || entry.length !== 6) {
      return invalid();
    }
    const exact = asString(entry[0]);
    const lemmas = asStrings(entry[1]);
    const prefix = asOptionalStrings(entry[4]);
    const typos = asOptionalStrings(entry[5]);
    return {
      exact,
      lemmas,
      parts: [exact, ...lemmas].map((token) => PART_MARKER + token),
      df: isCount(entry[2]) ? entry[2] : invalid(),
      partDf: isCount(entry[3]) ? entry[3] : invalid(),
      ...(prefix ? { prefix } : {}),
      ...(typos ? { typos } : {}),
    };
  });
  return { words, common: asStrings(c) };
}

const MODES: readonly CursorMode[] = ['fresh', 'window', 'tie'];

export interface SearchCursorCodec {
  /** `null` when the plan is too large to carry, in which case there is no load-more. */
  encode(cursor: SearchCursor, scope: { user: string; query: string }): string | null;
  /** Throws `search_cursor_invalid` for anything but this user's cursor for this query. */
  decode(value: unknown, scope: { user: string; query: string }): SearchCursor;
}

/**
 * Load-more's cursor: `s1.` plus deflated JSON under AES-256-GCM. The plan sits in a slot
 * of fixed size, so the cursor's length says nothing about what the word list held. It is encrypted because
 * the frozen plan holds expansions from the tenant-wide word list, which may contain
 * other users' names (FR-029). The user ID is bound as associated data, so another
 * user's cursor fails, and every decoded field is checked before it reaches a filter.
 */
export function createSearchCursorCodec(secret: string): SearchCursorCodec {
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), KEY_LABEL, 32));

  return {
    encode(cursor, { user, query }) {
      const payload = {
        v: CURSOR_VERSION,
        b: CURSOR_BACKEND,
        q: queryHash(query),
        a: cursor.anchor,
        s: cursor.stage,
        t: cursor.tier,
        j: cursor.job,
        m: MODES.indexOf(cursor.mode),
        u: cursor.before,
        f: cursor.floor,
        d: cursor.tieDate,
        i: cursor.tieAfter,
        x: packHashes(cursor.first),
        n: packHashes(cursor.seen),
        k: packHashes(cursor.carry),
        l: cursor.carryFloor,
        o: cursor.sequential ? 1 : 0,
      };
      const plan = deflateRawSync(JSON.stringify(encodePlan(cursor.plan)));
      if (plan.length > PLAN_SLOT_BYTES) {
        return null;
      }
      const slot = Buffer.alloc(PLAN_LENGTH_BYTES + PLAN_SLOT_BYTES);
      slot.writeUInt16BE(plan.length, 0);
      plan.copy(slot, PLAN_LENGTH_BYTES);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(user, 'utf8'));
      const sealed = Buffer.concat([
        cipher.update(slot),
        cipher.update(deflateRawSync(JSON.stringify(payload))),
        cipher.final(),
      ]);
      return (
        SEARCH_CURSOR_PREFIX +
        Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url')
      );
    },

    decode(value, { user, query }) {
      if (typeof value !== 'string' || !value.startsWith(SEARCH_CURSOR_PREFIX)) {
        return invalid();
      }
      let payload: Record<string, unknown>;
      let sealedPlan: unknown;
      try {
        const bytes = Buffer.from(value.slice(SEARCH_CURSOR_PREFIX.length), 'base64url');
        if (bytes.length <= IV_BYTES + TAG_BYTES) {
          return invalid();
        }
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES), {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(Buffer.from(user, 'utf8'));
        decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        const opened = Buffer.concat([
          decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
          decipher.final(),
        ]);
        const planLength = opened.readUInt16BE(0);
        const slotEnd = PLAN_LENGTH_BYTES + PLAN_SLOT_BYTES;
        if (planLength > PLAN_SLOT_BYTES || opened.length <= slotEnd) {
          return invalid();
        }
        const inflate = (bytes: Buffer): unknown =>
          JSON.parse(
            inflateRawSync(bytes, { maxOutputLength: MAX_INFLATED_BYTES }).toString('utf8'),
          );
        sealedPlan = inflate(opened.subarray(PLAN_LENGTH_BYTES, PLAN_LENGTH_BYTES + planLength));
        payload = inflate(opened.subarray(slotEnd)) as Record<string, unknown>;
      } catch {
        return invalid();
      }
      if (payload === null || typeof payload !== 'object') {
        return invalid();
      }
      if (payload.v !== CURSOR_VERSION || payload.b !== CURSOR_BACKEND) {
        return invalid();
      }
      if (payload.q !== queryHash(query)) {
        return invalid();
      }
      const plan = decodePlan(sealedPlan);
      const { s: stage, t: tier, j: job, m: mode } = payload;
      if (!isCount(stage) || stage >= plan.words.length) {
        return invalid();
      }
      if (!isCount(tier) || tier >= READ_TIERS.length || !isCount(job)) {
        return invalid();
      }
      if (!isCount(mode) || mode >= MODES.length) {
        return invalid();
      }
      return {
        anchor: isDate(payload.a) ? payload.a : invalid(),
        plan,
        stage,
        tier,
        job,
        mode: MODES[mode],
        before: asOptionalDate(payload.u),
        floor: asOptionalDate(payload.f),
        tieDate: asOptionalDate(payload.d),
        tieAfter: payload.i === null ? null : asString(payload.i),
        first: unpackHashes(payload.x),
        seen: unpackHashes(payload.n),
        carry: unpackHashes(payload.k),
        carryFloor: asOptionalDate(payload.l),
        sequential: payload.o === 1,
      };
    },
  };
}

/** A new-search cursor reaching the Meilisearch branch came from before a rollback. */
export const isSearchCursor = (cursor: unknown): boolean =>
  typeof cursor === 'string' && cursor.startsWith(SEARCH_CURSOR_PREFIX);
