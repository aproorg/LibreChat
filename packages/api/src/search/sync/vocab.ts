import type { SearchMethods } from '@librechat/data-schemas';
import { JOB_STATE_READ, VOCAB_KEY } from '../jobs/control';
import { safeFailure } from '../failure';

export type VocabCounterMethods = Pick<SearchMethods, 'readSearchState' | 'incrementSearchVocab'>;

/**
 * Distinct tokens held before a flush is due, whatever the timer says. An import of unique
 * words would otherwise grow the map without limit, on a process that also serves chat. The
 * word list rebuild bounds its own map at the same size.
 */
export const MAX_PENDING_TOKENS = 50_000;
/** Tokens per write, so a full map is not one bulk operation. */
const WRITE_CHUNK = 10_000;

/** The word list's counts from the sync writer, held in memory between flushes (R-10). */
export interface VocabCounter {
  /** Counts one new or changed record's tokens. Writes nothing. */
  add(tokens: readonly string[]): void;
  /** Writes what is held, if this process still holds the lease. Never rejects. */
  flush(): Promise<void>;
  /**
   * Flushes once the held tokens have reached their bound. The writer awaits it between
   * records, so new tokens cannot arrive faster than they are written. Never rejects.
   */
  settle(): Promise<void>;
  /** Flushes every `vocabFlushSeconds`. Its timer never keeps the process alive. */
  start(): void;
  /** Stops the timer and flushes once more. */
  stop(): Promise<void>;
  /** Distinct tokens waiting for the next flush. */
  pending(): number;
}

/**
 * `df` only increases here, because the writer reads no old tokens. It only orders expansions
 * and rarity, and reconcile's rebuild corrects it. During a rebuild every flushed row is
 * stamped with its run, so a word that first appears mid-walk survives the copy pass.
 */
export function createVocabCounter({
  methods,
  flushSeconds,
  holds,
  logger,
}: {
  methods: VocabCounterMethods;
  flushSeconds: number;
  /** Only the active writer writes the word list. */
  holds(): boolean;
  logger: { warn(message: string, meta: object): unknown };
}): VocabCounter {
  let counts = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;
  let flushing: Promise<void> | null = null;

  async function write(): Promise<void> {
    if (counts.size === 0) {
      return;
    }
    const held = counts;
    counts = new Map();
    if (!holds()) {
      /* A writer that lost its turn may have lost its records too: the next rebuild counts them. */
      return;
    }
    const entries = [...held];
    let written = 0;
    try {
      const rebuild = await methods.readSearchState(VOCAB_KEY, JOB_STATE_READ);
      const run =
        rebuild?.status === 'running' && typeof rebuild.run === 'number' ? rebuild.run : null;
      for (; written < entries.length; written += WRITE_CHUNK) {
        await methods.incrementSearchVocab({
          counts: entries.slice(written, written + WRITE_CHUNK),
          run,
        });
      }
    } catch (error) {
      /* Only what was not written goes back, or a retry would count it twice. */
      for (const [token, count] of entries.slice(written)) {
        counts.set(token, (counts.get(token) ?? 0) + count);
      }
      logger.warn('[search] Word list flush failed', safeFailure(error));
    }
  }

  function flush(): Promise<void> {
    if (!flushing) {
      flushing = write().finally(() => {
        flushing = null;
      });
    }
    return flushing;
  }

  return {
    add(tokens) {
      for (const token of new Set(tokens)) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    },
    flush,
    async settle() {
      if (counts.size >= MAX_PENDING_TOKENS) {
        /* The flush in flight holds an older map, so this one's turn comes after it. */
        await flushing;
        await flush();
      }
    },
    start() {
      if (timer) {
        return;
      }
      timer = setInterval(() => void flush(), flushSeconds * 1000);
      timer.unref();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await flushing;
      await flush();
    },
    pending: () => counts.size,
  };
}
